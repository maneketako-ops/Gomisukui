import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true },
  build: { chunkSizeWarningLimit: 800 },
});
