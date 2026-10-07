import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { darkThemePlugin } from './src/darkTheme.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [darkThemePlugin(), react()],
    server: {
      proxy: {
        '/api': {
          target: env.API_BASE_URL ?? 'http://127.0.0.1:8787',
          changeOrigin: true,
        },
      },
    },
  };
});
