import { mkdir, open, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]'],
  [/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1[REDACTED]@'],
];

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  }
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message), stack: redact(value.stack ?? '') };
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }
  return value;
}

export class DesktopLogger {
  readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(logDirectory: string) {
    this.filePath = join(logDirectory, 'desktop.log');
  }

  debug(message: string, detail?: unknown): void {
    this.write('debug', message, detail);
  }

  info(message: string, detail?: unknown): void {
    this.write('info', message, detail);
  }

  warn(message: string, detail?: unknown): void {
    this.write('warn', message, detail);
  }

  error(message: string, detail?: unknown): void {
    this.write('error', message, detail);
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private write(level: LogLevel, message: string, detail?: unknown): void {
    const entry = {
      at: new Date().toISOString(),
      level,
      message: redact(message),
      ...(detail === undefined ? {} : { detail: redact(detail) }),
    };
    const line = `${JSON.stringify(entry)}\n`;
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
        await this.rotateIfNeeded(Buffer.byteLength(line));
        const handle = await open(this.filePath, 'a', 0o600);
        try {
          await handle.writeFile(line, 'utf8');
        } finally {
          await handle.close();
        }
      })
      .catch((error: unknown) => {
        // Logging must never crash the application. Keep one last-resort line
        // in the process console for development/packaging diagnostics.
        console.error('[qed2:logger]', error);
      });
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    const size = await stat(this.filePath).then((value) => value.size).catch(() => 0);
    if (size + incomingBytes <= MAX_LOG_BYTES) return;
    for (let index = 2; index >= 1; index -= 1) {
      await rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`).catch(() => undefined);
    }
    await rename(this.filePath, `${this.filePath}.1`).catch(() => undefined);
  }
}
