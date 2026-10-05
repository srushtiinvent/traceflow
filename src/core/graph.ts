import { parseProgram } from "./parser";
import type {
  Expr,
  FlowEdge,
  FlowNode,
  FunctionAst,
  FunctionGraph,
  ProgramGraph,
  Stmt,
} from "./types";

export function buildProgramGraph(source: string): ProgramGraph {
  const parsed = parseProgram(source);
  const astFunctions = [
    ...parsed.functions,
    ...parsed.classes.flatMap((type) => type.methods),
  ];
  const lambdaFunctions = astFunctions.flatMap((fn) => collectLambdas(fn.body));
  const functions = [...astFunctions, ...lambdaFunctions].map((fn) => buildFunctionGraph(fn, source));
  if (functions.length === 0 && parsed.errors.length === 0) {
    parsed.errors.push({ line: 1, message: "No function definition found. Add a main() function to run this program." });
  }
  return { functions, errors: parsed.errors };
}

function collectLambdas(root: Stmt): FunctionAst[] {
  const found: FunctionAst[] = [];
  const visitExpression = (expression: Expr) => {
    if (expression.kind === "lambda") {
      found.push({ name: expression.name ?? `lambda_${expression.line}`, returnType: "auto", parameters: expression.parameters, body: expression.body, line: expression.line });
      visitStatement(expression.body);
    } else if (expression.kind === "call") expression.args.forEach(visitExpression);
    else if (expression.kind === "list") expression.values.forEach(visitExpression);
    else if (expression.kind === "binary" || expression.kind === "assignment") { visitExpression(expression.left); visitExpression(expression.right); }
    else if (expression.kind === "conditional") { visitExpression(expression.condition); visitExpression(expression.consequence); visitExpression(expression.alternative); }
    else if (expression.kind === "unary" || expression.kind === "update") visitExpression(expression.argument);
    else if (expression.kind === "index") { visitExpression(expression.object); visitExpression(expression.index); }
    else if (expression.kind === "member") visitExpression(expression.object);
  };
  const visitStatement = (statement: Stmt): void => {
    if (statement.kind === "block") statement.body.forEach(visitStatement);
    else if (statement.kind === "declaration") statement.declarations.forEach((declaration) => declaration.initializer && visitExpression(declaration.initializer));
    else if (statement.kind === "expression") visitExpression(statement.expression);
    else if (statement.kind === "if") { visitExpression(statement.condition); visitStatement(statement.consequence); if (statement.alternative) visitStatement(statement.alternative); }
    else if (statement.kind === "while" || statement.kind === "do") { visitExpression(statement.condition); visitStatement(statement.body); }
    else if (statement.kind === "for") { if (statement.initializer) visitStatement(statement.initializer); if (statement.condition) visitExpression(statement.condition); if (statement.update) visitExpression(statement.update); visitStatement(statement.body); }
    else if (statement.kind === "rangeFor") { visitExpression(statement.iterable); visitStatement(statement.body); }
    else if (statement.kind === "return" && statement.value) visitExpression(statement.value);
  };
  visitStatement(root);
  return found;
}

function buildFunctionGraph(fn: FunctionAst, source: string): FunctionGraph {
  const graph: FunctionGraph = { name: fn.name, nodes: [], edges: [] };
  const lines = source.split(/\r?\n/);
  let sequence = 0;
  const start = addNode("start", "Start", fn.line);
  const end = addNode("end", "End", fn.body.line);
  const addEdge = (from: string, to: string, label?: string) => {
    graph.edges.push({ id: `${fn.name}:edge:${sequence++}`, source: from, target: to, label });
  };

  function addNode(kind: FlowNode["kind"], label: string, line: number, code?: string, lines?: number[]) {
    const id = `${fn.name}:${kind}:${sequence++}`;
    graph.nodes.push({ id, kind, label, line, code: code ?? sourceLine(line), lines });
    return id;
  }

  function sourceLine(line: number) {
    return (lines[line - 1] ?? "").trim();
  }

  function compileSequence(
    statements: Stmt[],
    next: string,
    breakTarget = end,
    continueTarget = end,
  ): string {
    let entry = next;
    let cursor = statements.length - 1;
    while (cursor >= 0) {
      const statement = statements[cursor]!;
      if (statement.kind === "block") {
        entry = compileSequence(statement.body, entry, breakTarget, continueTarget);
        cursor -= 1;
        continue;
      }
      if (isSimple(statement)) {
        const chunk: Stmt[] = [statement];
        cursor -= 1;
        while (cursor >= 0 && isSimple(statements[cursor]!)) {
          chunk.unshift(statements[cursor]!);
          cursor -= 1;
        }
        const kind = chunk.some((item) => item.kind === "expression" && hasCall(item.expression))
          ? "call"
          : "process";
        const firstLine = chunk[0]!.line;
        const sourceText = chunk.map((item) => sourceLine(item.line)).filter(Boolean).join("\n");
        const label = chunk.map((item) => shortLabel(item, lines)).join("\n") || "statement";
        const node = addNode(kind, label, firstLine, sourceText, chunk.map((item) => item.line));
        addEdge(node, entry);
        entry = node;
        continue;
      }
      if (statement.kind === "if") {
        const decision = addNode("decision", `if (${expressionText(statement.condition)})`, statement.line);
        const yes = compileSequence(toStatements(statement.consequence), entry, breakTarget, continueTarget);
        const no = statement.alternative
          ? compileSequence(toStatements(statement.alternative), entry, breakTarget, continueTarget)
          : entry;
        addEdge(decision, yes, "True");
        addEdge(decision, no, "False");
        entry = decision;
        cursor -= 1;
        continue;
      }
      if (statement.kind === "while" || statement.kind === "for" || statement.kind === "rangeFor") {
        const condition = statement.kind === "while"
          ? expressionText(statement.condition)
          : statement.kind === "for"
            ? statement.condition ? expressionText(statement.condition) : "true"
            : `each ${statement.variable.name} in ${expressionText(statement.iterable)}`;
        const decision = addNode("decision", condition, statement.line);
        const update = statement.kind === "for" && statement.update
          ? addNode("process", expressionText(statement.update), statement.update.line, sourceLine(statement.update.line))
          : decision;
        if (update !== decision) addEdge(update, decision);
        const body = compileSequence(
          toStatements(statement.body),
          update,
          entry,
          decision,
        );
        addEdge(decision, body, "True");
        addEdge(decision, entry, "False");
        entry = statement.kind === "for" && statement.initializer
          ? compileSequence([statement.initializer], decision, entry, decision)
          : decision;
        cursor -= 1;
        continue;
      }
      if (statement.kind === "do") {
        const decision = addNode("decision", `while (${expressionText(statement.condition)})`, statement.line);
        const body = compileSequence(toStatements(statement.body), decision, entry, decision);
        addEdge(decision, body, "True");
        addEdge(decision, entry, "False");
        entry = body;
        cursor -= 1;
        continue;
      }
      if (statement.kind === "return") {
        const code = sourceLine(statement.line);
        const node = addNode("return", statement.value ? `return ${expressionText(statement.value)}` : "return", statement.line, code);
        addEdge(node, end);
        entry = node;
        cursor -= 1;
        continue;
      }
      if (statement.kind === "break" || statement.kind === "continue") {
        const node = addNode("process", statement.kind, statement.line, sourceLine(statement.line));
        addEdge(node, statement.kind === "break" ? breakTarget : continueTarget);
        entry = node;
        cursor -= 1;
        continue;
      }
      if (statement.kind === "unsupported") {
        const node = addNode("process", `Unsupported: ${statement.label}`, statement.line, sourceLine(statement.line));
        addEdge(node, entry);
        entry = node;
        cursor -= 1;
        continue;
      }
      const node = addNode("process", "statement", statement.line, sourceLine(statement.line));
      addEdge(node, entry);
      entry = node;
      cursor -= 1;
    }
    return entry;
  }

  const body = fn.body.kind === "block" ? fn.body.body : [fn.body];
  const bodyStart = compileSequence(body, end);
  addEdge(start, bodyStart);
  return graph;

  function toStatements(statement: Stmt): Stmt[] {
    return statement.kind === "block" ? statement.body : [statement];
  }
}

function isSimple(statement: Stmt) {
  return statement.kind === "declaration" || statement.kind === "expression" || statement.kind === "empty";
}

function shortLabel(statement: Stmt, sourceLines: string[]) {
  if (statement.kind === "declaration") {
    return statement.declarations.map(({ name, initializer }) =>
      initializer ? `${name} = ${expressionText(initializer)}` : name,
    ).join(", ");
  }
  if (statement.kind === "expression") return expressionText(statement.expression);
  return (sourceLines[statement.line - 1] ?? "statement").trim() || "statement";
}

export function expressionText(expression: Expr): string {
  switch (expression.kind) {
    case "literal": return typeof expression.value === "string" ? `"${expression.value}"` : String(expression.value);
    case "identifier": return expression.name;
    case "unary": return `${expression.operator}${expressionText(expression.argument)}`;
    case "update": return expression.prefix
      ? `${expression.operator}${expressionText(expression.argument)}`
      : `${expressionText(expression.argument)}${expression.operator}`;
    case "binary":
    case "assignment": return `${expressionText(expression.left)} ${expression.operator} ${expressionText(expression.right)}`;
    case "conditional": return `${expressionText(expression.condition)} ? ${expressionText(expression.consequence)} : ${expressionText(expression.alternative)}`;
    case "call": return `${expression.callee}(${expression.args.slice(expression.callee.includes(".") ? 1 : 0).map(expressionText).join(", ")})`;
    case "index": return `${expressionText(expression.object)}[${expressionText(expression.index)}]`;
    case "member": return `${expressionText(expression.object)}.${expression.property}`;
    case "list": return `{${expression.values.map(expressionText).join(", ")}}`;
    case "lambda": return "lambda";
    case "unsupported": return `unsupported ${expression.label}`;
  }
}

function hasCall(expression: Expr): boolean {
  if (expression.kind === "call") return true;
  if (expression.kind === "binary" || expression.kind === "assignment") return hasCall(expression.left) || hasCall(expression.right);
  if (expression.kind === "conditional") return hasCall(expression.condition) || hasCall(expression.consequence) || hasCall(expression.alternative);
  if (expression.kind === "unary" || expression.kind === "update") return hasCall(expression.argument);
  if (expression.kind === "index") return hasCall(expression.object) || hasCall(expression.index);
  if (expression.kind === "member") return hasCall(expression.object);
  if (expression.kind === "list") return expression.values.some(hasCall);
  return false;
}
