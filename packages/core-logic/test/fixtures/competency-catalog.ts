import type { CompetencyAreaCode, CompetencyCatalog, CompetencyGroup, CompetencyLocale } from '../../src/model/competency-catalog.js';

/** Synthetic curriculum: tests refer to no copied production catalog. */
export function competencyCatalogFixture(locale: CompetencyLocale = 'de'): CompetencyCatalog {
  function group(code: string, numbers: number[]): CompetencyGroup {
    return {
      code, title: `Group ${code}`, pages: [2],
      competencies: numbers.map((n) => ({ code: `${code}.${n}`, text: `Definition ${code}.${n}: $\\frac{a}{b}$`, pages: [2] })),
      comments: [{ text: `Group comment ${code}`, pages: [2] }], footnotes: [],
    };
  }
  const areas = (['AG', 'FA', 'AN', 'WS'] as CompetencyAreaCode[]).map((code) => ({
    code, title: `Area ${code}`, introduction: [{ text: `Introduction ${code}`, pages: [1] }],
    groups: [group(`${code} 1`, [1, 2])],
  }));
  const fa = areas[1]!.groups[0]!;
  fa.competencies[0]!.footnoteRefs = ['*'];
  fa.footnotes = [{ marker: '*', text: 'A graph definition', pages: [2], competencyCodes: ['FA 1.1'] }];
  const ws = areas[3]!;
  ws.groups[0]!.comments.unshift({ text: 'Only WS 1.1', pages: [2], competencyCodes: ['WS 1.1'] });
  const ws2 = group('WS 2', [3, 4]);
  ws2.comments = [{ text: 'Only WS 2.3', pages: [2], competencyCodes: ['WS 2.3'] }];
  const ws3 = group('WS 3', [4, 5]);
  for (const entry of ws3.competencies) entry.footnoteRefs = ['**'];
  ws3.footnotes = [{
    marker: '**', text: 'Valid from May 2027', pages: [2], competencyCodes: ['WS 3.4', 'WS 3.5'],
    effectiveFrom: { examSession: 'Haupttermin 2026/27', date: '2027-05' },
  }];
  ws.groups.push(ws2, ws3);
  return {
    schemaVersion: 1, id: 'srdp-mathematics-ahs', locale, version: '2024-11', textFormat: 'markdown+latex',
    title: `Official curriculum (${locale})`, subtitle: 'A test fixture',
    source: { url: 'https://example.test/official.pdf?document=1', sha256: 'a'.repeat(64), pageCount: 15, versionLabel: 'November 2024' },
    areas,
    contexts: { title: 'Contexts', blocks: [
      { type: 'paragraph', text: 'An example context', pages: [13] },
      { type: 'heading', text: 'Formula', pages: [13] },
      { type: 'equation', latex: 'K_n = K_0 \\cdot (1+i)^n', pages: [14] },
      { type: 'table', headers: [], rows: [['Density', '$\\varrho = \\frac{m}{V}$'], ['', '']], pages: [14] },
    ] },
  };
}
