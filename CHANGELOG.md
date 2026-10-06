# @agney/pi-honcho-memory

## 1.0.0

### Major Changes

- 435564c: Rebuild for pi 1.0 on Honcho's golden path.

  - Session start injects the peer card and session summary as a system-prompt section; each turn adds dialectic recall (chat) or relevant conclusions (context), shown as collapsible `◆ honcho` entries.
  - `/honcho` status panel, `/honcho login` (browser, device code, API key), `/honcho logout`, `/honcho config` settings, `/honcho on` and `/honcho off`, and a footer that shows connected, working, signed out, expired, unreachable and off.
  - `honcho_chat` asks 1-5 questions in parallel with per-question reasoning; `honcho_search` covers messages and conclusions. `honcho_remember` is removed.
  - Config is shared with other Honcho harnesses through `~/.honcho/config.json` and resolved with `@honcho-ai/harness-plugin-core`; sessions use the Claude Code plugin's naming.
  - Requires pi 1.0 (`@earendil-works/pi-coding-agent`).

## 0.1.0

### Minor Changes

- a0cd5c7: Add configurable Honcho memory tuning options for injected context tokens, synced message length, search result limits, and preview lengths. Also relabel the injected repo-wide summary as a project summary and document the available config and environment variable mappings in the README.
- 42e2ef2: Remove the `/recall` and `/remember` commands and keep the equivalent `honcho_search` and `honcho_remember` tools.

  The extension still provides `/honcho-status` and `/honcho-setup` for visibility and configuration.

  Also remove the unused `HONCHO_COMMAND_PREVIEW_LENGTH` / `hosts.pi.commandPreviewLength` config option that only applied to `/recall`.

- 9c9f5d2: Remove runtime context injection (git state, worklog) from prompt. The extension now focuses solely on Honcho persistent memory. Users who want git context can install a separate extension.

### Patch Changes

- 5e4dee4: Inject both user profile and project summary into the system prompt for maximum prompt cache stability. Memory is fetched once at session start and never re-fetched mid-session — conversation history provides all context within a session. Removes the `context` hook and ephemeral message injection in favor of a simpler, fully cacheable approach.

## 0.0.2

### Patch Changes

- 5c2dcb9: Fix `/honcho-setup` baking env-var-resolved values into config file

  `buildConfigFile` was unconditionally writing `existing.workspaceId` and
  `existing.aiPeerId` to `~/.honcho/config.json` even when those values were
  resolved from `HONCHO_WORKSPACE_ID` / `HONCHO_AI_PEER` environment variables.
  This caused the env-var value to be frozen in the file; if the env var later
  changed or was unset, the stale file value would silently take precedence.

  Since the setup wizard never collects `workspaceId` or `aiPeerId` from the
  user, these fields are no longer written by the wizard. Any value already
  present in the config file is preserved as before.

- 69be7e3: Fix `userPeerId` default to use portable `os.userInfo().username`

  `process.env.USER` is `undefined` on Windows, causing the peer ID to
  silently fall back to the string `"user"` instead of the actual system
  username. Replaced with `os.userInfo().username`, which works correctly
  on POSIX and Windows alike.

  Also fixed the `lefthook.yml` pre-commit hook to run `oxlint` on the
  full project rather than individual staged files, restoring proper
  `tsconfig.json` resolution and eliminating spurious TS2591 errors.
