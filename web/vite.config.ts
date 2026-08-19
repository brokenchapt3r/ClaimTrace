import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const serverTarget = env.CLAIMTRACE_SERVER_TARGET || 'http://127.0.0.1:9230';
  return {
    plugins: [react()],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    server: {
      host: '0.0.0.0',
      port: Number(env.PORT) || 9222,
      strictPort: false,
      hmr: { overlay: false },
      proxy: {
        '/api': { target: serverTarget, changeOrigin: true },
        '/claimtrace-audit': { target: serverTarget, changeOrigin: true },
        '/claimtrace-runtime-log': { target: serverTarget, changeOrigin: true },
        '/healthz': { target: serverTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      minify: 'esbuild',
      target: 'es2020',
    },
  };
});
