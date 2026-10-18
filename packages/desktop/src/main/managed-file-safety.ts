import { lstatSync, realpathSync, unlinkSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

export class UnsafeManagedPathError extends Error {
  readonly code = 'ERR_UNSAFE_MANAGED_PATH';

  constructor() {
    super('Refusing to manage an unsafe local storage path');
    this.name = 'UnsafeManagedPathError';
  }
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Only configured main-process paths enter here, never renderer-supplied paths. */
export function managedDirectory(directory: string): { path: string; stat: Stats } | undefined {
  const requested = resolve(directory);
  let info: Stats;
  try {
    info = lstatSync(requested);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info)) {
    throw new UnsafeManagedPathError();
  }
  // macOS exposes its system temporary roots through fixed OS aliases. Beyond
  // those aliases, a link in any ancestor could redirect cleanup out of the app.
  for (let ancestor = dirname(requested); ancestor !== parse(ancestor).root; ancestor = dirname(ancestor)) {
    if (!lstatSync(ancestor).isSymbolicLink()) continue;
    const expectedAlias = process.platform === 'darwin' && (ancestor === '/var' || ancestor === '/tmp')
      ? `/private${ancestor}` : undefined;
    if (!expectedAlias || realpathSync(ancestor) !== expectedAlias) throw new UnsafeManagedPathError();
  }
  const canonical = realpathSync(requested);
  const canonicalInfo = lstatSync(canonical);
  if (!sameFile(info, canonicalInfo)) throw new UnsafeManagedPathError();
  return { path: canonical, stat: info };
}

export function ownedByCurrentUser(info: Stats): boolean {
  return typeof process.getuid !== 'function' || info.uid === process.getuid();
}

export function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function managedFile(directory: string, name: string): { path: string; stat: Stats } | undefined {
  if (!name || name === '.' || name === '..' || isAbsolute(name) || /[/\\\0]/.test(name)) {
    throw new UnsafeManagedPathError();
  }
  const path = join(directory, name);
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !ownedByCurrentUser(info)) {
    throw new UnsafeManagedPathError();
  }
  return { path, stat: info };
}

/** Revalidate immediately before unlink; no await permits an in-app writer to interleave. */
export function unlinkManagedFile(
  requestedDirectory: string,
  originalDirectory: { path: string; stat: Stats },
  name: string,
  originalFile: Stats,
): number {
  const currentDirectory = managedDirectory(requestedDirectory);
  if (!currentDirectory || currentDirectory.path !== originalDirectory.path ||
      !sameFile(currentDirectory.stat, originalDirectory.stat)) throw new UnsafeManagedPathError();
  const file = managedFile(currentDirectory.path, name);
  if (!file) return 0;
  if (!sameFile(file.stat, originalFile) || file.stat.size !== originalFile.size ||
      file.stat.mtimeMs !== originalFile.mtimeMs) throw new UnsafeManagedPathError();
  unlinkSync(file.path);
  return file.stat.size;
}
