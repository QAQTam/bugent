import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 纯前端 dev server；Electron 打包留待后续阶段（见交付说明）。
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
