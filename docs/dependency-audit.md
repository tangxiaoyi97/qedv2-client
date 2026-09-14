# Dependency audit — 2026-09-15

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
