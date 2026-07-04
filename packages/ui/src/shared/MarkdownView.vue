<script setup lang="ts">
/**
 * Renders a trusted short Markdown document (changelogs) via the safe token
 * tree from markdown.ts — never v-html. Links open in a new tab with
 * rel="noopener".
 */
import { computed } from 'vue';
import { parseMarkdown } from './markdown.js';

const props = defineProps<{ source: string }>();

const blocks = computed(() => parseMarkdown(props.source));
</script>

<template>
  <div class="q-md">
    <template v-for="(block, bi) in blocks" :key="bi">
      <component
        :is="`h${block.level}`"
        v-if="block.t === 'heading'"
        class="q-md__h"
        :class="`q-md__h${block.level}`"
      >
        <template v-for="(node, ni) in block.content" :key="ni">
          <strong v-if="node.t === 'bold'">{{ node.v }}</strong>
          <code v-else-if="node.t === 'code'" class="q-md__code">{{ node.v }}</code>
          <a v-else-if="node.t === 'link'" :href="node.href" target="_blank" rel="noopener">{{ node.v }}</a>
          <template v-else>{{ node.v }}</template>
        </template>
      </component>

      <ul v-else-if="block.t === 'list' && !block.ordered" class="q-md__ul">
        <li v-for="(item, ii) in block.items" :key="ii">
          <template v-for="(node, ni) in item" :key="ni">
            <strong v-if="node.t === 'bold'">{{ node.v }}</strong>
            <code v-else-if="node.t === 'code'" class="q-md__code">{{ node.v }}</code>
            <a v-else-if="node.t === 'link'" :href="node.href" target="_blank" rel="noopener">{{ node.v }}</a>
            <template v-else>{{ node.v }}</template>
          </template>
        </li>
      </ul>

      <ol v-else-if="block.t === 'list' && block.ordered" class="q-md__ol">
        <li v-for="(item, ii) in block.items" :key="ii">
          <template v-for="(node, ni) in item" :key="ni">
            <strong v-if="node.t === 'bold'">{{ node.v }}</strong>
            <code v-else-if="node.t === 'code'" class="q-md__code">{{ node.v }}</code>
            <a v-else-if="node.t === 'link'" :href="node.href" target="_blank" rel="noopener">{{ node.v }}</a>
            <template v-else>{{ node.v }}</template>
          </template>
        </li>
      </ol>

      <p v-else-if="block.t === 'paragraph'" class="q-md__p">
        <template v-for="(node, ni) in block.content" :key="ni">
          <strong v-if="node.t === 'bold'">{{ node.v }}</strong>
          <code v-else-if="node.t === 'code'" class="q-md__code">{{ node.v }}</code>
          <a v-else-if="node.t === 'link'" :href="node.href" target="_blank" rel="noopener">{{ node.v }}</a>
          <template v-else>{{ node.v }}</template>
        </template>
      </p>
    </template>
  </div>
</template>

<style scoped>
.q-md {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--q-ink-2);
}
.q-md__h {
  font-weight: 800;
  color: var(--q-ink);
  letter-spacing: -0.01em;
  margin: 14px 0 8px;
}
.q-md__h:first-child {
  margin-top: 0;
}
.q-md__h1 {
  font-size: 18px;
}
.q-md__h2 {
  font-size: 15px;
}
.q-md__h3 {
  font-size: 13.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--q-mut);
}
.q-md__p {
  margin: 8px 0;
}
.q-md__ul,
.q-md__ol {
  margin: 8px 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.q-md__code {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 0.88em;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 4px;
  padding: 1px 5px;
}
.q-md a {
  color: var(--q-accent-strong);
  font-weight: 600;
}
</style>
