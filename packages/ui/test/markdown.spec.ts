import { describe, expect, it } from 'vitest';
import { parseMarkdown, parseInline } from '../src/shared/markdown.js';

describe('parseInline', () => {
  it('parses bold, code and safe links; keeps plain text', () => {
    const nodes = parseInline('a **b** `c` [d](https://x.test) e');
    expect(nodes).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'bold', v: 'b' },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'c' },
      { t: 'text', v: ' ' },
      { t: 'link', v: 'd', href: 'https://x.test' },
      { t: 'text', v: ' e' },
    ]);
  });

  it('drops unsafe-scheme links but keeps their text (injection gate)', () => {
    // The href is dropped and no link node is produced; text survives.
    const js = parseInline('before [x](javascript:alert1) after');
    expect(js.some((n) => n.t === 'link')).toBe(false);
    expect(js.map((n) => n.v).join('')).toContain('x');
    const data = parseInline('[y](data:text/html;base64,ZZ)');
    expect(data.some((n) => n.t === 'link')).toBe(false);
    expect(data.map((n) => n.v).join('')).toContain('y');
  });

  it('allows relative and anchor links', () => {
    expect(parseInline('[a](/practice)')[0]).toEqual({ t: 'link', v: 'a', href: '/practice' });
    expect(parseInline('[b](#top)')[0]).toEqual({ t: 'link', v: 'b', href: '#top' });
  });

  it('keeps code literal and escapes meaningful inside a bold span', () => {
    expect(parseInline('**`$x$ ** literal`**')).toEqual([
      { t: 'bold', v: '`$x$ ** literal`', content: [{ t: 'code', v: '$x$ ** literal' }] },
    ]);
    expect(parseInline(String.raw`**Preis \$5**`)).toEqual([
      { t: 'bold', v: String.raw`Preis \$5`, content: [{ t: 'text', v: 'Preis $5' }] },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('parses headings, lists and paragraphs', () => {
    const md = [
      '# Was ist neu',
      '',
      'Kurzer Absatz mit **fett**.',
      '',
      '- erstes',
      '- zweites',
      '',
      '1. eins',
      '2. zwei',
    ].join('\n');
    const blocks = parseMarkdown(md);
    expect(blocks[0]).toMatchObject({ t: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ t: 'paragraph' });
    expect(blocks[2]).toMatchObject({ t: 'list', ordered: false });
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2);
    expect(blocks[3]).toMatchObject({ t: 'list', ordered: true });
  });

  it('separates unordered and ordered lists into distinct blocks', () => {
    const blocks = parseMarkdown('- a\n1. b');
    expect(blocks.map((b) => b.t)).toEqual(['list', 'list']);
    expect((blocks[0] as { ordered: boolean }).ordered).toBe(false);
    expect((blocks[1] as { ordered: boolean }).ordered).toBe(true);
  });

  it('treats ### as a level-3 heading', () => {
    expect(parseMarkdown('### Detail')[0]).toMatchObject({ t: 'heading', level: 3 });
  });

  it('keeps repeated Markdown list markers together for automatic numbering', () => {
    expect(parseMarkdown('1. zuerst\n1. dann\n1. zuletzt')).toEqual([{
      t: 'list', ordered: true,
      items: [[{ t: 'text', v: 'zuerst' }], [{ t: 'text', v: 'dann' }], [{ t: 'text', v: 'zuletzt' }]],
    }]);
  });

  it('bounds nested lists and unmatched display lookahead without losing the final text', () => {
    const nested = Array.from({ length: 100 }, (_, index) => `${'  '.repeat(index)}- Schritt ${index}`).join('\n');
    expect(() => parseMarkdown(nested)).not.toThrow();
    expect(JSON.stringify(parseMarkdown(nested))).toContain('Schritt 99');
    const unmatched = Array.from({ length: 2000 }, () => '\\[offen').join('\n') + '\nEnde bleibt sichtbar';
    expect(JSON.stringify(parseMarkdown(unmatched))).toContain('Ende bleibt sichtbar');
  });
});

/**
 * Math support exists for AI explanations: the model is asked to write
 * formulas in KaTeX, so `$…$` has to become mathematics rather than dollar
 * signs on screen.
 */
describe('math', () => {
  it('accepts a redundant display closing dollar only at the formula boundary', () => {
    expect(parseMarkdown(String.raw`   $$\big(c\cdot x^3\big)'=3c\cdot x^2.$$$`)).toEqual([
      { t: 'mathblock', v: String.raw`\big(c\cdot x^3\big)'=3c\cdot x^2.` },
    ]);
    expect(parseMarkdown(String.raw`$$\text{Preis: \$5}$$`)).toEqual([
      { t: 'mathblock', v: String.raw`\text{Preis: \$5}` },
    ]);
  });

  it.each([
    ['$$\na+b=c\n$$', 'a+b=c'],
    ['\\[\n\\frac{a+b}{c+d}\n\\]', '\\frac{a+b}{c+d}'],
    ['\\[x^2\\]', 'x^2'],
  ])('reads a complete display block %s', (source, value) => {
    expect(parseMarkdown(source)).toEqual([{ t: 'mathblock', v: value }]);
  });

  it('reads parenthesized math without consuming escaped delimiters or code', () => {
    expect(parseInline(String.raw`Es gilt \(x+1\).`)).toEqual([
      { t: 'text', v: 'Es gilt ' }, { t: 'math', v: 'x+1' }, { t: 'text', v: '.' },
    ]);
    expect(parseInline(String.raw`\$5 und \$3`)).toEqual([{ t: 'text', v: '$5 und $3' }]);
    expect(parseInline('``$x$ and `code` ``')).toEqual([{ t: 'code', v: '$x$ and `code` ' }]);
  });

  it('leaves incomplete delimiters visible instead of inventing a missing formula boundary', () => {
    for (const source of ['$$x+1', '\\[x+1', '\\(x+1', '$x+1', 'x+1$$$']) {
      expect(parseMarkdown(source)).toEqual([{ t: 'paragraph', content: [{ t: 'text', v: source }] }]);
    }
  });

  it('protects fenced and indented code from all math parsing', () => {
    expect(parseMarkdown('```tex\n$x$\n\\[y\\]\n```')).toEqual([
      { t: 'codeblock', v: '$x$\n\\[y\\]', language: 'tex' },
    ]);
    expect(parseMarkdown('    $$x$$\n    \\(y\\)')).toEqual([
      { t: 'codeblock', v: '$$x$$\n\\(y\\)' },
    ]);
  });

  it('preserves the authored start of separated ordered lists', () => {
    const lists = parseMarkdown('3. Dritter Schritt\n\nZwischentext\n\n7. Siebter Schritt')
      .filter((block) => block.t === 'list');
    expect(lists).toMatchObject([{ start: 3 }, { start: 7 }]);
  });

  it('reads inline math out of a sentence', () => {
    const [block] = parseMarkdown('Also ist $x = 4$ die Lösung.');
    expect(block).toEqual({
      t: 'paragraph',
      content: [
        { t: 'text', v: 'Also ist ' },
        { t: 'math', v: 'x = 4' },
        { t: 'text', v: ' die Lösung.' },
      ],
    });
  });

  it('treats a $$…$$ line as display math', () => {
    expect(parseMarkdown('$$\\int_0^1 x\\,dx$$')).toEqual([
      { t: 'mathblock', v: '\\int_0^1 x\\,dx' },
    ]);
  });

  it('leaves a dollar sign inside code alone', () => {
    // Code is matched before math on purpose: `$x$` in backticks is literal.
    const [block] = parseMarkdown('Schreibe `$x$` für Formeln.');
    expect(block).toMatchObject({
      content: [
        { t: 'text', v: 'Schreibe ' },
        { t: 'code', v: '$x$' },
        { t: 'text', v: ' für Formeln.' },
      ],
    });
  });

  it('does not swallow a lone dollar sign', () => {
    // Prices and stray dollars must not eat the rest of the line.
    const [block] = parseMarkdown('Das kostet 5$ und mehr.');
    expect(block).toMatchObject({ content: [{ t: 'text', v: 'Das kostet 5$ und mehr.' }] });
  });

  it('does not turn two prices into a formula', () => {
    // Paragraph lines are joined before inline parsing, so a naive `$…$`
    // would make "5$ und 3$" into math. KaTeX's own rule — no space just
    // inside the delimiters — is what prevents it.
    for (const src of ['Das kostet 5$ und 3$ mehr.', 'Preis 5$\nund 3$ dazu.']) {
      expect(JSON.stringify(parseMarkdown(src)), src).not.toContain('"math"');
    }
  });

  it('still reads a formula that survived a soft line break', () => {
    // Lines are joined first, so this is one paragraph and one formula.
    const [block] = parseMarkdown('Es gilt $a +\nb = c$ hier.');
    expect(JSON.stringify(block)).toContain('"math"');
  });

  it('keeps working for changelogs, which contain no math', () => {
    const blocks = parseMarkdown('# QED2 1.9.7\n\nfixed: **something** and `code`.');
    expect(JSON.stringify(blocks)).not.toContain('"math"');
  });
});
