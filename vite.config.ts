import { defineConfig } from 'vite';

export default defineConfig({
  base: '/special/',
  build: {
    target: 'es2022',
    assetsInlineLimit: 8192,
  },
});
