import { describe, expect, it } from 'vitest';

import progressSource from '../src/routes/ProgressView.vue?raw';

describe('ProgressView information density', () => {
  it('uses concise detail titles and helper copy', () => {
    expect(progressSource).toContain("return 'Bewertung';");
    expect(progressSource).toContain("t('Aktivität · {date}', { date: formatDayKey(selectedActivityDate.value) })");
    expect(progressSource).toContain("return 'Kompetenzen';");
    expect(progressSource).toContain("return 'Bereiche';");
    expect(progressSource).toContain('Core nicht erreichbar · IDs statt Titel.');
    expect(progressSource).toContain("{{ gradedPartCount }} {{ t('Teile') }}");
    expect(progressSource).toContain("<span>{{ t('Durchschnitt') }}</span>");
    expect(progressSource).toContain('Noch kein Fortschritt.');

    expect(progressSource).not.toContain('Details · Bewertung nach Status');
    expect(progressSource).not.toContain('Details · Aktivität');
    expect(progressSource).not.toContain('Details · Kompetenz-Radar');
    expect(progressSource).not.toContain('Details · Nach Bereich');
    expect(progressSource).not.toContain('Teile mit Status');
    expect(progressSource).not.toContain('Durchschnitt nach Bereich');
    expect(progressSource).not.toContain('Noch kein Fortschritt —');
  });

  it('shows a part id only as the title fallback and avoids repeating it below a real title', () => {
    expect(progressSource).toContain('title: meta?.title ?? part.partId');
    expect(progressSource).toContain('v-if="row.codes.length > 0" class="prog-modal__row-sub"');
    expect(progressSource).toContain("{{ row.codes.join(', ') }}");
    expect(progressSource).not.toContain('{{ row.partId }}');
  });
});
