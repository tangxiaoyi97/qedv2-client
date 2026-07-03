import { createRouter, createWebHistory } from 'vue-router';

/**
 * Route views are lazy — keeps the initial PWA shell light.
 * meta.focus: practice runs in a distraction-free full-screen chrome
 * (own top bar, no navigation shell — prototype 1b).
 */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: () => import('./routes/HomeView.vue') },
    {
      path: '/ueben',
      name: 'practice',
      component: () => import('./routes/PracticeView.vue'),
      meta: { focus: true },
    },
    { path: '/aufgaben', name: 'browse', component: () => import('./routes/BrowseView.vue') },
    { path: '/fortschritt', name: 'progress', component: () => import('./routes/ProgressView.vue') },
    { path: '/anmelden', name: 'auth', component: () => import('./routes/AuthView.vue') },
    { path: '/einstellungen', name: 'settings', component: () => import('./routes/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
