# Independent node management

Client 2.5 ships `/admin/` as a separate static HTML entry in the existing Web
build. GitHub Pages publishes `packages/web/dist`, including `admin/index.html`.
It does not mount the learning app, open its archive, load its bank, initialize
its router, or require an ordinary account login. Vue is the only UI runtime;
the management page uses native HTML controls and CSS, with no animations or
component library.

The page uses Client's Public Sans typography, native control dimensions, and
the same weed, sky, raspberry and violette light/dark CSS palettes. It inherits
the browser's saved appearance and accent, follows system appearance when no
explicit mode is set, and responds to preference changes from other Client tabs
or when the browser page resumes. Cached arbitrary external CSS is not applied
to management controls.

The learner mirrors its successfully loaded/saved appearance to
`qed2.appearance`; the existing `qed2.accent` preference remains shared. When the
appearance mirror is missing, admin spends at most 500 ms reading only
`config/theme` from an already existing `qed2` IndexedDB database. It does not
import the learner storage adapter, read progress, or commit a database creation
or upgrade; a deletion race aborts the opening upgrade transaction. Unsupported
database enumeration, denied storage or a timeout falls back to system mode
without saving that fallback as a user choice. Opening the updated learner then
publishes the saved appearance for future admin visits.

## Local use

Start Core and Server with their respective management listeners enabled and
separate persistent identity directories. Allow the exact Web origin in each
node's `MANAGEMENT_ALLOWED_ORIGINS`, for example `http://127.0.0.1:4173`.
Start the existing Web dev server with:

```sh
pnpm --filter @qed2/web dev --host 127.0.0.1 --port 4173 --strictPort
```

Open `http://127.0.0.1:4173/admin/`. Development defaults are Core management
`http://127.0.0.1:8788` and Server management `http://127.0.0.1:8081`; the page
accepts custom origins. Its production defaults are
`https://qedcore.barcarolle.studio` and `https://qedsync.barcarolle.studio`, where
TLS ingress must route `/management/*` to each independent management listener.
Do not route these requests through the other service. Production ingress and
node CORS allowlists are deployment configuration, not credentials in this build.

The page talks directly to both nodes. Server and Core each have a separate
login, session, setup password, error state, and logout. Either node remains
manageable when the other is offline. Merely opening the page does not connect
to a node. Only management protocol version 1 is accepted. Each operation also
requires its node capability to be explicitly enabled. Editing a node address
disconnects its previous session and requires
a fresh connection before accepting a password, preventing credential delivery
to a previously selected origin.

## Authentication and storage

Connect to the desired node. First setup requires reading that node's private
`bootstrap.key` locally on its host. A bootstrap login only opens the password
setup form. After saving a password, the backend invalidates the bootstrap key
and issues a new admin session. Password changes revoke previous sessions;
session expiry or a node restart requires login again. Recovery is a local
node CLI operation, never a button or remote reset endpoint.

Management passwords, bootstrap keys, bearer tokens, generated user passwords,
and response data remain in page memory. They are not written to browser
storage, URLs, console logs, archives or telemetry. In addition to the shared
non-secret appearance preferences, validated node origins are optionally stored
under `qed2.admin.server.origin` and
`qed2.admin.core.origin`. The origin must use HTTPS or loopback HTTP and cannot
contain URL credentials, query strings or fragments. Fetch uses
`credentials: omit`, `cache: no-store`, rejects redirects and never retries a
mutation automatically. An interrupted mutation is shown as an unconfirmed
result so the operator can inspect current state before trying again.

The admin HTML does not register a service worker or link a PWA manifest. Its
HTML and private entry assets are excluded from the learner precache; admin
navigation is excluded from the SPA fallback, and management responses use
network-only handling. The learner PWA remains registered from its own entry.
The generated worker explicitly uses `skipWaiting: true` and `clientsClaim:
true`, preserving the prior automatic-activation policy even though automatic
registration injection is disabled. An existing older page does not need to
send a `SKIP_WAITING` message. Taking control updates request handling without
forcing the learner page to reload or interrupting an answer in progress.
The production build verifies these properties. Existing installed workers
update through the learner's normal update mechanism; reload after the new
worker takes control if an older worker initially shows the learning shell.
Older workers can intercept both `/admin/` and `/admin/index.html`; changing the
URL alone is not a cache bypass. First open the learner home page, allow its
worker to update, then open `/admin/` again, or use the browser's hard reload.
The current learner entry also recognizes accidental `/admin` fallback delivery:
it updates the worker and retries document navigation at most once, without
booting learner state. If recovery cannot complete, it displays explicit update
links rather than entering a reload loop. Already-cached older JavaScript cannot
be retroactively updated by the new document; validate this migration against
an installed previous-release worker when publishing the first admin release.

## Operations

Server supports user lookup/creation, invitations, AI allowance edits, daily AI
usage, reported-activity statistics, feedback status changes, audit records, and
an optional supervised restart. Allowance edits preserve used counters. BYO
means user-owned AI credentials; removing shared-pool access does not disable
an account. User deletion, disabling and password reset are not exposed.

Statistics describe authenticated attempts **received** by Server. Guests,
offline activity and not-yet-synced work can be absent. AI daily buckets are UTC,
fees are cents, and user-key fees are estimates. Local datetime inputs for
invitation/allowance expiry are converted to ISO timestamps.

Core shows version, health and bank information, supports asynchronous bank
validation and optionally a configured bank update or supervised restart. Job
status is polled with read-only requests while running. A successful bank update
prepares a verified bank for the next Core restart; the live process continues
serving its original immutable bank until then. Restart and bank-update actions
require an explicit confirmation in the page.

The ordinary learning Settings screen also has an opt-in feedback form for
signed-in users, in German and English. It submits a user-written subject and
description, category, displayed Client version/platform and optional question
ID to `POST /me/feedback` using the ordinary user token. There are no automatic
uploads, logs, attachments, answers, or archive fields. The page requires an
explicit send checkbox and preserves unsent text if delivery fails.

## Checks

```sh
pnpm --filter @qed2/web typecheck
pnpm --filter @qed2/web test test/admin-api.spec.ts test/admin-components.spec.ts test/admin-theme.spec.ts test/feedback-settings.spec.ts
pnpm --filter @qed2/core-logic test test/feedback-client.spec.ts
pnpm --filter @qed2/web build
```

Tests cover independent node boot/login, setup-only UI, node-origin credential
isolation, address edits, no persisted secrets, failed mutations without retry,
session revocation, destination validation, support-field allowlisting, theme
inheritance, system changes and bounded read-only legacy preference access. The
build check verifies separate entry assets and service-worker exclusions.
