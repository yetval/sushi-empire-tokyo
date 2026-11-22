import { defineConfig } from 'vite';

// Relative base so the build works under any GitHub Pages repo subpath.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { environment: 'node' },
} as any);
