/**
 * Tiny, safe Markdown → token tree for trusted short documents (changelogs).
 *
 * Deliberately NOT a full parser and deliberately NOT HTML: the output is a
 * structured token array the renderer walks with plain Vue templates, so
 * nothing is ever fed to v-html. Supported subset:
 *   - # / ## / ### headings
 *   - - / * unordered lists, 1. ordered lists (single level)
 *   - blank-line separated paragraphs
 *   - inline: **bold**, `code`, [text](href)
 * Links are sanitized to http(s)/relative to keep javascript:/data: out.
 */

export interface InlineText {
  t: 'text';
  v: string;
}
export interface InlineBold {
  t: 'bold';
  v: string;
}
export interface InlineCode {
  t: 'code';
  v: string;
}
export interface InlineLink {
  t: 'link';
  v: string;
  href: string;
}
/**
 * Inline math, `$…$`.
 *
 * Added for AI explanations: the model is asked to write formulas in KaTeX, so
 * without this an explanation reads "also ist $x = 4$" with the dollars intact.
 * Changelogs simply never contain a `$…$` pair, so the same parser serves both.
 */
export interface InlineMath {
  t: 'math';
  v: string;
}

export type MdInline = InlineText | InlineBold | InlineCode | InlineLink | InlineMath;

export interface MdHeading {
  t: 'heading';
  level: 1 | 2 | 3;
  content: MdInline[];
}
export interface MdParagraph {
  t: 'paragraph';
  content: MdInline[];
}
/** Display math on its own line, `$$…$$`. */
export interface MdMathBlock {
  t: 'mathblock';
  v: string;
}

export interface MdList {
  t: 'list';
  ordered: boolean;
  items: MdInline[][];
}
export type MdBlock = MdHeading | MdParagraph | MdList | MdMathBlock;

function safeHref(raw: string): string | null {
  const href = raw.trim();
  // Allow only http(s), protocol-relative, root/relative, and anchors.
  if (/^(https?:\/\/|\/\/|\/|#|\.{0,2}\/)/i.test(href)) return href;
  if (/^[\w./?=&%-]+$/.test(href)) return href; // bare relative path
  return null;
}

/** Parse inline markup within a single line. */
export function parseInline(line: string): MdInline[] {
  const out: MdInline[] = [];
  /*
   * One regex, alternation ordered so the first match wins per position.
   *
   * Code comes BEFORE math: `$x$` inside backticks is a literal dollar sign.
   *
   * Math borrows KaTeX's own heuristic — no whitespace directly after the
   * opening `$` or directly before the closing one. Without it, a paragraph
   * saying "kostet 5$ und 3$ mehr" turns the middle into a formula, because
   * paragraph lines are joined before this runs and a `\n` guard would never
   * see anything.
   */
  const re =
    /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\$(\S|\S[^$]*?\S)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push({ t: 'text', v: line.slice(last, m.index) });
    if (m[1] !== undefined) {
      out.push({ t: 'bold', v: m[1] });
    } else if (m[2] !== undefined) {
      out.push({ t: 'code', v: m[2] });
    } else if (m[3] !== undefined && m[4] !== undefined) {
      const href = safeHref(m[4]);
      if (href) out.push({ t: 'link', v: m[3], href });
      else out.push({ t: 'text', v: m[3] }); // drop unsafe link, keep text
    } else if (m[5] !== undefined) {
      out.push({ t: 'math', v: m[5] });
    }
    last = re.lastIndex;
  }
  if (last < line.length) out.push({ t: 'text', v: line.slice(last) });
  return out.length > 0 ? out : [{ t: 'text', v: line }];
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ t: 'paragraph', content: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      blocks.push({
        t: 'list',
        ordered: list.ordered,
        items: list.items.map((i) => parseInline(i)),
      });
      list = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    // A line that is nothing but `$$…$$` is display math.
    const mathBlock = /^\$\$(.+)\$\$$/.exec(line.trim());
    if (mathBlock?.[1]) {
      flushParagraph();
      flushList();
      blocks.push({ t: 'mathblock', v: mathBlock[1].trim() });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        t: 'heading',
        level: heading[1]!.length as 1 | 2 | 3,
        content: parseInline(heading[2]!),
      });
      continue;
    }
    if (ul || ol) {
      flushParagraph();
      const ordered = Boolean(ol);
      const item = (ul ? ul[1] : ol![1])!;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(item);
      continue;
    }
    // plain text → paragraph (ends any open list)
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}
