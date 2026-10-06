@AGENTS.md

# pi-honcho

Honcho memory for the pi coding agent, pi 1.0+ only (`@earendil-works/*`; the `@mariozechner/*` scope stops at 0.73). User-facing behavior and config keys are in README.md; this file covers what isn't obvious from the code.

## Commands

```bash
pnpm install
pnpm run typecheck   # tsc against the pi 1.0 typings in devDependencies
pnpm test            # vitest: unit, TUI and a real pi 1.0 session against a mock Honcho
pnpm run lint        # oxlint; 0 errors required, warnings are style-only
pnpm run fmt         # oxfmt; lefthook also formats staged files on commit
```

If `pnpm` isn't on PATH, run it through corepack: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …`. The lefthook pre-commit hook calls bare `pnpm`.

To run a checkout without the user's installed extensions or their real config: `HONCHO_CONFIG_PATH=/tmp/x/config.json pi -ne -e .`

## Layout

- `extensions/index.ts`: event wiring. `session_start` → `runtime.start`; `input` keeps the typed text; `before_agent_start` injects; `agent_end` saves.
- `runtime.ts`: `HonchoRuntime` covers the connection state machine, the phase-to-footer mapping, `call()` (token refresh plus one retry after a 401) and tool activation.
- `settings.ts` resolves config through `@honcho-ai/harness-plugin-core`. `config-file.ts` handles atomic reads and writes and the refresh lock.
- `auth/oauth.ts` holds the flows (discovery, PKCE loopback, device code, refresh, revoke, client choice). `auth/credentials.ts` holds precedence, refresh rotation and grant storage.
- `memory.ts` builds the session-start section and does per-turn recall. `capture.ts` turns run messages into Honcho messages. `session-name.ts` matches the Claude Code plugin's naming.
- `ui/`: the footer (`status.ts`), renderers (`render/`, pure formatters), login screens (`login/`), the settings view (`config/`) and the status panel.
- `tools/`: `honcho_chat` and `honcho_search`, with their renderers.

## Invariants

**pi**

- pi re-runs the extension factory on every `/new`, `/resume`, `/fork` and reload, and the old `ctx` then throws. Keep state in the factory closure. Guard async work with `runtime.generation` / `stale()` and pi calls with `runtime.safe()`.
- Never await the network in `session_start`: pi awaits it before rendering. `before_agent_start` blocks the prompt with no spinner and no abort signal, so it is capped at `TURN_BUDGET_MS` (30s) and the footer shows its own working state.
- Set the `honcho_memory` section on every `before_agent_start`. Skipping it once makes pi emit a patch that removes it. It is rebuilt each turn so the tool hints follow `/honcho config`.
- `honcho-turn` is a custom message, so it is sent to the model even when `display` is false. `honcho-start`, `honcho-status` and `honcho-login` are custom entries: display only, never sent.
- Recall and saving use the text the user typed, captured from the `input` event. `before_agent_start` and `agent_end` see skill and template expansions; those must never be saved as the user's words. Prompts from other extensions get no recall and aren't saved.
- ctrl+o is one global expand toggle. `setStatus` is a single line. Extensions can't add lines under `[Extensions]`.
- Tool schemas: no `maxItems` or `minimum`/`maximum`, because Anthropic then sends the tool non-strict. Clamp in `execute`.
- pi packages go in `peerDependencies: "*"` and never in `dependencies`. Runtime deps stay at `@honcho-ai/sdk` and `@honcho-ai/harness-plugin-core`.

**Config (`~/.honcho/config.json`, shared with the Claude Code plugin, Hermes and the honcho CLI)**

- Keep the v0 shape and never write `schemaVersion`. Harness core stops migrating root `apiKey`/`environmentUrl`/`oauth` once it is ≥1, and other tools read those keys directly.
- Pi-only settings go under `hosts.pi`. Shared settings stay at root under the names the other tools read: `peerName`, `environmentUrl` plus `endpoint.baseUrl`, and `oauth`.
- Write only through `updateConfig` (atomic, mode 0600, through symlinks). Never write after a parse failure. Preserve unknown keys, including inside `hosts.pi`.
- Credential precedence is `HONCHO_API_KEY` > `hosts.pi.apiKey` > root `oauth` matching the endpoint > root `apiKey`. Logout never removes a root `apiKey`.

**OAuth**

- The grant lives at root `oauth` in honcho-cli's shape (`accessToken`, `refreshToken`, `accessExpiresAt` in epoch seconds, `clientId`, `scope`, `host`), so the CLI and pi share it.
- Refresh tokens rotate on every use. Replaying a superseded one more than 60s later revokes the whole grant. Refresh only under `withConfigLock`, re-read the file inside the lock, persist before use, and don't write back if the stored grant changed during the exchange.
- Client choice: `honcho-pi` if the server knows it. Otherwise browser falls back to dynamic registration (the id is kept in `hosts.pi.oauthClientId`) and device falls back to `honcho-cli`. The token-endpoint probe in `clientSupports` sends no code and has no side effects.
- Access tokens last 1h and device codes 10min. There is no identity endpoint, so "Signed in as" shows the local peer name.

**Honcho SDK 2.5**

- A `Honcho` client caches a rejected first workspace call forever. After an auth failure at connect, build new clients; swapping the token isn't enough.
- No method takes an `AbortSignal`. Race with `abortable()` / `withTimeout()` instead.
- `peer()` and `session()` are network get-or-create calls. Ids must match `^[A-Za-z0-9_-]+$`.
- Messages are capped at 25,000 chars and batches at 100. Dialectic queries are capped at 10,000 chars, which `buildQuery` clamps to.
- `maxConclusions` defaults to 100 if omitted, and the representation is topped up with recent conclusions. No similarity scores are returned.
- Peer- and session-scoped keys get 401 on queue status, conclusion list/query and workspace search. Treat those as missing values, not as auth failure.

## Tests

- Render pure formatters at fixed widths with `plainTheme()`/`taggedTheme()` (`tests/helpers/theme.ts`). Drive components through `handleInput` with raw key sequences.
- `tests/integration/pi-harness.ts` runs a real pi 1.0 `AgentSession` with a faux model; `mock-honcho.ts` serves the Honcho routes and records requests. Use them for anything involving event ordering or injection.
- Tests must never touch the real `~/.honcho` or `~/.pi`. Use a temp dir with `HONCHO_CONFIG_PATH`, and pass `path`/`env`/`fetchImpl` into `CredentialStore`.

## Conventions

- Comments: one terse line for the why; no history narration. Copy follows the design artboards; no em-dashes in new user-facing copy.
- Changesets drive releases (`pnpm changeset`).
