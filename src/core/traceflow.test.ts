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

test("class methods can call another method on the same object recursively", () => {
  const source = `#include <iostream>
#include <string>
using namespace std;
class Solution {
public:
  int scoreOfParentheses(string s) { return F(s, 0, s.length()); }
private:
  int F(const string& s, int i, int j) {
    int ans = 0, bal = 0;
    for (int k = i; k < j; ++k) {
      bal += (s[k] == '(' ? 1 : -1);
      if (bal == 0) {
        if (k - i == 1) ans++;
        else ans += 2 * F(s, i + 1, k);
        i = k + 1;
      }
    }
    return ans;
  }
};
int main() {
  Solution solution;
  string a = "()", b = "(())", c = "()()", d = "(()(()))";
  cout << solution.scoreOfParentheses(a) << " " << solution.scoreOfParentheses(b) << " "
       << solution.scoreOfParentheses(c) << " " << solution.scoreOfParentheses(d) << endl;
  return 0;
}`;
  const result = runProgram(source, "");
  assert.equal(result.error, undefined);
  assert.equal(result.output.trim(), "1 2 2 6");
});

test("capturing lambdas and vector size constructors run with cin input", () => {
  const source = `#include <iostream>
#include <vector>
using namespace std;
class Solution {
public:
  int countGoodStrings(long long n) {
    if (n == 0) return 0;
    long long mod = 1e9 + 7;
    auto multiply = [&](const vector<vector<long long>>& A, const vector<vector<long long>>& B) {
      vector<vector<long long>> C(2, vector<long long>(2, 0));
      for (int i = 0; i < 2; ++i)
        for (int j = 0; j < 2; ++j)
          for (int k = 0; k < 2; ++k)
            C[i][j] = (C[i][j] + A[i][k] * B[k][j]) % mod;
      return C;
    };
    vector<vector<long long>> T = {{1, 1}, {1, 0}};
    vector<vector<long long>> res = {{1, 0}, {0, 1}};
    long long p = n - 1;
    while (p > 0) {
      if (p & 1) res = multiply(res, T);
      T = multiply(T, T);
      p >>= 1;
    }
    long long fib = res[0][0];
    return (2 * fib) % mod;
  }
};
int main() {
  Solution sol;
  long long n;
  cout << "Enter n: ";
  cin >> n;
  cout << "Result: " << sol.countGoodStrings(n) << endl;
  return 0;
}`;
  const result = runProgram(source, "5");
  const zeroResult = runProgram(source, "0");
  const graph = buildProgramGraph(source);
  assert.equal(result.error, undefined);
  assert.equal(result.output.trim(), "Enter n: Result: 10");
  assert.equal(zeroResult.output.trim(), "Enter n: Result: 0");
  assert.ok(graph.functions.some((fn) => fn.name === "countGoodStrings"));
  assert.ok(graph.functions.some((fn) => fn.name === "multiply"));
  assert.ok(result.snapshots.some((snapshot) => snapshot.nodeId.startsWith("multiply:")));
  assert.ok(result.snapshots.some((snapshot) => snapshot.variables.multiply === "[Function: multiply]"));
  assert.ok(!zeroResult.snapshots.some((snapshot) => snapshot.nodeId.startsWith("multiply:")));
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

test("run result reports stdin tokens the program never reads", () => {
  const result = runProgram("int main() { int n; cin >> n; cout << n; }", "1 2 3 4 5");
  assert.equal(result.output, "1");
  assert.deepEqual(result.unusedInput, ["2", "3", "4", "5"]);
});

test("a runaway loop stops at the 5,000-step safety limit", () => {
  const result = runProgram("int main() { while (true) { int value = 1; } }", "");
  assert.match(result.error?.message ?? "", /possible infinite loop/i);
  assert.equal(result.snapshots.length, 5_000);
});
