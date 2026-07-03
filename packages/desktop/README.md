# @qed2/desktop (reserved)

Future Electron shell. Not implemented in v1 — reserved so the architecture
stays honest: the desktop app will be a thin shell that

1. bundles the same `@qed2/ui` + `@qed2/core-logic` packages,
2. implements the platform ports from `@qed2/core-logic/ports`:
   - `StoragePort` → file system (or SQLite),
   - `CoreRuntimePort` → spawn a local `qed2-core` process from a local clone
     (offline self-hosting; `capabilities.localCore = true`), switching
     between the remote endpoint (online) and `http://localhost:<port>`,
   - `UpdatePort` → `capabilities.selfUpdate = true`; "check core update" and
     "check bank update" compare core `GET /info` (`version`, `bank.commit`)
     against the git remotes, then pull + restart the local core
     (respecting the schemaVersion compatibility contract §6.2),
   - `NetworkPort` → OS-level connectivity events,
3. adds an Electron main process + auto-launch plumbing. No business logic.

If a desktop feature ever seems to require copying grading/FSRS/sync code out
of `@qed2/core-logic`, that is an encapsulation failure — fix core-logic
instead.
