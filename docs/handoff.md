# チャット形式セッションへの dispatch（2026-11-20）

指揮側が Orca の作業者と往復するための中継側の直し。実機の Orca はこの環境に無い。下の「確認した」は公開リポジトリ `stablyai/orca` の CLI 仕様と型、`「未確認」`は実機がないと判断していないもの。

## 確認した

- `worktree create --agent` の `result.launch.outcome.kind` は `structured`（チャット）か `terminal`。`handle` と、structured のときは `sessionId` がある（`AgentLaunchOutcome`）。
- チャットのタブ id は `structured-agent-session-<sessionId>`（`structuredAgentSessionTabId`）。再現した handle はこの形。
- チャットへのメール宛先は `orca_session_id:<sessionId>`。ターミナルは handle。ターミナルの session id 宛ては拒否、と CLI skill "Messaging agents" にある。
- `--prompt` を付けた起動は、チャットでは最初のメッセージを journal する（`prompt.outcome === 'journaled'`）。中継の raw CLI は `worktree create --agent --prompt` を禁止したまま。spec はセッションが出来たあと `orchestration send --to orca_session_id:<id> --type dispatch` で渡す。skill は、チャットはそのメールを本文として受け取ると書いている。
- `orchestration dispatch --inject` はターミナルへ打ち込む。エージェントのプロセスが無いと拒否される（`buildInjectRejectionMessage`）。structured では `--inject` を付けず `--return-preamble` で bind する。
- `orchestration check --wait` は、合うメッセージが届くか `--timeout-ms` までブロックする（CLI spec の `--wait`）。await はこのコマンドの終了を待っているので、メッセージが届いた時点で戻る。窓の終わりまで中継側で追加の sleep はしない。
- `agentSession.subscribe` を叩く CLI は handler 一覧に無い。チャットイベントの push 購読は **未確認**。即時に使えると確認できたのは `check --wait`（長い待ちで、届いたら戻る）だけ。

## 中継の動き

1. place-agent は `kind: structured` の handle を作業者 handle として受け、`ok: true` で `dispatch_id` と `terminal_handle` を返す。既存の `kind: terminal` は `--inject` と TUI 復旧のまま。
2. spec（`worker_done` 契約を含む）は上記の send でチャットへ渡る。
3. await は `check --wait`。question → `orchestration reply`（toolset `dispatch`。admin の raw cli は増やしていない）→ worker_done。
4. 作成記録は place-agent の成否を返す前、bind より前に書く。失敗した dispatch の handle を reclaim できる。チャットの生存確認は `agent list`（worktreeId が記録の path と一致する chat）。ターミナルは従来の `terminal list`。
5. release は structured handle に `terminal close` しない。`worker-release`、それが retained または失敗なら `worker-stop`。チャットタブを閉じる専用 CLI は無い。supervised な chat worker を閉じるのは `worker-release` と worker 仕様にある。unsupervised な `orchestration dispatch` は retained でプロセスを触らない、ともある。`worker-stop` がタブ自体を閉じるかは **未確認**（実機での確認が必要）。閉じたと結果が言うときだけ worktree 削除に進む。

## 実機での確認が必要

- 本物の Orca が `orchestration dispatch --to orca_session_id:…`（`--inject` なし）を受け、作業者が `worker_done` を指揮側の check に載せること。
- 届いてから await が戻るまでの実時間。結合テストは偽物の CLI で、窓の終わりより前に戻ることを測る。
- `worker-release` / `worker-stop` がチャットタブを実際に閉じること。
