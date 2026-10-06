import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { runCppLocally } from './runner/local-compiler.mjs';

const localCompiler: Plugin = {
  name: 'traceflow-local-cpp-runner',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/api/health' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, compiler: process.env.CXX || 'clang++' }));
        return;
      }
      if (pathname !== '/api/run') return next();
      if (request.method !== 'POST') {
        response.writeHead(405, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Use POST /api/run.' }));
        return;
      }
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 148 * 1024) throw Object.assign(new Error('Request is too large.'), { status: 413 });
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof body.source !== 'string' || typeof body.stdin !== 'string') throw Object.assign(new Error('source and stdin must be strings.'), { status: 400 });
        if (Buffer.byteLength(body.source) > 128 * 1024) throw Object.assign(new Error('Source is too large (128 KB maximum).'), { status: 413 });
        if (Buffer.byteLength(body.stdin) > 16 * 1024) throw Object.assign(new Error('Input is too large (16 KB maximum).'), { status: 413 });
        const result = await runCppLocally(body.source, body.stdin);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(error.status ?? 400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Local compiler failed.' }));
      }
    });
  },
};

export default defineConfig({
  base: '/traceflow/',
  plugins: [localCompiler, react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 5000,
  },
});
