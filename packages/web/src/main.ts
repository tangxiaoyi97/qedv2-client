import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/public-sans/800.css';
import '@qed2/ui/styles';
import './styles/app.css';
import App from './App.vue';
import { router } from './router.js';
import { useAppStore } from './stores/app.js';
import { useAuthStore } from './stores/auth.js';
import { useProgressStore } from './stores/progress.js';
import { useUiStore } from './stores/ui.js';

async function boot(): Promise<void> {
  const app = createApp(App);
  app.use(createPinia());
  app.use(router);

  // Ports/config first, then local archive, then token validation — the app
  // is fully usable as a guest even if the network never comes up.
  const appStore = useAppStore();
  await appStore.init();
  const progress = useProgressStore();
  await progress.init();
  const auth = useAuthStore();
  await auth.init();
  if (auth.isLoggedIn) void progress.syncNow({ quiet: true });

  app.mount('#app');

  // After mount: announce what changed if this is a new build (non-blocking).
  void useUiStore().checkForChangelog();
}

void boot();
