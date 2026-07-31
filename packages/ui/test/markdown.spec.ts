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
});

/**
 * Math support exists for AI explanations: the model is asked to write
 * formulas in KaTeX, so `$…$` has to become mathematics rather than dollar
 * signs on screen.
 */
describe('math', () => {
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
