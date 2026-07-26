/**
 * The web app manifest for the installable PWA.
 *
 * Kept in its own module so test/pwa-manifest.spec.ts can assert it against the
 * theme it is supposed to mirror.
 *
 * Every field here must stay EXPLICIT: vite-plugin-pwa substitutes its own
 * defaults for anything omitted — notably `theme_color: '#42b883'` (Vue green)
 * and `background_color: '#ffffff'`. Dropping the two color entries is how
 * 1.9.3 shipped a green launcher/splash color; an omitted field is not a
 * neutral field.
 */
export const PWA_MANIFEST = {
  // Explicit app identity. Without it the id is derived from start_url, so a
  // later start_url change would register as an entirely different app and
  // orphan every existing installation.
  id: '/',
  name: 'QED2 — Matura Mathematik',
  short_name: 'QED2',
  description: 'SRDP-Mathematik üben mit intelligenter Wiederholung',
  lang: 'de',
  display: 'standalone',
  start_url: '/',
  scope: '/',
  // Static brand colors: the launcher, splash screen and task switcher read
  // these once at install time and never see the runtime theme. Live theme
  // switching still recolors the browser UI, through the
  // <meta name="theme-color"> that src/platform/theme.ts keeps in sync.
  // Both values mirror the default (weed) theme — see the spec file.
  background_color: '#f5f5f6', // weed light --q-page
  theme_color: '#5f6b2e', // weed light --q-accent-strong
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    // Same artwork on purpose: scripts/gen-icons.mjs draws an opaque full-bleed
    // tile with the mark inside the central 40%, i.e. well within the maskable
    // safe zone (the inner 80% circle), so no separate bleed variant is needed.
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
