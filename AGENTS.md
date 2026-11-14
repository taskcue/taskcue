# Working on TaskCue

TaskCue is a local web app that drives the coding agents installed on a computer (Claude Code, Codex) and shows
their sessions on one board. Start with [docs/architecture.md](docs/architecture.md).

- `pnpm dev` runs the server with the page hot-reloading on http://127.0.0.1:4880 (the address it prints carries the token).
- `pnpm typecheck`, `pnpm test` and `pnpm build` must pass; CI runs all three.
- To try it without touching your own state: `TASKCUE_CANVAS_PORT=4890 TASKCUE_CANVAS_DATA_DIR=/tmp/ay TASKCUE_CANVAS_HISTORY=0 pnpm dev`.

Rules:
- All knowledge of an agent's binary, protocol and files lives in `server/agents/<agent>/`. The page sees only `shared/types.ts`.
- Test adapters against output captured from the real agent (`test/fixtures/`, replayed by `test/fake/replay.mjs`).
- Never read or store an agent's credentials; never write to an agent's history.
- Don't widen `server/guard.ts`. The server binds 127.0.0.1 only.
- Icons describe what a control does; no sparkle or magic-wand icons for anything AI.
