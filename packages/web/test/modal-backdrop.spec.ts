import { describe, expect, it } from 'vitest';
import tokensCss from '../../ui/src/styles/tokens.css?inline';

// Both packages: the dialogs live on either side of the shell/ui boundary.
const vueSources = {
  ...(import.meta.glob('../src/**/*.vue', {
    eager: true,
    import: 'default',
    query: '?raw',
  }) as Record<string, string>),
  ...(import.meta.glob('../../ui/src/**/*.vue', {
    eager: true,
    import: 'default',
    query: '?raw',
  }) as Record<string, string>),
};

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

  it('leaves the centred-scrim geometry to q-modal-scrim instead of copying it', () => {
    // The identical eight-declaration block was pasted into six scoped
    // stylesheets; it lives in @qed2/ui's tokens.css now. A file that spells
    // the default scrim out again has copied it back, and the two will drift.
    const offenders = Object.entries(vueSources)
      .filter(
        ([, source]) =>
          /background:\s*rgba\(0,\s*0,\s*0,\s*0\.4\)/.test(source) &&
          /padding:\s*max\(16px,\s*env\(safe-area-inset-top\)\)/.test(source),
      )
      .map(([path]) => path.split('/').pop());
    expect(offenders).toEqual([]);
  });

  it('keeps the blur hook free of layout, so non-dialog overlays can use it', () => {
    // FigureViewer lays itself out as a column and the session drawer's scrim
    // sits inside its own stacking context; both carry q-modal-backdrop for
    // the frosted effect alone. Layout in that class silently breaks them.
    const rule = /\.q-modal-backdrop\s*\{[^}]*\}/.exec(tokensCss)?.[0] ?? '';
    expect(rule).toContain('backdrop-filter');
    for (const layout of ['position:', 'z-index:', 'display:', 'align-items:', 'padding:']) {
      expect(rule, layout).not.toContain(layout);
    }
  });
});
