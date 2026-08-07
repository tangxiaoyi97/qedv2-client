/**
 * Native-menu command routing for a wrapping shell.
 *
 * The preload exposes a bounded ShellCommand union rather than raw IPC or an
 * arbitrary path. Navigation stays in Vue Router, including the desktop
 * update center's fixed capability-gated settings route.
 */
import type { ShellCommand, ShellPort } from '@qed2/core-logic';
import type { Router } from 'vue-router';
import { ports } from '../services.js';

type CommandRouter = Pick<Router, 'push' | 'back' | 'forward'>;

/** Install once after App.vue is mounted; returns the native-listener cleanup. */
export function installShellCommandRouter(
  router: CommandRouter,
  shell: ShellPort = ports.shell,
): () => void {
  return shell.onCommand((command: ShellCommand) => {
    switch (command) {
      case 'navigate-home':
        void router.push({ name: 'home' });
        return;
      case 'navigate-practice':
        void router.push({ name: 'practice' });
        return;
      case 'navigate-questions':
        void router.push({ name: 'browse' });
        return;
      case 'navigate-history':
        void router.push({ name: 'history' });
        return;
      case 'navigate-progress':
        void router.push({ name: 'progress' });
        return;
      case 'open-settings':
        void router.push({ name: 'settings' });
        return;
      case 'open-update-center':
        void router.push({ name: 'settings', query: { section: 'desktop' } });
        return;
      case 'go-back':
        router.back();
        return;
      case 'go-forward':
        router.forward();
        return;
    }
  });
}
