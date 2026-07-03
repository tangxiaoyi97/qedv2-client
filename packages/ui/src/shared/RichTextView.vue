<script setup lang="ts">
/**
 * Renders a RichText node array: German prose, inline/display KaTeX and
 * embedded figures, mixed naturally (supplement §0).
 *
 * A math node is promoted to display mode when it is the only node or when
 * its source uses obviously block-level constructs — the bank encodes both
 * inline and standalone formulas as the same node type.
 */
import { computed } from 'vue';
import type { RichText, InlineNode } from '@qed2/core-logic';
import MathText from './MathText.vue';
import { useAssetResolver } from './assets.js';

const props = defineProps<{
  nodes: RichText | undefined;
  /** Force every math node inline (e.g. inside chips or option rows). */
  inlineOnly?: boolean;
}>();

const resolveAsset = useAssetResolver();

function isDisplayMath(node: InlineNode, idx: number, all: readonly InlineNode[]): boolean {
  if (props.inlineOnly) return false;
  if (node.t !== 'math') return false;
  if (all.length === 1) return true;
  // standalone if surrounded by paragraph-ish boundaries (newline-ended text)
  const prev = all[idx - 1];
  const next = all[idx + 1];
  const prevBreak = !prev || (prev.t === 'text' && /\n\s*$/.test(prev.v));
  const nextBreak = !next || (next.t === 'text' && /^\s*\n/.test(next.v));
  const longSource = node.v.length > 48 || /\\\\|\\begin|\\displaystyle/.test(node.v);
  return (prevBreak && nextBreak) || longSource;
}

const items = computed(() =>
  (props.nodes ?? []).map((node, idx, all) => ({
    node,
    display: isDisplayMath(node, idx, all),
    key: idx,
  })),
);
</script>

<template>
  <span class="q-richtext">
    <template v-for="item in items" :key="item.key">
      <template v-if="item.node.t === 'text'">{{ item.node.v }}</template>
      <MathText v-else-if="item.node.t === 'math'" :src="item.node.v" :display="item.display" />
      <span v-else class="q-richtext__fig">
        <img
          class="q-richtext__img"
          :src="resolveAsset(item.node.src)"
          :alt="item.node.alt ?? ''"
          loading="lazy"
        />
      </span>
    </template>
  </span>
</template>

<style scoped>
.q-richtext {
  white-space: pre-line;
  overflow-wrap: break-word;
}
.q-richtext__fig {
  display: block;
  margin: 12px 0;
}
.q-richtext__img {
  max-width: 100%;
  border: 1px solid var(--q-border);
  border-radius: 10px;
  background: #fff;
  display: block;
  margin: 0 auto;
}
</style>
