import { describe, expect, it } from 'vitest';

import authSource from '../src/routes/AuthModal.vue?raw';
import practiceSource from '../src/routes/PracticeView.vue?raw';
import progressSource from '../src/routes/ProgressView.vue?raw';
import settingsSource from '../src/routes/SettingsView.vue?raw';

describe('close control consistency', () => {
  it('uses the shared close control on both auth faces and detail dialogs', () => {
    expect(authSource.match(/<QIconButton\b/g)).toHaveLength(2);
    expect(settingsSource).toContain('<QIconButton aria-label="Schließen" data-autofocus');
    expect(progressSource).toContain('<QIconButton aria-label="Schließen" data-autofocus');

    for (const source of [authSource, settingsSource, progressSource]) {
      expect(source).not.toContain('q-dialog-close');
      expect(source).not.toMatch(/<button[^>]*>\s*✕\s*<\/button>/s);
    }
  });

  it('keeps the practice exit confirmation expandable but aligns its idle target and icon', () => {
    expect(practiceSource).toContain("import { X } from 'lucide-vue-next';");
    expect(practiceSource).toContain('<X class="practice__close-mark" :size="20"');
    expect(practiceSource).toMatch(
      /\.practice__close\s*{[^}]*width:\s*var\(--q-icon-control-size\);[^}]*min-width:\s*var\(--q-icon-control-size\);[^}]*height:\s*var\(--q-icon-control-size\);[^}]*line-height:\s*0;/s,
    );
    expect(practiceSource).toMatch(/\.practice__close--armed\s*{[^}]*width:\s*88px;/s);
  });
});
