import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

declare const process: { env: Record<string, string | undefined> };

/** Identificador desta versão do site. Muda a cada build (cada deploy). */
const BUILD_ID = process.env.RENDER_GIT_COMMIT?.slice(0, 12) || Date.now().toString(36);

/** Gera dist/version.json: o app aberto consulta esse arquivo para saber se saiu versão nova. */
const versionFile = (): Plugin => ({
  name: 'nexo-version',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: BUILD_ID }) });
  },
});

export default defineConfig({
  plugins: [react(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/gateway': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
