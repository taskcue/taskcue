# Adding an agent

An agent is one adapter in `server/agents/<agent>/` plus one line in `server/agents/index.ts`. The rest of TaskCue
(the board, the panel, approvals, history) works for it unchanged.

## 1. Capture the real thing first

Before writing the adapter, record a short real session: the agent's stdin and stdout, as JSON lines, while it writes a
file and runs a command with approvals on. `test/fixtures/claude-stream.jsonl` and `codex-app-server.jsonl` show the
format: one `{"dir": "in" | "out", "msg": …}` per line.

Scrub it before committing: your home folder becomes `/Users/dev`, and any account, email, organisation or
machine details go (they are never needed by an adapter). Keep the agent's own JSON formatting.

## 2. Write the adapter

Implement `AgentAdapter` from `server/agents/types.ts`:

- `detect()`: find the binary with `findBinary([process.env.TASKCUE_CANVAS_<AGENT>_BIN, '<name>', …])` and read its
  version with `versionOf`.
- `start(options, sink)`: spawn it with `childEnv()`, map `options.permission` (`ask`, `auto-edit`, `full`) onto the
  agent's own settings, and report through `sink`: `item` for each message or tool call, `draft` for streaming text,
  `approval` / `approvalGone` for what it asks, `working` for busy/idle, `exited` when it ends.
- `history(nativeId, cwd)` and `recent(limit)`: read the agent's own storage. Never write to it.

Translate the agent's events in one function used by both the live path and `history`, and give each item the agent's
own id, so the two paths agree.

Agents that speak the [Agent Client Protocol](https://agentclientprotocol.com) (Gemini CLI with `--acp`, OpenCode,
Goose and others) can share one ACP adapter; that adapter is the next item on the roadmap.

## 3. Register it

Add the id to `AgentId` in `shared/types.ts`, the adapter to `adapters` in `server/agents/index.ts`, and its name to
`AGENT_NAMES` in `src/bits.tsx` (plus a colour for `.agent-<id> .agent-dot` in `src/styles.css`).

## 4. Test it against the capture

`test/fake/replay.mjs` stands in for any agent's binary: it plays back a capture, writing what the agent wrote and
waiting where the client wrote. Point `TASKCUE_CANVAS_<AGENT>_BIN` at it and `REPLAY_FIXTURE` at your capture, then drive
your adapter the way `test/codex.test.ts` does. Also test that `history` gives the same item ids as the live path.

## Rules every adapter keeps

- Run the agent's own, unmodified program, and leave every sign-in method it offers available.
- Never read, store or forward the agent's credentials or session tokens. Sign-in happens in the agent's own flow.
- Never write into the agent's history files.
