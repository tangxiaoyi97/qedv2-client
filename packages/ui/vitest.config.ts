import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'jsdom',
    // Without this, `import css from '*.css?raw'` resolves to an empty string
    // and any assertion about a stylesheet silently passes on nothing.
    css: true,
  },
});
