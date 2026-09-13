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
    <span>节点管理</span>
    <span class="header-version">Client {{ version }}</span>
  </header>
  <main class="admin-shell">
    <div class="page-heading">
      <div><p class="eyebrow">管理工作台</p><h1>两个节点，各自独立。</h1>
        <p class="muted">选择节点并登录。一个节点离线时，另一个节点的管理仍然可用。</p></div>
      <a class="text-link" href="/">返回学习应用 <span aria-hidden="true">↗</span></a>
    </div>
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
    <footer class="admin-footer">凭据仅保存在当前页面内存中。刷新或关闭页面后，需要重新登录。</footer>
  </main>
</template>
