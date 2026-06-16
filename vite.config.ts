import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
  server: {
    // Honor a harness-assigned port (preview tooling sets PORT)
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
  },
});
