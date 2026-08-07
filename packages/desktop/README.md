# QED2 Desktop

QED2 Desktop is the local-first Electron shell for the QED2 2.x client. It
packages the existing `@qed2/web` application, `@qed2/core-logic`, a built
`qed2-core` runtime, and a pinned `srdpmppr` question bank. The shell owns OS
integration and process supervision; grading, FSRS, sync, and content behavior
remain in the shared packages.

## What the desktop app guarantees

- The Web build is not forked. Every desktop build first runs
  `pnpm --filter @qed2/web build` and packages `packages/web/dist`, so Web UI
  and shared-logic changes are inherited automatically by the next desktop
  artifact.
- The main renderer is sandboxed with context isolation enabled and Node
  integration disabled. A narrow preload exposes typed platform ports; raw
  Electron IPC, file paths, processes, and arbitrary routes are not exposed.
- All windows use one persistent Electron session. New-window creation,
  renderer-initiated navigation, redirects, subframes, permissions, and
  `<webview>` attachment are denied.
- Local data is stored under Electron `userData` in SQLite. Web and desktop
  remain API-compatible through `PlatformPorts`.
- Login tokens alone use Electron `safeStorage` (macOS Keychain, Windows DPAPI,
  or a real Linux secret store). Chromium cookie encryption is disabled because
  QED2 uses explicit bearer authentication with `credentials: omit`; the
  dedicated renderer partition rejects cookies and clears legacy cookie/SW
  state. A logged-out profile therefore does not initialize the Keychain.

### Window model

The application has four singleton window roles:

| Role | Behavior |
| --- | --- |
| Main | One normal application window. A second app launch focuses it; `/desktop` is its capability-gated local-node overview. |
| Practice | One focused practice window; an explicit `/practice` route may carry query/hash state. |
| Update Center | One native window serving only the capability-gated `/desktop/updates` route. |
| Node Diagnostics | One native window serving only the capability-gated `/desktop/node` route. |

The native macOS/Windows/Linux menu emits only the bounded `ShellCommand`
union used by the Web router. Tool windows render the same capability-gated
Web UI and shared design tokens as the main window; Electron does not inject a
floating beacon, popup, or second component system. Tool windows never receive
global navigation commands. Window bounds, maximized state, and full-screen
state are debounce-persisted. Legacy desktop Settings URLs redirect to these
routes only when the desktop capability is present; ordinary Web/PWA clients
fall back to Settings and never render or reserve desktop-only UI.

## Local runtime and ports

The packaged Core is launched as an Electron utility process and reads the
packaged bank directly. The renderer never talks to that process directly: a
loopback gateway serves the Web build and proxies the allowed Core endpoints.

| Service | Preferred binding | Collision behavior |
| --- | --- | --- |
| Desktop UI gateway | `127.0.0.1:1122` | If 1122 is occupied, bind an OS-assigned ephemeral loopback port. |
| Local Core | `127.0.0.1:1022` | Try 1022 through 1121, then use an OS-assigned ephemeral loopback port. |

The actual ports are runtime state, not stable public endpoints. UI requests
carry a per-launch capability token in an injected header; the token is not put
in a URL. If the local Core cannot pass its bounded health check, the configured
remote Core is used in degraded mode. An unexpected Core exit gets at most three
automatic restart attempts; after that, the user chooses retry, repair, or
remote mode from diagnostics.

## Development layout

Runtime preparation expects three sibling checkouts:

```text
workspace/
├── qedv2-client/   # this repository
├── qedv2-core/     # main
└── srdpmppr/       # pastpapers
```

Use Node 24 and pnpm 11.0.3:

```sh
pnpm install --frozen-lockfile
pnpm --dir ../qedv2-core install --frozen-lockfile
pnpm --filter @qed2/desktop verify
pnpm --filter @qed2/desktop runtime:prepare
pnpm desktop:package
```

`desktop:package` and `@qed2/desktop dist` use
`electron-builder.unsigned.yml`: macOS receives a complete ad-hoc signature
and macOS, Windows, and Linux receive a `manual-only` updater marker. The separate
`dist:signed` and `release:signed` scripts are reserved for a future build
environment that actually has trusted platform identities.

`QED2_CORE_SOURCE` and `QED2_BANK_SOURCE` may point runtime preparation at
different checkouts. `QED2_DESKTOP_CORE_PATH`, `QED2_DESKTOP_CORE_ENTRY`, and
`QED2_DESKTOP_BANK_PATH` are development-only runtime overrides.

`runtime:prepare` builds and production-deploys Core, copies only the bank's
current `content`, `assets`, and `schema`, and generates an immutable revision
vault for every bank commit reachable from the frozen release commit. The
format-v3 runtime manifest inventories the current bank, revision catalog, and
content-addressed historical objects with their exact hashes. Preparation
validates schema versions 2/3 and stages the complete runtime before replacing
the previous prepared directory.

## CI policy

[`desktop-ci.yml`](../../.github/workflows/desktop-ci.yml) uses native hosted
runners for Ubuntu x64, Windows x64, and macOS arm64. Every pull request:

1. checks out the client plus the exact Core and bank commits pinned in
   `runtime-sources.json` as siblings;
2. restores pnpm and Electron tool caches;
3. installs both JavaScript dependency sets with frozen lockfiles;
4. runs desktop typecheck, tests, and the shared Web/main build; and
5. prepares the complete bundled runtime on each operating system.

Pushes to `main` and manual CI runs additionally execute an unpacked
`electron-builder --dir` package smoke on all three systems. Pull requests do
not build large installers, and CI artifacts are not release candidates. All
workflow actions are pinned to reviewed commits.

### Electron compatibility pin

Electron is intentionally pinned to exactly `42.7.1`, the newest verified
patch in the supported 42 line. A clean packaged macOS profile reproduced a
missing sandbox `startupData` failure on Electron 43.3.0, while 42.7.1 passed
with the same application, preload, fuses, and empty profile. QED2 keeps
renderer sandboxing enabled instead of weakening the security model. An
Electron upgrade is allowed only after the packaged-app smoke has passed on
macOS, Windows, and Linux with the real preload capability, Local Core startup,
singleton tool windows, and clean process shutdown. The pin must be revisited
before the Electron 42 support window closes.

## Release pipeline

[`desktop-release.yml`](../../.github/workflows/desktop-release.yml) has two
explicit modes. A manual `verify-only` dispatch proves the complete native
build and asset contract while requiring that neither the tag nor GitHub
Release exists. Publication runs only for a pushed `v*` tag or a manual
`publish` dispatch naming an existing annotated `v*` tag. The first-release
channel accepts stable `vMAJOR.MINOR.PATCH` tags only; the tag must equal both
the root and desktop package versions. Every platform uses the same full Core
and bank commit IDs already reviewed in the release commit.

The release commit pins full Core and bank commit IDs in
`runtime-sources.json`; rerunning a tag therefore cannot silently package newer
runtime code or content. The pipeline uses Node 24, pnpm 11.0.3, frozen
lockfiles, and pnpm/Electron caches. A frozen-source verification, runtime
startup/identity smoke, and native packaging gate must pass before publication.
The current project has no paid Apple Developer or Windows code-signing
identity and does not publish a Linux package signature. macOS is therefore
completely ad-hoc signed (including sealed resources) but not notarized;
Windows and Linux packages are intentionally unsigned.
The workflow verifies those exact properties and never labels the packages as
trusted platform-signed builds. Assets and update metadata are first uploaded
to a draft, downloaded again, and byte-verified; only after every package, tag,
and `main`-head check passes is that draft published. A published Release is
never overwritten. `UNSIGNED-BUILD-NOTICE.txt`, `runtime-sources.txt`,
`release-manifest.json`, and `SHA256SUMS` record the complete source and
artifact set; GitHub also emits a Sigstore-backed build-provenance attestation.
Immediately before publication, the pipeline confirms that the remote release
tag still resolves to the frozen client commit.

### Required Actions secrets

| Secret | Purpose |
| --- | --- |
| `DESKTOP_CORE_DEPLOY_KEY` | Repository Actions secret containing the private half of a dedicated SSH deploy key registered read-only on the private `qedv2-core` repository (`Allow write access` disabled). The public question bank uses the normal public checkout and does not receive this key. |

Gate final publication through the `desktop-release` environment. `GITHUB_TOKEN`
is supplied by Actions and receives `contents: write`, `id-token: write`, and
`attestations: write` only in the final publish job. Checkout credentials are
not persisted into any working tree used by build scripts. If platform
certificates are acquired later, `electron-builder.yml`, `dist:signed`, and
`release:signed` remain the explicit signed/notarized path; credentials must
never be committed.

## First-release support matrix

| Platform | CPU | Deliverables | First-release support |
| --- | --- | --- | --- |
| macOS 12 Monterey or newer | Apple Silicon arm64 | DMG and ZIP containing a sealed ad-hoc-signed, unnotarized app | Supported; Gatekeeper warning expected on first open |
| macOS 12 Monterey or newer | Intel x64 | DMG and ZIP containing a sealed ad-hoc-signed, unnotarized app | Supported; Gatekeeper warning expected on first open |
| Windows 10/11 | x64 | unsigned per-user NSIS installer | Supported; SmartScreen warning expected on first install |
| Ubuntu 24.04 LTS | x64 | AppImage and deb | Supported; release packaging is verified on Ubuntu 24.04 |
| Other current glibc-based distributions | x64 | AppImage, deb, or rpm as appropriate | Compatibility packages are published, but are best-effort in the first release |
| Windows arm64, Linux arm64/32-bit | — | none | Not in the first release |

There is no Mac App Store, Microsoft Store, Snap, or single universal macOS
binary in the first release. Linux desktop integration varies by distribution;
the native package matching the distribution is preferred over AppImage.

## Release integrity, manual install, and recovery standard

- GitHub Releases is the only application update source. On unsigned macOS,
  Windows, and Linux builds QED2 may check, download, hash-verify, retry, and
  resume the appropriate package, but it never invokes, spawns, or performs an
  in-place self-install. It reveals the verified file in Finder or Explorer
  (or the Linux file manager) and requires an explicit manual install.
- Before publication, every filename, byte size, and SHA-512 value referenced
  by `latest.yml`, `latest-mac.yml`, and `latest-linux.yml` is re-derived from
  the downloaded native-job artifacts. NSIS `.exe` and macOS `.zip` payloads
  must carry their electron-builder sidecar blockmaps; each sidecar is decoded
  as a bounded canonical v2 inventory and every block checksum is re-derived
  from the referenced payload. AppImage instead carries
  electron-builder's blockmap inside the same SHA-512-covered payload: release
  verification requires `blockMapSize`, validates the embedded trailer and its
  v2 block inventory, and rejects a misleading `.AppImage.blockmap` sidecar.
  deb/rpm packages are verified by their manifest hashes and the release
  SHA-256 set. `release-manifest.json` format 2 independently inventories every
  published asset with its exact size, SHA-256, and SHA-512. Each manually
  installable DMG, EXE, AppImage, deb, and rpm additionally carries one exact
  `platform`/`arch`/`manual-package` target; the client rejects legacy,
  ambiguous, incomplete, or filename/target-mismatched manifests.
  The release also publishes a signed GitHub build-provenance attestation for
  independent verification.
- Application downgrade is disabled. A bad release is recovered by publishing
  a newer patch, or by a deliberate manual reinstall of a known-good version.
  Published Release assets are immutable by policy:
  the pipeline may resume an unpublished draft, but refuses to overwrite an
  existing published tag. The app does not silently roll itself back.
- Core executable code and the bank snapshot are installed as part of the same
  versioned desktop artifact and are identified by the bundled runtime
  manifest. Artifact hashes, release provenance, and the packaged runtime
  integrity inventory protect the delivery boundary; ad-hoc signing is only a
  macOS execution/structure requirement and is not a publisher identity. The Update Center
  reports Core and the bank as included in the Desktop Release. It does **not**
  present them as independent updates, perform a bank A/B update, or execute
  newly downloaded Core code.
- Runtime preparation is atomic at build time. At runtime, Core crash recovery
  is bounded to three restarts and may switch to the configured remote endpoint;
  renderer crash recovery is also bounded. User SQLite data is outside the app
  bundle and is retained across app updates and normal uninstall/reinstall
  recovery unless the user explicitly removes it.

An artifact is releasable only when all platform builds use the same frozen
source commits, the runtime schema check passes, the macOS ad-hoc resource seal
validates, Windows remains truthfully unsigned, update metadata is present, and
the full support-matrix asset set reaches the GitHub Release together.
