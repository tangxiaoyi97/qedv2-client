<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { ManagementClient } from './api.js';
import type { ServerInfo } from './server-types.js';
import { useRequest } from './useRequest.js';
import RequestState from './components/RequestState.vue';
import OverviewSection from './sections/OverviewSection.vue';
import UsersSection from './sections/UsersSection.vue';
import InvitesSection from './sections/InvitesSection.vue';
import UsageSection from './sections/UsageSection.vue';
import FeedbackSection from './sections/FeedbackSection.vue';
import AuditSection from './sections/AuditSection.vue';
const props = defineProps<{ client: ManagementClient }>();
const emit = defineEmits<{ sessionLost: []; restart: [] }>();
const { busy, error, run, cancel } = useRequest(props.client, () => emit('sessionLost'));
const info = shallowRef<ServerInfo>(), tab = ref('overview');
const capabilities = computed(() => info.value?.management?.capabilities ?? {});
const tabs = [{ id: 'overview', label: '概览' }, { id: 'users', label: '用户' }, { id: 'invites', label: '邀请码' }, { id: 'usage', label: 'AI 用量' }, { id: 'feedback', label: '反馈' }, { id: 'audit', label: '日志' }] as const;
function available(value: string) { return value === 'overview' || capabilities.value[value === 'usage' ? 'aiUsage' : value as 'users'] === true; }
async function loadInfo() { await run((signal) => props.client.request<ServerInfo>('/info', undefined, true, undefined, signal), (value) => { info.value = value; if (!available(tab.value)) tab.value = 'overview'; }); }
function select(value: string) { if (available(value)) tab.value = value; }
onMounted(loadInfo);
</script>
<template><nav class="section-nav" aria-label="Server 管理功能"><button v-for="item in tabs" :key="item.id" type="button" :aria-pressed="tab === item.id" :disabled="!available(item.id)" :title="available(item.id) ? undefined : '该节点未开放此能力'" @click="select(item.id)">{{ item.label }}</button></nav><RequestState :busy="busy" :error="error" @cancel="cancel" /><button v-if="!info && !busy" type="button" @click="loadInfo">重新获取节点信息</button><template v-if="info"><OverviewSection v-if="tab === 'overview'" :client="client" :info="info" @session-lost="$emit('sessionLost')" @restart="$emit('restart')" @refresh-info="loadInfo" /><UsersSection v-else-if="tab === 'users'" :client="client" :capabilities="capabilities" @session-lost="$emit('sessionLost')" /><InvitesSection v-else-if="tab === 'invites'" :client="client" :capabilities="capabilities" @session-lost="$emit('sessionLost')" /><UsageSection v-else-if="tab === 'usage'" :client="client" @session-lost="$emit('sessionLost')" /><FeedbackSection v-else-if="tab === 'feedback'" :client="client" :capabilities="capabilities" @session-lost="$emit('sessionLost')" /><AuditSection v-else-if="tab === 'audit'" :client="client" :capabilities="capabilities" @session-lost="$emit('sessionLost')" /></template></template>
