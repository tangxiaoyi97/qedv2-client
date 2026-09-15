import { execFileSync } from 'node:child_process';

const MAX_STATUS_ENTRIES = 20;
const MAX_DIAGNOSTIC_BYTES = 4096;
const MAX_ENTRY_CHARACTERS = 200;

function quotedEntry(entry) {
  let value = '';
  let count = 0;
  for (const character of entry) {
    if (count++ === MAX_ENTRY_CHARACTERS) {
      value += '…';
      break;
    }
    value += character;
  }
  return JSON.stringify(value);
}

export function formatGitStatusDiagnostic(status) {
  const entries = status.split('\0').filter(Boolean);
  const lines = ['Changed paths (Git status):'];
  const omitted = 'Additional paths omitted.';
  let shown = 0;
  for (const entry of entries) {
    const line = quotedEntry(entry);
    if (
      shown === MAX_STATUS_ENTRIES ||
      Buffer.byteLength([...lines, line, omitted].join('\n'), 'utf8') > MAX_DIAGNOSTIC_BYTES
    ) break;
    lines.push(line);
    shown++;
  }
  if (shown < entries.length) lines.push(omitted);
  return lines.join('\n');
}

export function assertCleanGitCheckout(repositoryPath, label) {
  const status = execFileSync(
    'git',
    ['-C', repositoryPath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (status) {
    throw new Error(
      `${label} checkout contains uncommitted files and cannot represent an immutable commit\n` +
      formatGitStatusDiagnostic(status),
    );
  }
}
