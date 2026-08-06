#!/usr/bin/env node
/**
 * Post-build guard: prove the bundle belongs to the channel it claims.
 *
 * Source-level conventions do not survive a mis-push or a stray merge; a build
 * artifact assertion does. Run before publishing:
 *
 *   node scripts/assert-channel.mjs stable   # production deploy
 *   node scripts/assert-channel.mjs preview  # preview deploy
 *
 * IMPORTANT — the guard cannot grep for the word "preview". The answer-preview
 * feature already puts it in the bundle about two dozen times (answerPreview,
 * bar__preview, showPreview, expr__preview, …). A naive keyword guard would
 * fail on day one, get bypassed with `|| true`, and protect nothing from then
 * on. So it keys on host names and an explicit sentinel only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveVersion } from './commit.mjs';

const channel = process.argv[2] === 'preview' ? 'preview' : 'stable';
const dist = join(process.cwd(), 'dist');
const version = resolveVersion();

const PREVIEW_TOKENS = [
  'qed-pv.barcarolle.studio',
  'qedcore-pv.barcarolle.studio',
  'qedsync-pv.barcarolle.studio',
  'QED2-CHANNEL:preview',
];
const REQUIRED_STABLE_TOKENS = [
  'qedcore.barcarolle.studio',
  'qedsync.barcarolle.studio',
];
const REQUIRED_PREVIEW_TOKENS = [
  'qedcore-pv.barcarolle.studio',
  'qedsync-pv.barcarolle.studio',
  'QED2-CHANNEL:preview',
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(dist);
const problems = [];

const found = new Map();
for (const file of files) {
  if (/\.(png|jpg|jpeg|ico|woff2?)$/i.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const token of PREVIEW_TOKENS) {
    if (text.includes(token)) found.set(token, file);
  }
}

if (channel === 'stable') {
  // A push to main publishes immediately. Channel-correct endpoints are not
  // enough: an RC build must never become the production artifact merely
  // because it happened to be built with stable hosts.
  if (version.includes('-')) {
    problems.push(`stable bundle uses prerelease version "${version}"`);
  }
  for (const [token, file] of found) {
    problems.push(`production bundle contains preview token "${token}" (${file})`);
  }
  for (const token of REQUIRED_STABLE_TOKENS) {
    if (!files.some((file) => {
      if (/\.(png|jpg|jpeg|ico|woff2?)$/i.test(file)) return false;
      return readFileSync(file, 'utf8').includes(token);
    })) problems.push(`stable bundle is missing production endpoint "${token}"`);
  }
} else {
  // The reverse mistake — a preview deploy built with production config —
  // would point testers straight at real user data. Require both services,
  // not just the visual/channel sentinel.
  for (const token of REQUIRED_PREVIEW_TOKENS) {
    if (!found.has(token)) problems.push(`preview bundle is missing required token "${token}"`);
  }
}

// Positive assertion: the installed app identity must match the channel.
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
const expectedName = channel === 'preview' ? 'QED2 Preview' : 'QED2 — Matura Mathematik';
if (manifest.name !== expectedName) {
  problems.push(`manifest.name is "${manifest.name}", expected "${expectedName}"`);
}

if (problems.length > 0) {
  console.error(`channel assertion failed (${channel}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`channel assertion passed: ${channel} (${files.length} files scanned)`);
