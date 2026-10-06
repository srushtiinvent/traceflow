import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const maxOutputBytes = 1024 * 1024;

function runProcess(command, args, { cwd, input = '', timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let outputTooLarge = false;
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
    }, timeoutMs);
    const collect = (stream, chunk) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > maxOutputBytes) {
        outputTooLarge = true;
        child.kill('SIGKILL');
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ stdout, stderr: error.code === 'ENOENT' ? `C++ compiler “${command}” was not found. Install Clang or set CXX to its path.` : error.message, exitCode: 127, timedOut, outputTooLarge });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ stdout, stderr, exitCode: exitCode ?? 1, timedOut, outputTooLarge });
    });
    child.stdin.end(input);
  });
}

export async function runCppLocally(source, stdin) {
  const directory = await mkdtemp(path.join(tmpdir(), 'traceflow-local-cpp-'));
  try {
    const sourcePath = path.join(directory, 'main.cpp');
    const binaryPath = path.join(directory, 'program');
    await writeFile(sourcePath, source);
    const compiler = process.env.CXX || 'clang++';
    const compilation = await runProcess(compiler, ['-std=c++20', '-O0', '-pipe', sourcePath, '-o', binaryPath], { cwd: directory, timeoutMs: 20_000 });
    if (compilation.exitCode !== 0 || compilation.timedOut || compilation.outputTooLarge) {
      return { stdout: '', stderr: compilation.stderr || (compilation.timedOut ? 'Compilation exceeded the 20 second limit.' : 'Compiler output limit exceeded.'), exitCode: compilation.exitCode, timedOut: compilation.timedOut };
    }
    const execution = await runProcess(binaryPath, [], { cwd: directory, input: stdin, timeoutMs: 3_000 });
    return {
      ...execution,
      stderr: execution.outputTooLarge ? `${execution.stderr}\nOutput exceeded the 1 MB limit.` : execution.stderr,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
