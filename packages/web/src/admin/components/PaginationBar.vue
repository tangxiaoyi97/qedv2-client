<script setup lang="ts">
import { computed } from 'vue';
import { numberText, type Page } from '../api.js';
const props = defineProps<{ result: Page<unknown>; busy?: boolean }>();
defineEmits<{ change: [page: number] }>();
const pages = computed(() => Math.max(1, Math.ceil(props.result.total / props.result.pageSize)));
</script>
<template><nav class="pagination" aria-label="列表分页"><span>共 {{ numberText(result.total) }} 条 · 第 {{ result.page }} / {{ pages }} 页</span><div class="actions"><button type="button" :disabled="busy || result.page <= 1" @click="$emit('change', 1)">首页</button><button type="button" :disabled="busy || result.page <= 1" @click="$emit('change', result.page - 1)">上一页</button><button type="button" :disabled="busy || result.page >= pages" @click="$emit('change', result.page + 1)">下一页</button></div></nav></template>
