import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  test: { include: ['test/**/*.test.ts'], setupFiles: ['test/setup.ts'] },
} as never);
