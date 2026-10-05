import Parser from "web-tree-sitter";
import type {
  CppProgram,
  Expr,
  FunctionAst,
  Parameter,
  Stmt,
  SyntaxIssue,
  VariableDecl,
} from "./types";

type Node = Parser.SyntaxNode;
type ExprInput = Expr | undefined;

let parser: Parser | undefined;
let initializing: Promise<void> | undefined;

export async function initializeParser(
  languageWasmUrl?: string | Uint8Array,
  runtimeWasmUrl?: string,
) {
  if (parser) return;
  if (initializing) return initializing;
  initializing = (async () => {
    const base = import.meta.env?.BASE_URL ?? "/";
    await Parser.init({
      locateFile: (file: string) =>
        file.endsWith(".wasm") ? runtimeWasmUrl ?? `${base}tree-sitter.wasm` : file,
    });
    parser = new Parser();
    await parser.setLanguage(
      await Parser.Language.load(languageWasmUrl ?? `${base}tree-sitter-cpp.wasm`),
    );
  })();
  return initializing;
}

export function parseProgram(source: string): CppProgram {
  if (!parser) throw new Error("The C++ parser has not finished loading.");
  const tree = parser.parse(source);
  try {
    const errors = collectSyntaxIssues(tree.rootNode);
    const functions: FunctionAst[] = [];
    const root = tree.rootNode;
    for (const child of root.namedChildren) {
      if (child.type === "function_definition") functions.push(parseFunction(child));
      else if (child.type === "class_specifier" || child.type === "struct_specifier") {
        errors.push({ line: lineOf(child), message: "Classes and structs are not supported yet." });
      } else if (child.type === "template_declaration") {
        errors.push({ line: lineOf(child), message: "Function and class templates are not supported yet." });
      } else if (
        child.type === "declaration" &&
        child.namedChildren.some((part) => part.type === "init_declarator" || part.type === "identifier")
      ) {
        // Global objects are intentionally not executed as top-level statements.
        errors.push({ line: lineOf(child), message: "Global variables are not supported yet; declare values inside main()." });
      }
    }
    return { functions, errors: dedupeIssues(errors) };
  } finally {
    tree.delete();
  }
}

function parseFunction(node: Node): FunctionAst {
  const declarator = field(node, "declarator");
  const body = field(node, "body");
  const nameNode = declarator?.type === "function_declarator"
    ? field(declarator, "declarator")
    : declarator;
  const parameterList = declarator?.type === "function_declarator"
    ? field(declarator, "parameters")
    : undefined;
  return {
    name: nameNode?.text ?? "<anonymous>",
    returnType: field(node, "type")?.text ?? "void",
    parameters: parameterList?.namedChildren
      .filter((part) => part.type === "parameter_declaration" || part.type === "optional_parameter_declaration")
      .map(parseParameter) ?? [],
    body: body ? parseStatement(body) : { kind: "empty", line: lineOf(node) },
    line: lineOf(node),
  };
}

function parseParameter(node: Node): Parameter {
  const type = field(node, "type")?.text ?? "auto";
  const declarator = field(node, "declarator");
  const name = declarator ? findDeclaredName(declarator) : "";
  return { name: name || `arg${lineOf(node)}`, type, line: lineOf(node) };
}

function parseStatement(node: Node): Stmt {
  const line = lineOf(node);
  switch (node.type) {
    case "compound_statement":
      return { kind: "block", body: node.namedChildren.map(parseStatement), line };
    case "declaration":
      return parseDeclaration(node);
    case "expression_statement": {
      const expression = node.namedChildren[0];
      return expression
        ? { kind: "expression", expression: parseExpression(expression), line }
        : { kind: "empty", line };
    }
    case "if_statement": {
      const conditionNode = field(node, "condition")?.namedChildren.find((child) => child.type !== "(" && child.type !== ")");
        const consequent = field(node, "consequence");
      const alternativeNode = field(node, "alternative");
      const alternative = alternativeNode?.namedChildren.find((child) =>
        child.type === "compound_statement" ||
        child.type === "if_statement" ||
        child.type.endsWith("_statement"),
      );
      return {
        kind: "if",
        condition: parseExpression(conditionNode ?? field(node, "condition") ?? node),
        consequence: consequent ? parseStatement(consequent) : { kind: "empty", line },
        alternative: alternative ? parseStatement(alternative) : undefined,
        line,
      };
    }
    case "while_statement": {
      const conditionNode = field(node, "condition");
      return {
        kind: "while",
        condition: parseExpression(conditionNode?.namedChildren[0] ?? conditionNode ?? node),
        body: field(node, "body") ? parseStatement(field(node, "body")!) : { kind: "empty", line },
        line,
      };
    }
    case "do_statement": {
      const conditionNode = field(node, "condition");
      return {
        kind: "do",
        condition: parseExpression(conditionNode?.namedChildren.find((child) => child.type !== "parenthesized_expression") ?? conditionNode ?? node),
        body: field(node, "body") ? parseStatement(field(node, "body")!) : { kind: "empty", line },
        line,
      };
    }
    case "for_statement":
      return {
        kind: "for",
        initializer: field(node, "initializer") ? parseStatement(field(node, "initializer")!) : undefined,
        condition: field(node, "condition") ? parseExpression(field(node, "condition")!) : undefined,
        update: field(node, "update") ? parseExpression(field(node, "update")!) : undefined,
        body: field(node, "body") ? parseStatement(field(node, "body")!) : { kind: "empty", line },
        line,
      };
    case "for_range_loop": {
      const type = field(node, "type")?.text ?? "auto";
      const name = field(node, "declarator") ? findDeclaredName(field(node, "declarator")!) : "item";
      const iterable = field(node, "right") ?? field(node, "range");
      return {
        kind: "rangeFor",
        variable: { name, type, line },
        iterable: parseExpression(iterable ?? node),
        body: field(node, "body") ? parseStatement(field(node, "body")!) : { kind: "empty", line },
        line,
      };
    }
    case "return_statement": {
      const value = node.namedChildren[0];
      return { kind: "return", value: value ? parseExpression(value) : undefined, line };
    }
    case "break_statement":
      return { kind: "break", line };
    case "continue_statement":
      return { kind: "continue", line };
    case "empty_statement":
      return { kind: "empty", line };
    case "declaration_statement": {
      const declaration = node.namedChildren[0];
      return declaration ? parseStatement(declaration) : { kind: "empty", line };
    }
    case "switch_statement":
      return { kind: "unsupported", label: "switch statements", line };
    case "try_statement":
      return { kind: "unsupported", label: "try/catch statements", line };
    case "goto_statement":
      return { kind: "unsupported", label: "goto statements", line };
    default:
      if (node.type.endsWith("_statement") || node.type === "case_statement") {
        return { kind: "unsupported", label: node.type.replaceAll("_", " "), line };
      }
      return { kind: "expression", expression: parseExpression(node), line };
  }
}

function parseDeclaration(node: Node): Stmt {
  const line = lineOf(node);
  const typeNode = field(node, "type") ?? node.namedChildren[0];
  const type = typeNode?.text ?? "auto";
  const declarators = node.namedChildren.filter((part) =>
    part.type === "init_declarator" ||
    part.type === "identifier" ||
    part.type === "array_declarator" ||
    part.type === "pointer_declarator" ||
    part.type === "reference_declarator",
  );
  const declarations = declarators.map((part) => parseVariableDecl(part, type));
  if (containsUnsupportedType(typeNode, type)) {
    return { kind: "unsupported", label: unsupportedTypeName(typeNode, type), line };
  }
  if (declarations.some((decl) => decl.name === "<pointer>")) {
    return { kind: "unsupported", label: "pointers and references", line };
  }
  return { kind: "declaration", declarations, line };
}

function parseVariableDecl(node: Node, type: string): VariableDecl {
  const declarator = node.type === "init_declarator" ? field(node, "declarator") : node;
  const initializer = node.type === "init_declarator" ? field(node, "value") : undefined;
  const arrayNode = firstOfType(declarator, "array_declarator");
  const arraySizeNode = arrayNode?.namedChildren.find((part) => part.type !== "identifier");
  return {
    name: declarator ? findDeclaredName(declarator) : "<unknown>",
    type,
    initializer: initializer ? parseExpression(initializer) : undefined,
    arraySize: arraySizeNode ? parseExpression(arraySizeNode) : undefined,
    line: lineOf(node),
  };
}

function parseExpression(node: Node): Expr {
  const line = lineOf(node);
  switch (node.type) {
    case "number_literal": {
      const text = node.text.replaceAll("'", "");
      const value = text.startsWith("0x") || text.startsWith("0X")
        ? Number.parseInt(text, 16)
        : text.startsWith("0b") || text.startsWith("0B")
          ? Number.parseInt(text.slice(2), 2)
          : text.includes(".") || text.includes("e") || text.includes("E")
            ? Number.parseFloat(text)
            : Number.parseInt(text, 10);
      return { kind: "literal", value, line };
    }
    case "true":
    case "false":
      return { kind: "literal", value: node.type === "true", line };
    case "nullptr":
    case "null":
      return { kind: "literal", value: null, line };
    case "char_literal":
      return { kind: "literal", value: decodeQuoted(node.text), line };
    case "string_literal":
    case "raw_string_literal":
    case "concatenated_string":
      return { kind: "literal", value: decodeQuoted(node.text), line };
    case "identifier":
    case "field_identifier":
    case "namespace_identifier":
    case "qualified_identifier":
      return { kind: "identifier", name: node.text, line };
    case "parenthesized_expression":
      return parseExpression(node.namedChildren[0] ?? node);
    case "binary_expression":
    case "co_await_expression": {
      const left = field(node, "left");
      const right = field(node, "right");
      const operator = field(node, "operator")?.text ?? "";
      if (node.type === "co_await_expression") return { kind: "unsupported", label: "co_await", line };
      if (!left || !right) return { kind: "unsupported", label: "malformed expression", line };
      return { kind: operator === "=" || operator.endsWith("=") && !["==", "!=", "<=", ">="].includes(operator)
        ? "assignment"
        : "binary", operator, left: parseExpression(left), right: parseExpression(right), line };
    }
    case "assignment_expression": {
      const left = field(node, "left");
      const right = field(node, "right");
      if (!left || !right) return { kind: "unsupported", label: "assignment", line };
      return { kind: "assignment", operator: field(node, "operator")?.text ?? "=", left: parseExpression(left), right: parseExpression(right), line };
    }
    case "conditional_expression": {
      const condition = field(node, "condition");
      const consequence = field(node, "consequence");
      const alternative = field(node, "alternative");
      if (!condition || !consequence || !alternative) return { kind: "unsupported", label: "conditional expression", line };
      return { kind: "conditional", condition: parseExpression(condition), consequence: parseExpression(consequence), alternative: parseExpression(alternative), line };
    }
    case "unary_expression":
    case "pointer_expression": {
      if (node.type === "pointer_expression") return { kind: "unsupported", label: "pointer expressions", line };
      const argument = field(node, "argument") ?? node.namedChildren[0];
      if (!argument) return { kind: "unsupported", label: "unary expression", line };
      return { kind: "unary", operator: field(node, "operator")?.text ?? "", argument: parseExpression(argument), line };
    }
    case "update_expression": {
      const argument = field(node, "argument") ?? node.namedChildren[0];
      if (!argument) return { kind: "unsupported", label: "increment/decrement expression", line };
      const operator = field(node, "operator")?.text ?? "";
      return { kind: "update", operator, argument: parseExpression(argument), prefix: node.text.startsWith(operator), line };
    }
    case "call_expression": {
      const fn = field(node, "function");
      const args = field(node, "arguments")?.namedChildren.map(parseExpression) ?? [];
      if (!fn) return { kind: "unsupported", label: "function call", line };
      if (fn.type === "field_expression") {
        const object = field(fn, "argument");
        const method = field(fn, "field");
        if (!object || !method) return { kind: "unsupported", label: "member function call", line };
        const receiver = parseExpression(object);
        return { kind: "call", callee: `${expressionName(receiver)}.${method.text}`, args: [receiver, ...args], line };
      }
      return { kind: "call", callee: expressionName(parseExpression(fn)), args, line };
    }
    case "subscript_expression": {
      const object = field(node, "argument");
      const index = field(node, "indices")?.namedChildren[0];
      return object && index
        ? { kind: "index", object: parseExpression(object), index: parseExpression(index), line }
        : { kind: "unsupported", label: "array index", line };
    }
    case "field_expression": {
      const object = field(node, "argument");
      const property = field(node, "field");
      return object && property
        ? { kind: "member", object: parseExpression(object), property: property.text, line }
        : { kind: "unsupported", label: "member access", line };
    }
    case "initializer_list":
    case "argument_list":
    case "initializer_list_expression":
      return { kind: "list", values: node.namedChildren.map(parseExpression), line };
    case "cast_expression":
    case "type_cast_expression":
      return node.namedChildren.length > 1
        ? parseExpression(node.namedChildren.at(-1)!)
        : { kind: "unsupported", label: "type casts", line };
    case "lambda_expression":
      return { kind: "unsupported", label: "lambda expressions", line };
    case "new_expression":
      return { kind: "unsupported", label: "dynamic allocation", line };
    case "delete_expression":
      return { kind: "unsupported", label: "delete expressions", line };
    default:
      if (!node.namedChildren.length) return { kind: "unsupported", label: node.type.replaceAll("_", " "), line };
      if (node.namedChildren.length === 1) return parseExpression(node.namedChildren[0]!);
      return { kind: "unsupported", label: node.type.replaceAll("_", " "), line };
  }
}

function collectSyntaxIssues(root: Node): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  const visit = (node: Node) => {
    if (node.isError || node.isMissing) {
      const message = node.isMissing
        ? `Expected ${node.type}.`
        : `Unexpected token near “${node.text.slice(0, 32)}”.`;
      issues.push({ line: lineOf(node), message });
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return issues;
}

function containsUnsupportedType(typeNode: Node | undefined, text: string) {
  if (text.includes("*") || text.includes("&")) return true;
  if (text.includes("map<") || text.includes("unordered_map<")) return true;
  if (typeNode?.type === "template_type") {
    const base = field(typeNode, "name")?.text ?? "";
    return base !== "vector";
  }
  return false;
}

function unsupportedTypeName(typeNode: Node | undefined, text: string) {
  if (text.includes("*") || text.includes("&")) return "pointers and references";
  if (text.includes("map<") || text.includes("unordered_map<")) return "maps";
  const name = typeNode?.type === "template_type" ? field(typeNode, "name")?.text : text;
  return name ? `the ${name} type` : "this type";
}

function findDeclaredName(node: Node): string {
  if (node.type === "pointer_declarator" || node.type === "reference_declarator") return "<pointer>";
  if (node.type === "identifier" || node.type === "field_identifier") return node.text;
  for (const child of node.namedChildren) {
    const name = findDeclaredName(child);
    if (name !== "<pointer>") return name;
  }
  return "<unknown>";
}

function firstOfType(node: Node | undefined, type: string): Node | undefined {
  if (!node) return undefined;
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    const result = firstOfType(child, type);
    if (result) return result;
  }
  return undefined;
}

function expressionName(expression: Expr): string {
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind === "member") return `${expressionName(expression.object)}.${expression.property}`;
  return "";
}

function field(node: Node, name: string) {
  return node.childForFieldName(name) ?? undefined;
}

function lineOf(node: Node) {
  return node.startPosition.row + 1;
}

function decodeQuoted(text: string): string {
  if (text.startsWith("R\"")) {
    const opening = text.indexOf("(");
    const closing = text.lastIndexOf(")");
    return opening >= 0 && closing > opening ? text.slice(opening + 1, closing) : text;
  }
  let value = "";
  for (let index = 1; index < text.length - 1; index += 1) {
    const char = text[index]!;
    if (char !== "\\") {
      value += char;
      continue;
    }
    index += 1;
    const escaped = text[index];
    const escapes: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      "0": "\0",
      "\\": "\\",
      "'": "'",
      '"': '"',
    };
    value += escaped ? escapes[escaped] ?? escaped : "";
  }
  return value;
}

function dedupeIssues(issues: SyntaxIssue[]) {
  const unique = new Map<string, SyntaxIssue>();
  for (const issue of issues) unique.set(`${issue.line}:${issue.message}`, issue);
  return [...unique.values()].sort((a, b) => a.line - b.line);
}