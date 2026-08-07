import { describe, expect, it } from 'vitest';

import authSource from '../src/routes/AuthModal.vue?raw';
import practiceSource from '../src/routes/PracticeView.vue?raw';
import progressSource from '../src/routes/ProgressView.vue?raw';
import settingsSource from '../src/routes/SettingsView.vue?raw';

describe('close control consistency', () => {
  it('uses the shared close control on auth, detail and practice surfaces', () => {
    expect(authSource.match(/<QIconButton\b/g)).toHaveLength(2);
    expect(settingsSource).toContain('<QIconButton aria-label="Schließen" data-autofocus');
    expect(progressSource).toContain('<QIconButton aria-label="Schließen" data-autofocus');
    expect(practiceSource).toContain('<QIconButton\n        data-practice-exit');
    expect(practiceSource).toContain('QIconButton,');

    for (const source of [authSource, settingsSource, progressSource, practiceSource]) {
      expect(source).not.toContain('q-dialog-close');
      expect(source).not.toMatch(/<button[^>]*>\s*✕\s*<\/button>/s);
    }
    expect(practiceSource).not.toMatch(/import\s*{[^}]*\bX\b[^}]*}\s*from 'lucide-vue-next';/s);
    expect(practiceSource).not.toContain('practice__close-mark');
  });
});
