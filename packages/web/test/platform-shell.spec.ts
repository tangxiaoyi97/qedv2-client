import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellCommand, ShellPort } from '@qed2/core-logic';
import type { Router } from 'vue-router';
import { WebShell } from '../src/platform/web-ports.js';
import { installShellCommandRouter } from '../src/platform/shell-commands.js';

class TestShell implements ShellPort {
  readonly capabilities = {
    desktop: true,
    nativeMenu: true,
    nativeTitleBar: true,
  } as const;

  private listener: ((command: ShellCommand) => void) | undefined;

  onCommand(cb: (command: ShellCommand) => void): () => void {
    this.listener = cb;
    return () => {
      if (this.listener === cb) this.listener = undefined;
    };
  }

  emit(command: ShellCommand): void {
    this.listener?.(command);
  }
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('web shell fallback', () => {
  it('is inert and advertises no desktop capabilities', () => {
    const shell = new WebShell();
    const listener = vi.fn();
    const unsubscribe = shell.onCommand(listener);

    expect(shell.capabilities).toEqual({
      desktop: false,
      nativeMenu: false,
      nativeTitleBar: false,
    });
    expect(unsubscribe).toBeTypeOf('function');
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('native shell command routing', () => {
  function setup() {
    const shell = new TestShell();
    const router = {
      push: vi.fn(() => Promise.resolve()),
      back: vi.fn(),
      forward: vi.fn(),
    } as unknown as Pick<Router, 'push' | 'back' | 'forward'>;
    const unsubscribe = installShellCommandRouter(router, shell);
    return { shell, router, unsubscribe };
  }

  it.each([
    ['navigate-home', 'home'],
    ['navigate-practice', 'practice'],
    ['navigate-questions', 'browse'],
    ['navigate-history', 'history'],
    ['navigate-progress', 'progress'],
    ['open-settings', 'settings'],
  ] as const)('maps %s to the fixed route %s', (command, routeName) => {
    const { shell, router } = setup();
    shell.emit(command);
    expect(router.push).toHaveBeenCalledWith({ name: routeName });
  });

  it('uses router history for native back and forward commands', () => {
    const { shell, router } = setup();
    shell.emit('go-back');
    shell.emit('go-forward');
    expect(router.back).toHaveBeenCalledOnce();
    expect(router.forward).toHaveBeenCalledOnce();
  });

  it('opens the capability-gated desktop settings route', () => {
    const { shell, router } = setup();

    shell.emit('open-update-center');

    expect(router.push).toHaveBeenCalledWith({
      name: 'settings',
      query: { section: 'desktop' },
    });
  });

  it('removes the native command listener on cleanup', () => {
    const { shell, router, unsubscribe } = setup();
    unsubscribe();
    shell.emit('navigate-home');
    expect(router.push).not.toHaveBeenCalled();
  });
});
