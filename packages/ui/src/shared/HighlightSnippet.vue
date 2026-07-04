<script setup lang="ts">
/**
 * Renders a core search highlight snippet. The snippet arrives HTML-escaped
 * with literal <em> tags around hits (search upgrade doc §3). Defense in
 * depth: we NEVER use v-html — the string is split on the <em>/</em> tokens
 * (the only whitelisted markup) and rendered as text + <em> nodes, so any
 * other tag stays visible as inert text instead of becoming markup.
 */
import { computed } from 'vue';

const props = defineProps<{ snippet: string }>();

/** &-entities the core escaper produces; everything else stays literal. */
function unescapeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const parts = computed(() => {
  const out: { text: string; hit: boolean }[] = [];
  const tokens = props.snippet.split(/(<em>|<\/em>)/);
  let inHit = false;
  for (const token of tokens) {
    if (token === '<em>') {
      inHit = true;
    } else if (token === '</em>') {
      inHit = false;
    } else if (token !== '') {
      out.push({ text: unescapeEntities(token), hit: inHit });
    }
  }
  return out;
});
</script>

<template>
  <span class="q-snippet">
    <template v-for="(part, i) in parts" :key="i">
      <em v-if="part.hit" class="q-snippet__hit">{{ part.text }}</em>
      <template v-else>{{ part.text }}</template>
    </template>
  </span>
</template>

<style scoped>
.q-snippet {
  font-size: 12px;
  color: var(--q-mut-2);
  line-height: 1.5;
}
.q-snippet__hit {
  font-style: normal;
  font-weight: 700;
  color: var(--q-ink);
  background: var(--q-chip-bg);
  border-radius: 3px;
  padding: 0 2px;
}
</style>
