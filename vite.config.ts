import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  base: './',
  build: { outDir: mode === 'demo' ? 'dist' : 'dist-local' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    ...(mode === 'demo' ? {} : {
      proxy: { '/game-ws': { target: 'ws://127.0.0.1:5230', ws: true, changeOrigin: true } },
    }),
  },
}));

