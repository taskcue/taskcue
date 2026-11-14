# Architecture

Agentyard is a small Node server and a React page. The server runs the agents' own programs; the page draws the board.

```
server/
  index.ts            HTTP routes, the event stream (SSE), serving the page
  guard.ts            who may call the API (Host, Origin, Fetch-Metadata, JSON writes, token)
  config.ts           ~/.agentyard: settings, the session list, the token
  projects.ts         project folders: added by hand, plus wherever the agents worked
  sessions.ts         the board's sessions: live ones, stored ones, ones found in agents' history
  agents/
    types.ts          the adapter interface every agent implements
    process.ts        finding binaries, clean child environments, JSON lines
    index.ts          the list of adapters
    claude/           Claude Code: stream-json over stdio, transcripts under ~/.claude/projects
    codex/            Codex: JSON-RPC to `codex app-server`, threads read through it
shared/types.ts       everything the server and the page share
src/                  the page: Board (React Flow), Chat, NewSession, store
test/                 tests, against output captured from the real agents (test/fixtures)
```

## The adapter boundary

Nothing outside `server/agents/<agent>/` knows an agent's binary, protocol or files. An adapter implements
`AgentAdapter` (`server/agents/types.ts`):

| Method | What it does |
|---|---|
| `detect()` | Finds the binary, its version and its models. |
| `start(options, sink)` | Starts (or resumes, with `resumeId`) a session and reports through `sink`. |
| `history(nativeId, cwd)` | Reads a conversation from the agent's own storage. |
| `recent(limit)` | Lists the newest conversations in the agent's own storage. |

A live session (`LiveSession`) sends messages, interrupts a turn, answers approvals and stops. It reports through a
`SessionSink`: items, the streaming draft, its native id and model, busy or idle, approvals raised and withdrawn, and
its exit.

Everything an adapter reports is in Agentyard's own shapes (`shared/types.ts`): an `Item` is a user message, an
assistant message, thinking, a tool call (with its summary, output and status) or a notice.

## One conversation, two paths

A conversation reaches the page two ways: live from the running process, and from the agent's history when a session
is opened later. Both paths go through the same translator and give an item the same id (Claude Code's message uuid and
tool_use id; Codex's item id), so the page merges them without ever showing an item twice. The tests check this
against captured output.

## State

Agentyard keeps very little: `~/.agentyard/sessions.json` (which sessions are on the board, their folder, agent and
native id), `settings.json` (the folders you added) and `token`. Conversations stay in each agent's own history. Nothing
runs after the server stops; every session can be continued, because both agents resume by id.

## Security

The server can make agents run commands, so its API is treated like a shell (`server/guard.ts`):

- It listens on `127.0.0.1` only.
- The `Host` header must be `localhost` or `127.0.0.1` on its port, which stops DNS-rebinding attacks.
- `Origin` and `Sec-Fetch-Site`, when the browser sends them, must be this server: other websites are refused.
- Writes must be `application/json`, which forces a CORS preflight no other site can pass.
- Every API call carries the token in `~/.agentyard/token` (mode 600), which keeps out other programs and users.

Child processes get a clean environment (`childEnv` in `server/agents/process.ts`): variables a parent agent session
sets for its own children are removed, so starting Agentyard from inside a Claude Code session doesn't make every
session it starts a child of that one.
