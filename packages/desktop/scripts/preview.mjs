import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!version.includes('-')) throw new Error('Preview packaging requires an explicit prerelease version.');
const env = { ...process.env, QED2_CHANNEL: 'preview' };
function run(args) {
  const child = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}
run(['runtime:prepare']);
run(['build']);
run(['--filter', '@qed2/web', 'exec', 'node', 'scripts/assert-channel.mjs', 'preview']);
run(['exec', 'electron-builder', '--config', 'electron-builder.preview.yml', '--publish', 'never']);
