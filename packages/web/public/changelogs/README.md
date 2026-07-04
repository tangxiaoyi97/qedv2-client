# Changelog-on-update

`latest.md` holds the update notes for the CURRENT unreleased build. Write it
in the same commit as the change (Markdown: `#`/`##`/`###`, `-` lists, `**bold**`,
`` `code` ``, `[text](url)`).

On deploy the build script (`scripts/archive-changelog.mjs`) archives it as
`<commit-sha>.md` **only when**:

1. `latest.md` is non-empty, AND
2. `latest.md` was changed in this push (the CI passes `CHANGELOG_CHANGED`;
   local builds always archive so you can preview).

The archived file lands in `dist/changelogs/<sha>.md`. The app bakes in its own
build commit and, on first load after an update, fetches `/changelogs/<sha>.md`;
if it exists it shows the update dialog, otherwise nothing pops. So a version
with no `latest.md` changes simply never pops a dialog.

You don't have to empty `latest.md` — leaving last version's notes is harmless
because an unchanged `latest.md` is not re-archived. Overwrite it when you have
something new to announce.

This README and `latest.md` are the only files kept here in git; archived
`<sha>.md` files exist only in build output, never committed.
