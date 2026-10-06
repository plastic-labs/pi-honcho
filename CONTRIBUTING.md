# Contributing

## Prerequisites

- [pnpm](https://pnpm.io/) (see `packageManager` in `package.json` for exact version)
- [Node.js](https://nodejs.org/)

## Setup

```bash
pnpm install
```

This also installs [lefthook](https://github.com/evilmartians/lefthook) git hooks automatically.

## Linting

Uses [oxlint](https://oxc.rs/docs/guide/usage/linter) for fast linting.

```bash
pnpm run lint          # check for issues
pnpm run lint:fix      # auto-fix issues
```

## Type checking and tests

```bash
pnpm run typecheck     # tsc against the pi 1.0 typings
pnpm test              # unit tests plus a pi 1.0 session against a mock Honcho
```

## Formatting

Uses [oxfmt](https://oxc.rs/docs/guide/usage/formatter) for formatting.

```bash
pnpm run fmt           # format all files in place
pnpm run fmt:check     # check formatting without writing
```

## Pre-commit Hooks

[Lefthook](https://github.com/evilmartians/lefthook) runs automatically on `git commit`:

1. **oxlint** — lints staged `.js/.ts/.jsx/.tsx/.mjs/.cjs` files
2. **oxfmt** — formats staged files and re-stages them

See `lefthook.yml` for configuration.

## Testing

Uses [Vitest](https://vitest.dev/) for unit tests.

```bash
pnpm test          # run all tests once
pnpm test:watch    # re-run on file changes
```

Tests live in the `tests/` directory alongside the source.

## Changelog

Add user-facing changes to `CHANGELOG.md` under the next version's heading, `## [x.y.z] - unreleased`. Nothing in the repo needs a version bump in your PR.

## Releases

Maintainers cut releases from the `Release` workflow, which takes the version as a dispatch input:

```bash
gh workflow run release.yml -f version=1.1.0
```

The workflow runs lint, typecheck and tests, stamps the version into `package.json`, and stages it on npm through trusted publishing. No npm token is stored anywhere. A staged version is not installable until a maintainer approves it with 2FA:

1. Wait for npm's malware scan to finish, then approve the staged version in the package's Staged Packages tab on npmjs.com, or run `npm stage list` and `npm stage approve <id>`.
2. Publish the draft GitHub Release `v1.1.0` that the workflow created. This creates the tag on the commit that was staged.

Prerelease versions (`1.1.0-rc.1`) stage under the `next` dist-tag. Re-dispatching a version that is already on npm only fills in a missing draft release.
