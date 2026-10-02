---
"@agney/pi-honcho-memory": major
---

Rebuild for pi 1.0 on Honcho's golden path.

- Session start injects the peer card and session summary as a system-prompt section; each turn adds dialectic recall (chat) or relevant conclusions (context), shown as collapsible `◆ honcho` entries.
- `/honcho` status panel, `/honcho login` (browser, device code, API key), `/honcho logout`, `/honcho config` settings, `/honcho on` and `/honcho off`, and a footer that shows connected, working, signed out, expired, unreachable and off.
- `honcho_chat` asks 1-5 questions in parallel with per-question reasoning; `honcho_search` covers messages and conclusions. `honcho_remember` is removed.
- Config is shared with other Honcho harnesses through `~/.honcho/config.json` and resolved with `@honcho-ai/harness-plugin-core`; sessions use the Claude Code plugin's naming.
- Requires pi 1.0 (`@earendil-works/pi-coding-agent`).
