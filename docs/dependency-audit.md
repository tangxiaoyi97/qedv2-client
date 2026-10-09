# Dependency audit

## 2026-10-09 release preparation

The remaining development advisory from the hardening snapshot below is now
resolved by removing its dependency path. Both the complete dependency graph
(764 entries) and the production graph report zero advisories in the saved
registry snapshot. No advisory is ignored or suppressed.

The affected path was
`electron-builder → app-builder-lib → @electron/get@3.1.0 → global-agent@3.0.0 → roarr@2.15.4 → sprintf-js@1.1.3`.
The [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
still has no published patched version. Upstream
[global-agent 4.1.0](https://github.com/gajus/global-agent/releases/tag/v4.1.0)
removed Roarr and introduced an optional custom logger; the later
[4.1.3 release](https://github.com/gajus/global-agent/releases/tag/v4.1.3)
corrected the published distribution. The workspace therefore overrides only
`@electron/get@3.1.0>global-agent` to exactly `4.1.3`. Electron Builder and
`@electron/get` remain at their previously verified versions.

Although this crosses the proxy library's major version, the downloader uses
only its CommonJS `bootstrap()` entry. The reviewed release preserves that
entry, its global proxy controller, and proxy environment variables. The v4
release also makes TLS certificate rejection the default; the checks below
verify that a trusted certificate succeeds and an untrusted certificate fails.
Proxy diagnostics now use the library's optional logger instead of the removed
Roarr dependency; application logging is unaffected.

`packages/desktop/test/proxy-dependency.spec.mjs` exercises the installed
dependency through the actual Electron downloader in isolated Node processes:

- Direct artifact download and downloaded SHA-256 manifest verification.
- Authenticated HTTP proxy downloads for both artifact and checksum files.
- `NO_PROXY` bypass with an unreachable configured proxy.
- HTTPS CONNECT with a test-only trusted localhost certificate.
- Rejection of an untrusted certificate and an incorrect artifact checksum.
- Reviewed dependency identity and idempotent proxy bootstrap.

All seven checks passed on Node 24 with pnpm 11.0.3. They use local servers and
public test-only TLS fixtures, without external downloads or production
credentials. The test downloader disables its delayed terminal progress timer;
this avoids the pre-existing `@electron/get@3` timer left alive after a rejected
download without bypassing TLS or checksum validation.

Audit JSON, install output and compatibility-test output are stored in the
sibling workspace directory `audits/release-preparation-20261009`. The earlier
hardening result is retained below as historical evidence, not the current
dependency status.

## 2026-10-09 local release hardening

At this earlier snapshot the production graph had zero reported advisories. The
complete graph still had one moderate advisory in `sprintf-js`, a transitive
packaging dependency without a published fix; the release-preparation section
above records its subsequent removal. The registry snapshot is stored in the sibling workspace
directory `audits/release-hardening-20261009`.

| Dependency | Verified update | Reason |
| --- | --- | --- |
| Vue | 3.5.43 | Patched server renderer; all Vue packages resolve together |
| KaTeX | 0.18.10, exact pin | Patched settings handling; avoid the mistakenly breaking 0.18.11 patch |
| Electron | 42.10.0, exact pin | Sandbox inheritance, protocol and preload cache fixes in the existing 42 line |
| Vitest | 4.1.11 | Patched mock routing and removal of the vulnerable Tinypool dependency |
| source-map-js | 1.2.2 | Bound indexed source-map processing |
| Packaging/build dependencies | Scoped same-major overrides | Patched brace-expansion, fast-uri, xmldom, undici, Browserslist and HTTP cache semantics |

KaTeX's [migration guide](https://katex.org/docs/migration) describes the internal
CSS class rename in 0.18; QED2 uses the matching bundled stylesheet and has no
selectors depending on the renamed classes. Its deprecated 0.18.11 release is
intentionally excluded. Electron's [42.10.0 release](https://releases.electronjs.org/release/v42.10.0)
supplies the latest required security fix for this pinned line. Vitest's
[v4 migration guide](https://v4.vitest.dev/guide/migration) informed the test
upgrade; shared code now explicitly declares its standard Web API types instead
of inheriting Node ambient types through the old test runner.

Node 24 validation passed: 640 shared-logic, 407 UI, 762 Web and 254 Desktop
tests, all package type checks, Web/main builds, and frozen offline installation.
The normally optional live tests were additionally exercised against local Core,
Server and a disposable PostgreSQL instance. Native packaging qualification is
recorded separately in the workspace release-hardening report; Windows and Linux
still require their native CI runs before a public release.

## 2026-09-15 historical audit

The production dependency audit identified two high-severity advisories. Scoped
workspace overrides apply the smallest patched versions in the existing major
versions; all other dependency versions and peer resolutions remain unchanged.

| Dependency | Update | Affected path | Upstream advisory |
| --- | --- | --- | --- |
| nanoid | 3.3.17 → 3.3.18 | Vue compiler / PostCSS | [Zero-length custom generators](https://github.com/advisories/GHSA-2v37-7h3g-55p8) |
| js-yaml | 4.3.1 → 4.3.2 | Electron updater and packaging tools | [Empty merge sources bypass the CPU budget](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh) |

Validation used Node 24.19.0 and the project's pinned pnpm 11.0.3:

- Frozen installation and an offline lockfile refresh passed with no extra changes.
- `pnpm audit --prod --json`: zero advisories across 70 dependencies, including
  one optional dependency.
- Desktop tests: 235 passed in 22 files, including updater and release checks.
- Web production build and Desktop main/preload build passed. The Web build also
  verified the independent admin entry and service-worker exclusions.
- Eight direct runtime assertions checked both resolved patch versions, real
  Electron updater YAML parsing, the empty-merge budget, and synchronous and
  asynchronous nanoid generation, including zero-length output.

The audit result reflects the advisory registry at the time of this check.
