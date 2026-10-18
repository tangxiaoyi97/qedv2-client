import { EventEmitter } from 'node:events';
import { net, powerMonitor } from 'electron';

/** Chromium-backed link monitor. `true` means "possibly online", never a
 * guarantee that a specific QED2 upstream is reachable. */
export class NetworkMonitor extends EventEmitter {
  private online = true;
  private timer: NodeJS.Timeout | undefined;
  private resumeTimer: NodeJS.Timeout | undefined;
  private readonly onResume = () => {
    // Interfaces/proxies may change while asleep without changing isOnline().
    // Give the OS a short reconnect window and coalesce repeated wake signals.
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      this.sample();
      this.emit('resume', this.online);
    }, 2_000);
    this.resumeTimer.unref();
  };

  start(): void {
    if (this.timer) return;
    this.online = net.isOnline();
    this.timer = setInterval(() => this.sample(), 3_000);
    this.timer.unref();
    powerMonitor.on('resume', this.onResume);
  }

  isOnline(): boolean {
    return this.online;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = undefined;
    powerMonitor.off('resume', this.onResume);
  }

  private sample(): void {
    const current = net.isOnline();
    if (current === this.online) return;
    this.online = current;
    this.emit('change', current);
  }
}
