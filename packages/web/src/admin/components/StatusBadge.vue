<script setup lang="ts">
defineProps<{ value?: string | null }>();
const labels: Record<string, string> = { running: '运行中', active: '启用', available: '可用', enabled: '启用', disabled: '停用', revoked: '已撤销', used: '已使用', expired: '已过期', open: '待处理', in_progress: '处理中', resolved: '已解决', requested: '已请求', succeeded: '成功', failed: '失败' };
</script>
<template><span class="status-pill" :class="{ 'status-negative': ['disabled', 'revoked', 'failed', 'expired'].includes(value ?? '') }">{{ labels[value ?? ''] ?? value ?? '—' }}</span></template>
