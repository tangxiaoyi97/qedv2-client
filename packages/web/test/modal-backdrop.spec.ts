import { describe, expect, it } from 'vitest';

const vueSources = import.meta.glob('../src/**/*.vue', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

describe('modal backdrop baseline', () => {
  it('applies the shared blur class to every file that declares a modal dialog', () => {
    const modalFiles = Object.entries(vueSources).filter(([, source]) => {
      return source.includes('role="dialog"') || source.includes('aria-modal="true"');
    });

    expect(modalFiles.length).toBeGreaterThan(0);
    for (const [path, source] of modalFiles) {
      expect(source, path).toContain('q-modal-backdrop');
    }
  });
});
