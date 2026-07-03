/**
 * RichText — the mixed-content format used throughout the question bank
 * (prompts, options, solutions, rubrics). Contract §1.1:
 *
 *   RichText = InlineNode[]
 *   InlineNode = {t:"text",v} | {t:"math",v} | {t:"fig",src,alt}
 *
 * `math` nodes carry KaTeX source. `fig` nodes carry a path relative to the
 * bank root; resolve against the core service's `/content/assets/` prefix.
 */
export interface TextNode {
  t: 'text';
  v: string;
}

export interface MathNode {
  t: 'math';
  v: string;
}

export interface FigNode {
  t: 'fig';
  src: string;
  alt?: string;
}

export type InlineNode = TextNode | MathNode | FigNode;

export type RichText = InlineNode[];

/** Plain-text projection (for previews, sorting, accessibility fallbacks). */
export function richTextToPlain(rt: RichText | undefined): string {
  if (!rt) return '';
  return rt
    .map((n) => (n.t === 'text' ? n.v : n.t === 'math' ? n.v : (n.alt ?? '')))
    .join('')
    .trim();
}
