import { defineConfig, type Plugin } from 'vite';
import { resolve, basename } from 'node:path';

const root = import.meta.dirname;

// Tells open pages when a CAD export in public/models changes, so they can swap the model in place
// (no full reload, simulation state kept). Export from your CAD script straight into that folder.
const modelWatch = (): Plugin => ({
  name: 'model-watch',
  configureServer(server) {
    const dir = resolve(root, 'public/models');
    server.watcher.add(dir);
    const send = (file: string) => {
      if (!file.startsWith(dir)) return;
      server.ws.send({ type: 'custom', event: 'model-changed', data: { file: basename(file), t: Date.now() } });
    };
    server.watcher.on('change', send);
    server.watcher.on('add', send);
  },
  handleHotUpdate({ file }) {
    if (file.includes('public') && file.includes('models')) return []; // we handle these ourselves
  },
});

export default defineConfig({
  plugins: [modelWatch()],
  // the Python venv is ~21k files: crawling it stalled the dev server for ~50 s on start
  server: { watch: { ignored: ['**/cad/.venv/**', '**/dist/**', '**/video/**'] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 800, // three.js itself (~630 kB), shared by all pages
    rollupOptions: {
      input: {
        launch: resolve(root, 'index.html'),
        engine: resolve(root, 'engine.html'),
        srm: resolve(root, 'srm.html'),
      },
    },
  },
});
