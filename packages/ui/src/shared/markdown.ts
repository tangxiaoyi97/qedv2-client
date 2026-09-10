/**
 * Safe Markdown → token tree for short documents and AI explanations.
 *
 * Deliberately NOT a full parser and deliberately NOT HTML: the output is a
 * structured token array the renderer walks with plain Vue templates, so
 * nothing is ever fed to v-html. Supported subset:
 *   - # / ## / ### headings
 *   - unordered/ordered lists, continuation paragraphs and nested lists
 *   - blank-line separated paragraphs
 *   - inline: **bold**, `code`, [text](href), $…$ and \(…\) math
 *   - fenced/indented code, $$…$$ and \[…\] display math
 * Links are sanitized to http(s)/relative to keep javascript:/data: out.
 */

export interface InlineText {
  t: 'text';
  v: string;
}
export interface InlineBold {
  t: 'bold';
  v: string;
  content?: MdInline[];
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
  display?: boolean;
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
  start?: number;
  /** Present when items contain paragraphs, display math, code or nested lists. */
  itemBlocks?: MdBlock[][];
}
export interface MdCodeBlock {
  t: 'codeblock';
  v: string;
  language?: string;
}
export type MdBlock = MdHeading | MdParagraph | MdList | MdMathBlock | MdCodeBlock;

function safeHref(raw: string): string | null {
  const href = raw.trim();
  // Allow only http(s), protocol-relative, root/relative, and anchors.
  if (/^(https?:\/\/|\/\/|\/|#|\.{0,2}\/)/i.test(href)) return href;
  if (/^[\w./?=&%-]+$/.test(href)) return href; // bare relative path
  return null;
}

function escaped(source: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && source[--index] === '\\') slashes += 1;
  return slashes % 2 === 1;
}

function closing(source: string, delimiter: string, from: number): number {
  let index = source.indexOf(delimiter, from);
  while (index >= 0 && escaped(source, index)) index = source.indexOf(delimiter, index + delimiter.length);
  return index;
}

/** Read one complete math span. Missing boundaries remain visible as text. */
function mathAt(source: string, index: number, missingClosers?: Set<string>): { node: InlineMath; end: number } | undefined {
  const opening = source.startsWith('$$', index) ? '$$'
    : source.startsWith('\\[', index) ? '\\['
      : source.startsWith('\\(', index) ? '\\('
        : source[index] === '$' ? '$' : undefined;
  if (!opening) return undefined;
  const delimiter = opening === '\\[' ? '\\]' : opening === '\\(' ? '\\)' : opening;
  if (missingClosers?.has(delimiter)) return undefined;
  const start = index + opening.length;
  if (opening === '$' && (!source[start] || /\s/u.test(source[start]!) || source[index - 1] === '$')) return undefined;
  let end = closing(source, delimiter, start);
  if (opening === '$') {
    while (end >= 0 && (source[end - 1] === '$' || source[end + 1] === '$')) {
      end = closing(source, delimiter, end + 1);
    }
    if (end >= 0 && /\s/u.test(source[end - 1] ?? '')) return undefined;
  }
  if (end < 0) { missingClosers?.add(delimiter); return undefined; }
  if (!source.slice(start, end).trim()) return undefined;
  const value = source.slice(start, end);
  let after = end + delimiter.length;
  if (opening === '$$') {
    // Some replies end a display line with $$$. The old greedy regex put the
    // extra boundary dollar inside KaTeX. Tolerate that line-end boundary only;
    // never remove escaped currency or dollars from the formula itself.
    let runEnd = after;
    while (source[runEnd] === '$') runEnd += 1;
    if (/^[ \t]*(?:\n|$)/u.test(source.slice(runEnd))) after = runEnd;
  }
  return {
    node: { t: 'math', v: value.trim(), ...(opening === '$$' || opening === '\\[' ? { display: true } : {}) },
    end: after,
  };
}

function codeAt(source: string, index: number): { node: InlineCode; end: number } | undefined {
  if (source[index] !== '`') return undefined;
  const marker = /^`+/u.exec(source.slice(index))![0];
  let end = source.indexOf(marker, index + marker.length);
  while (end >= 0 && (source[end - 1] === '`' || source[end + marker.length] === '`')) {
    end = source.indexOf(marker, end + marker.length);
  }
  return end < 0 ? undefined : {
    node: { t: 'code', v: source.slice(index + marker.length, end).replace(/\n/g, ' ') },
    end: end + marker.length,
  };
}

function boldEnd(source: string, from: number): number {
  const missingClosers = new Set<string>();
  for (let index = from; index < source.length;) {
    const protectedSpan = codeAt(source, index) ?? mathAt(source, index, missingClosers);
    if (protectedSpan) { index = protectedSpan.end; continue; }
    if (source.startsWith('**', index) && !escaped(source, index)) return index;
    index += 1;
  }
  return -1;
}

/** Code is consumed before looking for math or emphasis inside it. */
export function parseInline(source: string): MdInline[] {
  const out: MdInline[] = [];
  // Once a delimiter is absent from this remaining suffix, later openers do
  // not need to scan that same suffix again (e.g. thousands of damaged \[).
  const missingClosers = new Set<string>();
  const text = (value: string) => {
    const last = out.at(-1);
    if (last?.t === 'text') last.v += value;
    else out.push({ t: 'text', v: value });
  };
  let index = 0;
  while (index < source.length) {
    if (source[index] === '`') {
      const code = codeAt(source, index);
      if (code) { out.push(code.node); index = code.end; continue; }
      const marker = /^`+/u.exec(source.slice(index))![0];
      text(marker); index += marker.length; continue;
    }
    const math = mathAt(source, index, missingClosers);
    if (math) { out.push(math.node); index = math.end; continue; }
    if (source.startsWith('$$', index) || source.startsWith('\\(', index) || source.startsWith('\\[', index)) {
      const marker = source.startsWith('$$', index) ? /^\$+/u.exec(source.slice(index))![0] : source.slice(index, index + 2);
      text(marker); index += marker.length; continue;
    }
    if (source[index] === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/u.test(source[index + 1] ?? '')) {
      text(source[index + 1]!); index += 2; continue;
    }
    if (source.startsWith('**', index)) {
      const end = boldEnd(source, index + 2);
      if (end > index + 2) {
        const value = source.slice(index + 2, end);
        const content = parseInline(value);
        out.push({ t: 'bold', v: value,
          ...(content.some((node) => node.t !== 'text') || content.map((node) => node.v).join('') !== value ? { content } : {}),
        });
        index = end + 2;
        continue;
      }
    }
    if (source[index] === '[') {
      const match = /^\[([^\]]+)\]\(([^)\s]+)\)/u.exec(source.slice(index));
      if (match) {
        const href = safeHref(match[2]!);
        if (href) out.push({ t: 'link', v: match[1]!, href });
        else text(match[1]!);
        index += match[0].length;
        continue;
      }
    }
    text(source[index]!); index += 1;
  }
  return out.length ? out : [{ t: 'text', v: source }];
}

function indent(line: string): number {
  return [...(/^[ \t]*/u.exec(line)?.[0] ?? '')].reduce((width, character) => width + (character === '\t' ? 4 : 1), 0);
}

function dedent(line: string, width: number): string {
  let index = 0;
  let removed = 0;
  while (removed < width && /[ \t]/u.test(line[index] ?? '')) removed += line[index++] === '\t' ? 4 : 1;
  return ' '.repeat(Math.max(0, removed - width)) + line.slice(index);
}

function listMarker(line: string) {
  const match = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/u.exec(line);
  if (!match || indent(match[1]!) > 3) return undefined;
  const ordered = /^\d/u.test(match[2]!);
  return { ordered, start: ordered ? Number.parseInt(match[2]!, 10) : 1,
    indent: indent(match[1]!), contentIndent: indent(match[1]!) + match[2]!.length + indent(match[3]!), content: match[4]! };
}

function fenceMarker(line: string) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  return match && !(match[1]![0] === '`' && match[2]!.includes('`')) ? match : null;
}

function displayBlock(lines: string[], start: number): { block: MdMathBlock; end: number } | undefined {
  if (indent(lines[start]!) > 3 || !/^(?:\$\$|\\\[)/u.test(lines[start]!.trimStart())) return undefined;
  // A damaged opener must not rescan the entire remaining document for every
  // following line. These generous display-block limits bound lookahead;
  // unmatched content remains ordinary text, never silently discarded.
  const content: string[] = [];
  let size = 0;
  for (let end = start; end < Math.min(lines.length, start + 128); end += 1) {
    const line = end === start ? lines[end]!.trimStart() : lines[end]!;
    size += line.length + 1;
    if (size > 16000) return undefined;
    content.push(line);
    if (!/(?:\${2,}|\\\])[ \t]*$/u.test(line)) continue;
    const source = content.join('\n');
    const math = mathAt(source, 0);
    if (math) {
      if (source.slice(math.end).trim()) return undefined;
      return { block: { t: 'mathblock', v: math.node.v }, end: end + 1 };
    }
  }
  return undefined;
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index]!;
  return Boolean(/^ {0,3}#{1,3}\s/u.test(line) || listMarker(line) || fenceMarker(line) || displayBlock(lines, index));
}

function parseLines(lines: string[], depth = 0): MdBlock[] {
  const blocks: MdBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    const fence = fenceMarker(line);
    if (fence) {
      const content: string[] = [];
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      index += 1;
      while (index < lines.length && !close.test(lines[index]!)) content.push(lines[index++]!);
      if (index < lines.length) index += 1;
      const language = fence[2]!.trim();
      blocks.push({ t: 'codeblock', v: content.join('\n'), ...(language ? { language } : {}) });
      continue;
    }
    if (indent(line) >= 4) {
      const content: string[] = [];
      while (index < lines.length && (!lines[index]!.trim() || indent(lines[index]!) >= 4)) content.push(dedent(lines[index++]!, 4));
      while (content.at(-1) === '') content.pop();
      blocks.push({ t: 'codeblock', v: content.join('\n') });
      continue;
    }
    const math = displayBlock(lines, index);
    if (math) { blocks.push(math.block); index = math.end; continue; }
    const heading = /^ {0,3}(#{1,3})\s+(.*)$/u.exec(line);
    if (heading) {
      blocks.push({ t: 'heading', level: heading[1]!.length as 1 | 2 | 3, content: parseInline(heading[2]!) });
      index += 1; continue;
    }
    const first = depth < 16 ? listMarker(line) : undefined;
    if (first) {
      const items: MdBlock[][] = [];
      while (index < lines.length) {
        const marker = listMarker(lines[index]!);
        if (!marker || marker.ordered !== first.ordered || marker.indent !== first.indent) break;
        const content = [marker.content];
        index += 1;
        while (index < lines.length) {
          const next = lines[index]!;
          if (!next.trim()) {
            let following = index + 1;
            while (following < lines.length && !lines[following]!.trim()) following += 1;
            if (following < lines.length && indent(lines[following]!) >= marker.contentIndent) {
              content.push(''); index += 1; continue;
            }
            const nextMarker = following < lines.length ? listMarker(lines[following]!) : undefined;
            if (nextMarker && nextMarker.indent === first.indent && nextMarker.ordered === first.ordered) index = following;
            break;
          }
          if (indent(next) >= marker.contentIndent) { content.push(dedent(next, marker.contentIndent)); index += 1; continue; }
          if (!startsBlock(lines, index)) { content.push(next.trim()); index += 1; continue; }
          break;
        }
        items.push(parseLines(content, depth + 1));
      }
      const simple = items.every((item) => item.length === 1 && item[0]?.t === 'paragraph');
      blocks.push({ t: 'list', ordered: first.ordered,
        items: items.map((item) => item[0]?.t === 'paragraph' ? item[0].content : []),
        ...(first.ordered && first.start !== 1 ? { start: first.start } : {}),
        ...(!simple ? { itemBlocks: items } : {}),
      });
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !startsBlock(lines, index)) paragraph.push(lines[index++]!.trim());
    blocks.push({ t: 'paragraph', content: parseInline(paragraph.join(' ')) });
  }
  return blocks;
}

export function parseMarkdown(src: string): MdBlock[] {
  return parseLines(src.replace(/\r\n?/g, '\n').split('\n'));
}
