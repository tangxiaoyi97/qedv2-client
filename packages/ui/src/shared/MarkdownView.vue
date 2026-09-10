<script setup lang="ts">
/**
 * Renders a short Markdown document via the safe token tree from markdown.ts —
 * never v-html. Links open in a new tab with rel="noopener".
 *
 * Used for changelogs and for AI explanations. The latter contain KaTeX, which
 * is why `$…$` and `$$…$$` are part of the token tree: an explanation that
 * says "also ist $x = 4$" has to render as mathematics, not as dollar signs.
 * MathText already fails soft on bad input, so a malformed formula degrades to
 * readable source instead of breaking the page.
 */
import { computed, defineComponent, h, type PropType, type VNodeChild } from 'vue';
import MathText from './MathText.vue';
import { parseMarkdown, type MdBlock, type MdInline } from './markdown.js';

const props = defineProps<{ source: string }>();

const blocks = computed(() => parseMarkdown(props.source));

function inline(nodes: MdInline[]): VNodeChild[] {
  return nodes.map((node): VNodeChild => {
    switch (node.t) {
      case 'bold': return h('strong', node.content ? inline(node.content) : node.v);
      case 'code': return h('code', { class: 'q-md__code' }, node.v);
      case 'math': return h(MathText, { src: node.v, display: node.display });
      case 'link': return h('a', { href: node.href, target: '_blank', rel: 'noopener' }, node.v);
      default: return node.v;
    }
  });
}

function renderBlocks(content: MdBlock[]): VNodeChild[] {
  return content.map((block): VNodeChild => {
    switch (block.t) {
      case 'heading': return h(`h${block.level}`, { class: ['q-md__h', `q-md__h${block.level}`] }, inline(block.content));
      case 'paragraph': return h('p', { class: 'q-md__p' }, inline(block.content));
      case 'mathblock': return h('div', { class: 'q-md__mathblock' }, [h(MathText, { src: block.v, display: true })]);
      case 'codeblock': return h('pre', { class: 'q-md__pre' }, [h('code', block.v)]);
      case 'list': return h(block.ordered ? 'ol' : 'ul', {
        class: block.ordered ? 'q-md__ol' : 'q-md__ul',
        ...(block.ordered && block.start !== undefined ? { start: block.start } : {}),
      }, block.items.map((item, index) => h('li', block.itemBlocks?.[index]
        ? renderBlocks(block.itemBlocks[index]!) : inline(item))));
    }
  });
}

const MarkdownBlocks = defineComponent({
  props: { content: { type: Array as PropType<MdBlock[]>, required: true } },
  setup(blockProps) { return () => renderBlocks(blockProps.content); },
});
</script>

<template>
  <div class="q-md">
    <MarkdownBlocks :content="blocks" />
  </div>
</template>

<style scoped>
.q-md {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--q-ink-2);
}
.q-md :deep(.q-md__h) {
  font-weight: 800;
  color: var(--q-ink);
  letter-spacing: -0.01em;
  margin: 14px 0 8px;
}
.q-md :deep(.q-md__h:first-child) {
  margin-top: 0;
}
.q-md :deep(.q-md__h1) {
  font-size: 18px;
}
.q-md :deep(.q-md__h2) {
  font-size: 15px;
}
.q-md :deep(.q-md__h3) {
  font-size: 13.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--q-mut);
}
/* Display math gets room and scrolls on its own rather than widening the
 * page — a long derivation on a phone is otherwise unreadable or, worse,
 * pans the whole layout. */
.q-md :deep(.q-md__mathblock) {
  min-width: 0;
  max-width: 100%;
  margin: 10px 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.q-md :deep(.q-md__p) {
  margin: 8px 0;
}
.q-md :deep(.q-md__ul),
.q-md :deep(.q-md__ol) {
  margin: 8px 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.q-md :deep(li) { min-width: 0; }
.q-md :deep(li > .q-md__p:first-child) { margin-top: 0; }
.q-md :deep(li > .q-md__p:last-child) { margin-bottom: 0; }
.q-md :deep(.q-md__code) {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 0.88em;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 4px;
  padding: 1px 5px;
}
.q-md :deep(.q-md__pre) {
  max-width: 100%;
  overflow-x: auto;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--q-panel);
  font-family: ui-monospace, Menlo, monospace;
  font-size: 0.88em;
  white-space: pre;
  overflow-wrap: normal;
}
.q-md :deep(a) {
  color: var(--q-accent-strong);
  font-weight: 600;
}
</style>
