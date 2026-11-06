import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
  test: {
    environment: 'jsdom',
    // the app works in IST (todayISO / morning round); tests build local Dates, so run them in IST
    env: { TZ: 'Asia/Kolkata' },
    include: ['tests/**/*.test.{js,jsx}'],
  },
});
