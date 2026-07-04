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

## Injection mechanism (already wired in the web bundle)

`packages/web/src/services.ts` reads `globalThis.__QED2_PLATFORM_PORTS__`
before falling back to the web adapters. The Electron shell therefore is:

1. a main process that spawns/manages the local core (from the clone of
   `ClientConfig.coreRepoUrl` + `bankRepoUrl` — both user-configurable under
   Einstellungen → Erweitert),
2. a preload script that exposes desktop implementations of any subset of
   `PlatformPorts` on `__QED2_PLATFORM_PORTS__` via the context bridge,
3. a BrowserWindow loading the UNMODIFIED `@qed2/web` build output.

The app resolves its core endpoint through `CoreRuntimePort.getEndpoint()`
at startup and on config changes, so an injected desktop port switching
between remote and `http://localhost:<port>` takes effect without any web
code changes. UI/logic upgrades = rebuild the web bundle; packaging stays.
