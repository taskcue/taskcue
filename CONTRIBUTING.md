# Contributing

Thanks for wanting to help.

## Issues

Bug reports and ideas are welcome. For a bug, say which agent and version (`claude --version`, `codex --version`),
your OS, and what you saw; the server's terminal output helps.

## Pull requests

- Open an issue first for anything larger than a small fix, so we can agree on the approach.
- Keep each change focused. Run `pnpm typecheck` and `pnpm test` before you push; CI runs both and the build.
- Anything that reads an agent's output is tested against output captured from the real agent
  (`test/fixtures/`, see [docs/adding-an-agent.md](docs/adding-an-agent.md)), never against JSON written by hand.
- Before we merge your first pull request, we'll ask you to agree to a contributor license agreement, which lets the
  project change its license in the future. We'll link it from your pull request.

## Ground rules for the code

- Agents run as their own unmodified programs, with the user's own sign-in. Taskcue never reads, stores or forwards
  credentials.
- The server stays local: don't widen the checks in `server/guard.ts`.
- Nothing outside `server/agents/<agent>/` knows an agent's formats.
