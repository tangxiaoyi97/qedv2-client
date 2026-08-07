import { utilityProcess, type UtilityProcess } from 'electron';
import type { CoreProcessLauncher, ManagedCoreProcess } from './core-supervisor.js';

type LineHandler = (line: string) => void;

const MAX_LOG_LINE_CHARS = 8 * 1024;
const MAX_LOG_LINES_PER_SECOND = 100;

function forwardLines(stream: NodeJS.ReadableStream | null, handler: LineHandler): void {
  if (!stream) return;
  let pending = '';
  let windowStartedAt = Date.now();
  let emittedInWindow = 0;
  let droppedInWindow = 0;
  const emit = (rawLine: string): void => {
    const now = Date.now();
    if (now - windowStartedAt >= 1_000) {
      if (droppedInWindow > 0) handler(`[${droppedInWindow} excessive Core log lines suppressed]`);
      windowStartedAt = now;
      emittedInWindow = 0;
      droppedInWindow = 0;
    }
    if (emittedInWindow >= MAX_LOG_LINES_PER_SECOND) {
      droppedInWindow += 1;
      return;
    }
    emittedInWindow += 1;
    handler(
      rawLine.length <= MAX_LOG_LINE_CHARS
        ? rawLine
        : `${rawLine.slice(0, MAX_LOG_LINE_CHARS)} … [truncated]`,
    );
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      emit(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    // A malicious or broken child must not grow the main-process buffer
    // without bound while withholding a newline.
    if (pending.length > MAX_LOG_LINE_CHARS) {
      emit(pending);
      pending = '';
    }
  });
  stream.on('end', () => {
    if (pending !== '') emit(pending);
    if (droppedInWindow > 0) handler(`[${droppedInWindow} excessive Core log lines suppressed]`);
  });
}

class ElectronManagedCoreProcess implements ManagedCoreProcess {
  private exited: number | undefined;
  private readonly exitHandlers: Array<(code: number) => void> = [];
  private readonly stdoutHandlers: LineHandler[] = [];
  private readonly stderrHandlers: LineHandler[] = [];

  constructor(private readonly child: UtilityProcess) {
    forwardLines(child.stdout, (line) => {
      for (const handler of this.stdoutHandlers) handler(line);
    });
    forwardLines(child.stderr, (line) => {
      for (const handler of this.stderrHandlers) handler(line);
    });
    child.on('error', (type, location) => {
      const message = `Utility process ${type}${location ? ` at ${location}` : ''}`;
      for (const handler of this.stderrHandlers) handler(message);
    });
    child.once('exit', (code) => {
      this.exited = code;
      for (const handler of this.exitHandlers.splice(0)) handler(code);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  kill(force = false): boolean {
    if (force && this.child.pid !== undefined) {
      try {
        process.kill(this.child.pid, 'SIGKILL');
        return true;
      } catch {
        return false;
      }
    }
    return this.child.kill();
  }

  onExit(callback: (code: number) => void): void {
    if (this.exited !== undefined) {
      queueMicrotask(() => callback(this.exited ?? 1));
      return;
    }
    this.exitHandlers.push(callback);
  }

  onStdout(callback: LineHandler): void {
    this.stdoutHandlers.push(callback);
  }

  onStderr(callback: LineHandler): void {
    this.stderrHandlers.push(callback);
  }
}

/** Launch the bundled Core in Electron's constrained Node utility process. */
export class ElectronCoreProcessLauncher implements CoreProcessLauncher {
  constructor(private readonly hostEntry: string) {}

  launch(options: { entry: string; cwd: string; env: NodeJS.ProcessEnv }): ManagedCoreProcess {
    const env = Object.fromEntries(
      Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    // Do not let shell-level Node/Electron injection flags alter the verified
    // utility-process bootstrap. Network/proxy/CA settings remain inherited.
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    env.QED2_CORE_ENTRY = options.entry;
    env.QED2_CORE_DIRECTORY = options.cwd;
    const child = utilityProcess.fork(this.hostEntry, [], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      serviceName: 'QED2 Local Core',
      allowLoadingUnsignedLibraries: false,
      disclaim: false,
    });
    return new ElectronManagedCoreProcess(child);
  }
}
