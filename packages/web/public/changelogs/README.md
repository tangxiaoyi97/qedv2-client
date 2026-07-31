# Release notes

Two files, one direction of travel:

```
latest.md                      you write here, any time
   │  pre-commit hook, when the root package.json version is new
   ▼
<repo>/CHANGELOG.md            released history, newest first
   │  build (packages/web/scripts/build-changelog.mjs)
   ▼
dist/changelogs/index.json     what the app fetches
```

## Writing notes

Put whatever you want to announce in `latest.md`. Markdown: `###` headings,
`-` lists, `**bold**`, `` `code` ``, `[text](url)`.

**Do not write the version number.** It comes from the root `package.json` and
is rendered as the section heading. A leading `# …` line is demoted to `###`
with any version echo removed, so the old `# QED2 1.9.6 - layout update!` habit
still produces `### layout update!` — but you may as well write `### layout
update!` yourself.

## Releasing

Bump `version` in the **root** `package.json` and commit. The pre-commit hook
does the rest:

1. `sync-version.mjs` copies the version into every `packages/*/package.json`
2. `fold-changelog.mjs` moves `latest.md` into a new `## <version> — <date>`
   section at the top of `CHANGELOG.md` and empties `latest.md`

Both re-stage what they touched, so it stays one ordinary commit. Nothing runs
in CI and nothing pushes back to the repository.

The fold is a no-op for prerelease versions (`2.0.0-beta.3`), for a version that
already has a section, and for an empty `latest.md` — so the hook is safe to run
on every commit.

## What the app does with it

Every deploy ships the **whole** history as `dist/changelogs/index.json`. The app
remembers the last version it showed you (`qed2.lastSeenVersion`) and, after an
update, announces the running version — that one section, nothing else. The
settings page („Änderungen") opens the same dialog with every version ever
shipped, which is where older notes live now; the old sha-keyed build had no
way to show them at all.

A build whose version has no section announces nothing. An unreleased build (a
beta, or main before the bump) ships `latest.md` as a draft entry instead, so
the dialog can be checked before it is real.

Only this README and `latest.md` live here in git; `index.json` is build output.

## Setup

The hook is `core.hooksPath`, which is per-clone and does not travel with the
repository — `pnpm install` sets it (root `prepare` script). If a bump ever
lands without its changelog section, that config is the first thing to check:

```
git config --get core.hooksPath   # → .githooks
```
