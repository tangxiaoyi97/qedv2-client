# @qed2/mobile (reserved)

Future iOS shell. v1 ships the web app as an installable PWA instead
(contract §8.2: web/PWA does not self-host a local core). A native shell (or
Capacitor wrapper) would reuse `@qed2/ui` + `@qed2/core-logic` unchanged and
implement the ports:

- `StoragePort` → native storage / IndexedDB inside WKWebView,
- `CoreRuntimePort` → remote endpoint only (`capabilities.localCore = false`),
- `UpdatePort` → App Store / PWA update semantics,
- `NetworkPort` → reachability APIs.
