<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue';
import { numberText, type ManagementClient } from '../api.js';
import type { Usage } from '../server-types.js';
import { useRequest } from '../useRequest.js';
import RequestState from '../components/RequestState.vue';
import UsageChart from '../components/UsageChart.vue';
const props = defineProps<{ client: ManagementClient }>();
const emit = defineEmits<{ sessionLost: [] }>();
const { busy, error, run, cancel } = useRequest(props.client, () => emit('sessionLost'));
const days = ref(7), result = shallowRef<Usage>();
async function load() { result.value = undefined; await run((signal) => props.client.request<Usage>(`/ai/usage?days=${days.value}`, undefined, true, undefined, signal), (value) => { result.value = value; }); }
onMounted(load);
</script>
<template><div class="panel-toolbar"><h3>AI 用量</h3><button type="button" :disabled="busy" @click="load">刷新</button></div><form class="filter-bar" @submit.prevent="load"><label for="usage-days">时间范围</label><select id="usage-days" v-model.number="days"><option :value="7">近 7 天</option><option :value="30">近 30 天</option><option :value="90">近 90 天</option></select><button type="submit">查询</button></form><RequestState :busy="busy" :error="error" @cancel="cancel" /><template v-if="result"><div class="metric-grid"><div class="metric"><span>AI 请求</span><strong>{{ numberText(result.calls) }}</strong><small>失败 {{ numberText(result.failed) }} 次</small></div><div class="metric"><span>输入 / 输出 Token</span><strong class="compact-value">{{ numberText(result.inputTokens) }} / {{ numberText(result.outputTokens) }}</strong></div><div class="metric"><span>共享池费用（美分）</span><strong>{{ numberText(result.poolCostCents) }}</strong></div><div class="metric"><span>用户密钥估算费用（美分）</span><strong>{{ numberText(result.byoEstimatedCostCents) }}</strong></div></div><UsageChart :days="result.byDay" /><div class="table-wrap" tabindex="0" role="region" aria-label="每日 AI 用量，可横向滚动"><table><caption class="sr-only">每日 AI 用量</caption><thead><tr><th scope="col">日期（UTC）</th><th scope="col" class="numeric">请求</th><th scope="col" class="numeric">失败</th><th scope="col" class="numeric">输入 Token</th><th scope="col" class="numeric">输出 Token</th><th scope="col" class="numeric">共享池费用（美分）</th><th scope="col" class="numeric">用户密钥估算（美分）</th></tr></thead><tbody><tr v-for="day in result.byDay" :key="day.date"><th scope="row">{{ day.date }}</th><td class="numeric">{{ numberText(day.calls) }}</td><td class="numeric">{{ numberText(day.failed) }}</td><td class="numeric">{{ numberText(day.inputTokens) }}</td><td class="numeric">{{ numberText(day.outputTokens) }}</td><td class="numeric">{{ numberText(day.poolCostCents) }}</td><td class="numeric">{{ numberText(day.byoEstimatedCostCents) }}</td></tr><tr v-if="!result.byDay.length"><td colspan="7" class="empty-cell">该时间范围内没有 AI 调用。</td></tr></tbody></table></div></template></template>
