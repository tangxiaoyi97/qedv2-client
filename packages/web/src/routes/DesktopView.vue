<script setup lang="ts">
/**
 * Native-shell control centre. The route guard prevents this module from
 * resolving on Web/PWA; the local capability check is a second, render-level
 * fail-closed boundary for direct mounts and future router changes.
 */
import DesktopSettings from './settings/DesktopSettings.vue';
import { ports } from '../services.js';

withDefaults(defineProps<{
  panel?: 'overview' | 'updates' | 'node';
}>(), {
  panel: 'overview',
});

const isDesktopShell = ports.shell.capabilities.desktop;
</script>

<template>
  <div
    v-if="isDesktopShell"
    class="desktop-view q-page"
    data-desktop-control-center
  >
    <h1 v-if="panel === 'overview'" class="desktop-view__title q-page-title">Desktop</h1>
    <DesktopSettings :panel="panel" />
  </div>
</template>

<style scoped>
.desktop-view {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.desktop-view__title {
  margin-bottom: 4px;
}
</style>
