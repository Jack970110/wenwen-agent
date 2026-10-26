import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // 开发期代理到后端，生产由 Hono 直接托管构建产物，同源无 CORS
    proxy: { '/api': 'http://localhost:3001' },
  },
  build: { outDir: 'dist' },
});
