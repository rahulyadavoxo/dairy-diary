import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{js,jsx}'],
  },
});
