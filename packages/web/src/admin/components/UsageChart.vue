<script setup lang="ts">
import { computed } from 'vue';
import { numberText } from '../api.js';
import type { UsageDay } from '../server-types.js';
const props = defineProps<{ days: UsageDay[] }>();
const positions = computed(() => {
  const stamps = props.days.map((day) => Date.parse(day.date));
  const first = Math.min(...stamps), last = Math.max(...stamps), count = Math.max(1, (last - first) / 86_400_000 + 1);
  return props.days.map((day, index) => ({ day, left: Number.isFinite(first) ? (stamps[index]! - first) / 86_400_000 / count * 100 : index / props.days.length * 100, width: 100 / count }));
});
const maximum = computed(() => Math.max(0, ...props.days.map((day) => day.calls)));
</script>
<template><figure v-if="days.length" class="usage-chart"><figcaption>每日 AI 请求 <span class="muted">· UTC · 最高 {{ numberText(maximum) }} 次</span></figcaption><div class="chart-bars" aria-hidden="true"><div v-for="{ day, left, width } in positions" :key="day.date" class="chart-column" :style="{ left: `${left}%`, width: `${width}%` }" :title="`${day.date}：${day.calls} 次，失败 ${day.failed} 次`"><div class="chart-bar" :style="{ height: `${day.calls / Math.max(1, maximum) * 100}%` }"></div><div class="chart-failed" :style="{ height: `${day.failed / Math.max(1, maximum) * 100}%` }"></div></div></div><div class="chart-axis" aria-hidden="true"><span>{{ days[0]?.date }}</span><span>{{ days.at(-1)?.date }}</span></div><p class="field-hint">实色为请求数，斜线为失败数。精确数值见下表。</p></figure></template>
