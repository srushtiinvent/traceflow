import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.PORT ?? 8787);
const image = process.env.TRACEFLOW_CPP_IMAGE ?? 'traceflow-cpp-runner:latest';
const allowedOrigins = new Set((process.env.TRACEFLOW_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean));
const maxSourceBytes = 128 * 1024;
const maxInputBytes = 16 * 1024;
const maxOutputBytes = 1024 * 1024;
const compileTimeoutMs = 12_000;
const sourceRoot = process.env.TRACEFLOW_SOURCE_DIR ?? '/var/tmp/traceflow-src';
const buckets = new Map();

function send(response, status, body, origin) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSourceBytes + maxInputBytes + 4096) {
        reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

function allowRequest(ip) {
  const now = Date.now();
  const current = buckets.get(ip);
  if (!current || now - current.start > 60_000) {
    buckets.set(ip, { start: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 12;
}

function runInSandbox(sourceDirectory, stdin) {
  return new Promise((resolve) => {
    const args = [
      'run', '--rm', '-i', '--network=none', '--memory=256m', '--memory-swap=256m', '--cpus=1', '--pids-limit=64',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--user=65534:65534',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--mount', `type=bind,src=${sourceDirectory},dst=/source,readonly`,
      image, 'sh', '-lc', 'g++ -std=c++20 -O0 -pipe /source/main.cpp -o /tmp/program 1>&2 || exit $?; timeout --signal=TERM --kill-after=1s 3s /tmp/program; code=$?; if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then echo PROGRAM_TIMEOUT >&2; fi; exit "$code"',
    ];
    const child = spawn(process.env.DOCKER_BIN ?? 'docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let capped = false;
    const collect = (stream, chunk) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > maxOutputBytes) {
        if (!capped) {
          capped = true;
          child.kill('SIGKILL');
        }
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    const timeout = setTimeout(() => child.kill('SIGKILL'), compileTimeoutMs);
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr: error.code === 'ENOENT' ? 'Compiler service could not find Docker.' : error.message, exitCode: 127, timedOut: false, capped });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      const timedOut = signal === 'SIGKILL' || stderr.includes('PROGRAM_TIMEOUT');
      stderr = stderr.replaceAll('PROGRAM_TIMEOUT', 'Program exceeded the 3 second runtime limit.').trim();
      resolve({ stdout, stderr: capped ? `${stderr}\nOutput limit exceeded.` : stderr, exitCode: exitCode ?? 1, timedOut, capped });
    });
    child.stdin.end(stdin);
  });
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return send(response, 403, { error: 'This website is not allowed to use the compiler service.' });
  if (request.method === 'OPTIONS' && request.url === '/api/run') {
    response.writeHead(204, {
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
    });
    return response.end();
  }
  if (request.method === 'GET' && request.url === '/api/health') return send(response, 200, { ok: true }, origin);
  if (request.method !== 'POST' || request.url !== '/api/run') return send(response, 404, { error: 'Not found.' }, origin);
  const ip = request.socket.remoteAddress ?? 'unknown';
  if (!allowRequest(ip)) return send(response, 429, { error: 'Run limit reached. Wait a minute and try again.' }, origin);

  let sourceDirectory;
  try {
    const body = await readBody(request);
    if (typeof body.source !== 'string' || typeof body.stdin !== 'string') return send(response, 400, { error: 'source and stdin must be strings.' }, origin);
    if (Buffer.byteLength(body.source) > maxSourceBytes) return send(response, 413, { error: 'Source is too large (128 KB maximum).' }, origin);
    if (Buffer.byteLength(body.stdin) > maxInputBytes) return send(response, 413, { error: 'Input is too large (16 KB maximum).' }, origin);
    await mkdir(sourceRoot, { recursive: true });
    sourceDirectory = await mkdtemp(path.join(sourceRoot, 'traceflow-cpp-'));
    await chmod(sourceDirectory, 0o755);
    await writeFile(path.join(sourceDirectory, 'main.cpp'), body.source, { mode: 0o444 });
    const result = await runInSandbox(sourceDirectory, body.stdin);
    if (result.timedOut) result.stderr += '\nExecution was stopped after the compiler or program exceeded its time limit.';
    send(response, 200, result, origin);
  } catch (error) {
    send(response, error?.status ?? 500, { error: error instanceof Error ? error.message : 'Compiler service failed.' }, origin);
  } finally {
    if (sourceDirectory) await rm(sourceDirectory, { recursive: true, force: true });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`TraceFlow C++ runner listening on ${port}`));
