# pi-honcho-memory

Persistent memory for [pi](https://pi.dev) using [Honcho](https://honcho.dev). Requires pi 1.0 or later.

![NPM Version](https://img.shields.io/npm/v/%40agney%2Fpi-honcho-memory)

Honcho learns from your pi conversations and brings that context back:

- **Session start**: your peer card and the session summary are added to the system prompt. A collapsible `◆ honcho` entry shows what was loaded.
- **Each turn**: before pi answers, Honcho is asked about your message (`chat`, the default) or returns the most relevant conclusions (`context`). The answer is added under your message, also as a collapsible `◆ honcho` entry.
- **Saving**: your messages and pi's replies are saved to Honcho after every run.
- **Tools**: `honcho_chat` asks Honcho 1-5 questions in parallel, each with its own reasoning level. `honcho_search` searches past messages and saved conclusions.

The footer shows the connection state: `● honcho  aakash@pi · aakash-demo · 1,284 conclusions`.

## Install

```bash
pi install npm:@agney/pi-honcho-memory
```

Or from git:

```bash
pi install git:github.com/plastic-labs/pi-honcho
```

## Sign in

Run `/honcho login` inside pi and pick a method:

- **Browser**: approve in your browser and pi receives the callback on `127.0.0.1`. Over SSH or inside a container, press `p` and paste the URL the browser was redirected to.
- **Device code**: for SSH and headless machines. Enter the code on any device.
- **API key**: paste a key from your Honcho dashboard. It is checked before it is saved.

Browser and device sign-in are offered when the endpoint serves OAuth metadata (Honcho's managed service does). Self-hosted Honcho uses API keys.

Credentials live in `~/.honcho/config.json`, shared with other Honcho tools:

| Login             | Saved as          | Shared with    |
| ----------------- | ----------------- | -------------- |
| Browser or device | root `oauth`      | the honcho CLI |
| API key           | `hosts.pi.apiKey` | pi only        |

`HONCHO_API_KEY` in your environment takes precedence over any saved login. When nothing pi-specific is saved, pi uses a root `apiKey` written by another tool.

## Commands

| Command                                | What it does                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/honcho`                              | Status: connection, account, workspace, peers, session, memory counts, queue, injection settings                                   |
| `/honcho login [browser\|device\|key]` | Sign in                                                                                                                            |
| `/honcho logout`                       | Sign out. Revoking the shared OAuth sign-in asks first because it also signs out the honcho CLI. A root `apiKey` is never removed. |
| `/honcho config`                       | Settings. Every change is saved immediately.                                                                                       |
| `/honcho on`, `/honcho off`            | Turn Honcho on or off for pi. While off, nothing is injected or saved.                                                             |

Press `ctrl+o` to expand or collapse the `◆ honcho` entries and tool results.

## Configuration

`/honcho config` edits `~/.honcho/config.json`. Settings marked "shared" apply to every Honcho harness; "pi only" settings live under `hosts.pi`.

| Setting                   | Key                                                          | Scope   | Default                       |
| ------------------------- | ------------------------------------------------------------ | ------- | ----------------------------- |
| Honcho on/off             | `hosts.pi.enabled`                                           | pi only | `true`                        |
| Endpoint                  | `environmentUrl`, `endpoint.baseUrl`                         | shared  | `https://api.honcho.dev`      |
| Workspace                 | `hosts.pi.workspace`                                         | pi only | `pi`                          |
| Your peer                 | `peerName`                                                   | shared  | `$USER`                       |
| Agent peer                | `hosts.pi.aiPeer`                                            | pi only | `pi`                          |
| Session mapping           | `hosts.pi.sessionStrategy`                                   | pi only | `per-directory`               |
| Session start             | `hosts.pi.injection.sessionStart`                            | pi only | `["summary", "peerCard"]`     |
| Each turn                 | `hosts.pi.injection.perTurn`                                 | pi only | `["dialectic"]` (chat)        |
| Reasoning (chat)          | `hosts.pi.injection.dialecticReasoning`                      | pi only | `medium`                      |
| Chat prompt               | `hosts.pi.injection.dialecticTemplate`                       | pi only | built-in template             |
| Max conclusions (context) | `hosts.pi.injection.maxConclusions`                          | pi only | `15`                          |
| Show in chat              | `hosts.pi.injection.showInChat`                              | pi only | `["sessionStart", "perTurn"]` |
| Tools                     | `hosts.pi.tools.honcho_chat`, `hosts.pi.tools.honcho_search` | pi only | `true`                        |
| Save messages             | `hosts.pi.saveMessages`                                      | pi only | `true`                        |

`perTurn` uses the Claude Code plugin's names: `["dialectic"]` is chat, `["userContext"]` is context, `[]` is off.

Session mapping:

- `per-directory`: one session per directory, named `<peer>-<folder>` like the Claude Code plugin, so a repo maps to the same session name in both. Linked git worktrees share the main checkout's session. The root `sessions` map (`{"/abs/path": "name"}`) overrides the name.
- `git-branch`: one session per branch, `<peer>-<folder>-<branch>`.
- `chat-instance`: one session per pi session.

The per-turn memory check waits at most 30 seconds, then the turn continues without it.

### Environment variables

Environment variables win over the config file. `/honcho config` names the variable when one is shadowing a saved value.

| Variable                                           | Overrides            |
| -------------------------------------------------- | -------------------- |
| `HONCHO_API_KEY`                                   | the saved login      |
| `HONCHO_BASE_URL`, `HONCHO_URL`, `HONCHO_ENDPOINT` | endpoint             |
| `HONCHO_WORKSPACE`, `HONCHO_WORKSPACE_ID`          | workspace            |
| `HONCHO_PEER_NAME`                                 | your peer            |
| `HONCHO_AI_PEER`                                   | agent peer           |
| `HONCHO_SESSION_STRATEGY`                          | session mapping      |
| `HONCHO_ENABLED=false`                             | turns Honcho off     |
| `HONCHO_CONFIG_PATH`                               | config file location |

## Trying a local checkout

Load only the checkout, without your installed extensions, and keep its config separate from your real one:

```bash
pnpm install
HONCHO_CONFIG_PATH=/tmp/pi-honcho/config.json pi -ne -e .
```

`-ne` (`--no-extensions`) skips discovered and configured extensions; explicit `-e` paths still load.

## Upgrading from 0.x

- Commands `/honcho-status` and `/honcho-setup` are replaced by `/honcho` and its subcommands.
- The `honcho_remember` tool is removed.
- Session strategies `repo` and `directory` map to `per-directory`, which uses Claude Code's naming, so memory starts in a new session.
- `contextTokens`, `maxMessageLength`, `searchLimit` and `toolPreviewLength` are no longer read.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
