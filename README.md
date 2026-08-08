# QED2

QED2 is a learning app for the Austrian mathematics Matura (SRDP). It combines
practice, local grading, spaced repetition, progress history and optional AI
help in one account. The Web app works in every modern browser and can be
installed as a PWA; QED2 Desktop additionally includes its own local Core and
question bank for reliable offline use. Questions and user data are served by
separate services, so saved work is never part of the question-bank package.

## Run the Web app locally

You need Git, Node.js 24 or newer and pnpm 11.0.3. Clone the repository and
install the locked dependencies:

```sh
git clone https://github.com/tangxiaoyi97/qedv2-client.git
cd qedv2-client
corepack enable
pnpm install --frozen-lockfile
```

For a local Web preview backed by the official services, create the ignored
file `packages/web/.env.development.local`:

```dotenv
VITE_QED2_CORE_URL=https://qedcore.barcarolle.studio
VITE_QED2_SERVER_URL=https://qedsync.barcarolle.studio
```

Then start the app and open <http://localhost:5173>:

```sh
pnpm dev
```

For a fully self-hosted setup, development mode expects companion services on
these addresses:

| Service | Address | Required for |
| --- | --- | --- |
| QED2 Core | `http://localhost:8787` | questions, figures and solutions |
| QED2 Server | `http://localhost:8080` | login, sync and AI features |

The Core and Server source repositories currently require maintainer access.
If you have access, run both according to their own setup instructions and
replace the local override with:

```dotenv
VITE_QED2_CORE_URL=http://127.0.0.1:8787
VITE_QED2_SERVER_URL=http://127.0.0.1:8080
```

Create a production-ready static site with:

```sh
pnpm build
pnpm --filter @qed2/web preview
```

The stable build uses the official production services by default. To point a
self-hosted static build at your own services, put the same variables in
`packages/web/.env.production.local` before running `pnpm build`.

The files in `packages/web/dist` can be served by any static host. Keep
`404.html` beside `index.html` when the host uses it as the single-page-app
fallback. A self-hosted origin must be included in the Core and Server CORS
allowlists; the official GitHub Pages deployment is
<https://qed.barcarolle.studio>.

## Install QED2 Desktop

Download the current release from
[GitHub Releases](https://github.com/tangxiaoyi97/qedv2-client/releases/latest):

- macOS 12 or newer: choose the `mac-arm64.dmg` file for Apple Silicon or
  `mac-x64.dmg` for an Intel Mac.
- Windows 10/11 x64: choose the `win-x64.exe` installer.
- Linux x64: prefer the package for your distribution (`.deb` or `.rpm`), or
  use the `.AppImage`.

Download `SHA256SUMS` from the same release and compare the checksum of the
installer before opening it. For example:

```sh
# macOS
shasum -a 256 QED2-*-mac-*.dmg

# Linux
sha256sum QED2-*-linux-*
```

The published packages do not yet have paid platform publisher signatures.
macOS builds are ad-hoc sealed but not Developer ID signed or notarized;
Windows and Linux builds are unsigned. Install only assets from the official
GitHub Release, verify `SHA256SUMS`, and expect macOS Gatekeeper or Windows
SmartScreen to ask for confirmation. On macOS, use Finder's **Open** command
from the app's context menu; on Windows, review **More info** before choosing
**Run anyway**. An AppImage additionally needs executable permission:

```sh
chmod +x QED2-*-linux-x64.AppImage
```

Desktop starts a private UI gateway on `127.0.0.1:1122` and its bundled Core on
`127.0.0.1:1022`. If either preferred port is unavailable, QED2 selects another
loopback-only port; neither service is exposed to the local network. Local Core
is the default content source, remote Core remains available as a fallback,
and switching sources does not remove the account, progress or saved sessions.
Updates are downloaded with resume and integrity checks, but an unsigned build
never launches an installer or replaces itself—it only reveals the verified
file for manual installation.

## Build QED2 Desktop

Building Desktop from source requires maintainer access to the private Core
repository. Desktop builds use three sibling checkouts:

```text
workspace/
├── qedv2-client/
├── qedv2-core/
└── srdpmppr/
```

Check out the Core and question-bank commits recorded in
`packages/desktop/runtime-sources.json`, then install and build:

```sh
cd workspace/qedv2-client
corepack enable
pnpm install --frozen-lockfile
pnpm --dir ../qedv2-core install --frozen-lockfile
pnpm desktop:verify
pnpm desktop:dist
```

Installers are written to `packages/desktop/dist-packages`. The command builds
the current Web UI, prepares the pinned local Core and question bank, verifies
their runtime manifest, and then creates the unsigned packages for the current
operating system. Use `pnpm desktop:dev` for a local Electron development run.
