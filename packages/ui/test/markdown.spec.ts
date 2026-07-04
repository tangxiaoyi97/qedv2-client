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
