import { EventEmitter } from 'node:events';
import { net, powerMonitor } from 'electron';

/** Chromium-backed link monitor. `true` means "possibly online", never a
 * guarantee that a specific QED2 upstream is reachable. */
export class NetworkMonitor extends EventEmitter {
  private online = true;
  private timer: NodeJS.Timeout | undefined;
  private readonly onResume = () => this.sample();

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
    powerMonitor.off('resume', this.onResume);
  }

  private sample(): void {
    const current = net.isOnline();
    if (current === this.online) return;
    this.online = current;
    this.emit('change', current);
  }
}
