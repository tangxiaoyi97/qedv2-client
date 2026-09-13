<script setup lang="ts">
import { ref } from 'vue';
import NodePanel from './NodePanel.vue';
import type { NodeKind } from './api.js';

const selected = ref<NodeKind>('server');
const status = ref({ server: '未连接', core: '未连接' });
const version = __APP_VERSION__;
</script>

<template>
  <a class="skip-link" href="#node-workspace">跳至管理区域</a>
  <header class="admin-header">
    <a href="/" class="wordmark" aria-label="返回 QED2 学习应用">QED<span>2</span></a>
    <span class="header-divider" aria-hidden="true"></span>
    <h1>节点管理</h1>
    <span class="header-version">Client {{ version }}</span>
  </header>
  <main class="admin-shell">
    <nav class="node-selector" aria-label="选择管理节点">
      <button type="button" :aria-pressed="selected === 'server'" @click="selected = 'server'">
        <span class="node-symbol" aria-hidden="true">S</span><span class="node-selector-copy"><strong>Server</strong><span>用户 · 统计 · 反馈</span></span><span class="node-state">{{ status.server }}</span>
      </button>
      <button type="button" :aria-pressed="selected === 'core'" @click="selected = 'core'">
        <span class="node-symbol" aria-hidden="true">C</span><span class="node-selector-copy"><strong>Core</strong><span>题库 · 验证 · 维护</span></span><span class="node-state">{{ status.core }}</span>
      </button>
    </nav>
    <div id="node-workspace" tabindex="-1">
      <NodePanel v-show="selected === 'server'" kind="server" @status="status.server = $event" />
      <NodePanel v-show="selected === 'core'" kind="core" @status="status.core = $event" />
    </div>
  </main>
</template>
