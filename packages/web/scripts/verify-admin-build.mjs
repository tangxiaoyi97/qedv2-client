import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const [generatedAdmin, learner, worker] = await Promise.all([
  readFile(resolve(dist, 'admin/index.html'), 'utf8'),
  readFile(resolve(dist, 'index.html'), 'utf8'),
  readFile(resolve(dist, 'sw.js'), 'utf8'),
]);
// vite-plugin-pwa adds its manifest to every emitted HTML document. Remove
// that learner-only link from the final standalone document after its hooks.
const admin = generatedAdmin.replace(/<link\b[^>]*\brel="manifest"[^>]*>/gi, '');
if (admin !== generatedAdmin) await writeFile(resolve(dist, 'admin/index.html'), admin);
if (!admin.includes('id="admin-app"') || !/src="\/admin\/assets\/admin-[^"/]+\.js"/.test(admin)) {
  throw new Error('The management build is missing its independent HTML/JavaScript entry.');
}
if (/registerSW|rel="manifest"|src="\/assets\/app-/.test(admin)) {
  throw new Error('The management HTML contains learner bootstrap or PWA registration.');
}
if (!learner.includes('id="app"') || !learner.includes('rel="manifest"')) {
  throw new Error('The learner entry or its PWA manifest was removed.');
}
const urls = [...worker.matchAll(/\burl:\s*["']([^"']+)["']/g)].map((match) => match[1]);
if (urls.length === 0 || urls.some((url) => /^(?:\/)?admin(?:\/|$)/.test(url))) {
  throw new Error('Management documents or assets are present in the service-worker precache.');
}
for (const asset of await readdir(resolve(dist, 'admin/assets'))) {
  if (worker.includes(`admin/assets/${asset}`)) throw new Error('A management asset appears in the service worker.');
}
if (!worker.includes('management') || !worker.includes('NetworkOnly') || !worker.includes('denylist')) {
  throw new Error('The service worker must exclude management navigation and API responses.');
}
// registerType:autoUpdate does not imply these when injectRegister is false.
// A message-only SKIP_WAITING worker gets stuck behind already-open old pages,
// which know nothing about the independent management entry.
if (!/\bself\.skipWaiting\(\)/.test(worker) || !/\.clientsClaim\(\)/.test(worker) || worker.includes('SKIP_WAITING')) {
  throw new Error('The service worker must activate and claim existing clients without waiting for a page message.');
}
console.log('[admin] Independent entry and service-worker exclusions verified.');
