import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src-ui',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 1422,
    strictPort: true,
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
});