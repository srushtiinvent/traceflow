import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { before } from "node:test";
import { buildProgramGraph, initializeParser, runProgram } from "./traceflow";
import { examples } from "./examples";

before(async () => {
  const languageWasm = new Uint8Array(
    await readFile(new URL("../../public/tree-sitter-cpp.wasm", import.meta.url)),
  );
  const runtimeWasm = fileURLToPath(
    new URL("../../node_modules/web-tree-sitter/tree-sitter.wasm", import.meta.url),
  );
  await initializeParser(languageWasm, runtimeWasm);
});

test("control-flow graph counts for ten small C++ programs", () => {
  const cases = [
    ["int main() {}", 2, 1],
    ["int main() { int x = 1; }", 3, 2],
    ["int main() { int x = 1; x++; }", 3, 2],
    ["int main() { int x = 1; if (x) x++; }", 5, 5],
    ["int main() { int x = 1; if (x) x++; else x--; }", 6, 6],
    ["int main() { int x = 0; while (x < 3) x++; }", 5, 5],
    ["int main() { int x = 0; do { x++; } while (x < 3); }", 5, 5],
    ["int main() { for (int i = 0; i < 3; i++) { int x = i; } }", 6, 6],
    ["int main() { while (true) { break; } }", 4, 4],
    ["int main() { return 0; }", 3, 2],
  ] as const;
  for (const [source, nodeCount, edgeCount] of cases) {
    const graph = buildProgramGraph(source).functions[0]!;
    assert.equal(graph.nodes.length, nodeCount, source);
    assert.equal(graph.edges.length, edgeCount, source);
  }
});

test("binary search finds the requested value at index two", () => {
  const result = runProgram(examples.find((example) => example.name === "Binary search")!.source, "7");
  assert.equal(result.error, undefined);
  assert.equal(result.output.trim(), "2");
  assert.equal(result.variables.$return, 2);
});

test("recursive Fibonacci calculates ten as 55", () => {
  const source = `int fibonacci(int n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
int main() { int answer = fibonacci(10); return answer; }`;
  const result = runProgram(source, "");
  assert.equal(result.error, undefined);
  assert.equal(result.variables.$return, 55);
});

test("bubble sort produces ordered values", () => {
  const result = runProgram(examples.find((example) => example.name === "Bubble sort")!.source, "");
  assert.equal(result.error, undefined);
  assert.equal(result.output.trim(), "1 2 3 4 5");
});

test("out-of-bounds access stops with a clear runtime error", () => {
  const result = runProgram("int main() { int values[2] = {4, 8}; return values[2]; }", "");
  assert.match(result.error?.message ?? "", /out of bounds/i);
  assert.equal(result.error?.line, 1);
});

test("a runaway loop stops at the 5,000-step safety limit", () => {
  const result = runProgram("int main() { while (true) { int value = 1; } }", "");
  assert.match(result.error?.message ?? "", /possible infinite loop/i);
  assert.equal(result.snapshots.length, 5_000);
});