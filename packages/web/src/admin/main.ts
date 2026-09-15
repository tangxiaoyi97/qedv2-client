// Independent entry: no learner store, user login, router or bank.
import { createApp } from 'vue';
import AdminApp from './AdminApp.vue';
import { startAdminTheme } from './theme.js';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/public-sans/800.css';
import '@qed2/ui/themes';
import '@qed2/ui/layout-tokens';
import './admin.css';

// A bounded, read-only legacy theme lookup completes before rendering forms.
void startAdminTheme().then((stopTheme) => {
  const app = createApp(AdminApp);
  app.mount('#admin-app');
  import.meta.hot?.dispose(() => {
    app.unmount();
    stopTheme();
  });
});
