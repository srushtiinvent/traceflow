import Parser from "web-tree-sitter";
import type {
  CppProgram,
  ClassAst,
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
    const classes: ClassAst[] = [];
    const root = tree.rootNode;
    for (const child of root.namedChildren) {
      if (child.type === "function_definition") functions.push(parseFunction(child));
      else if (child.type === "class_specifier" || child.type === "struct_specifier") {
        const name = field(child, "name")?.text ?? child.namedChildren.find((part) => part.type === "type_identifier")?.text;
        if (name) classes.push(parseClass(child, name));
      } else if (child.type === "template_declaration") {
        const declaration = child.namedChildren.find((part) => part.type === "class_specifier" || part.type === "struct_specifier");
        if (declaration) {
          const name = field(declaration, "name")?.text ?? declaration.namedChildren.find((part) => part.type === "type_identifier")?.text;
          if (name) classes.push(parseClass(declaration, name));
        }
      } else if (
        child.type === "declaration" &&
        child.namedChildren.some((part) => part.type === "init_declarator" || part.type === "identifier")
      ) {
        // Global objects are intentionally not executed as top-level statements.
        errors.push({ line: lineOf(child), message: "Global variables are not supported yet; declare values inside main()." });
      }
    }
    return { functions, classes, errors: dedupeIssues(errors) };
  } finally {
    tree.delete();
  }
}

function parseClass(node: Node, name: string): ClassAst {
  const fields: VariableDecl[] = [];
  const methods: FunctionAst[] = [];
  const constructorInitializers: Record<string, Expr[]> = {};
  const body = field(node, "body") ?? node.namedChildren.find((part) => part.type === "field_declaration_list");
  for (const member of body?.namedChildren ?? []) {
    if (member.type === "field_declaration") {
      const type = field(member, "type")?.text ?? "auto";
      for (const part of member.namedChildren.filter((child) => ["field_declarator", "field_identifier", "identifier", "init_declarator", "pointer_declarator"].includes(child.type))) {
        const decl = part.type === "field_declarator" ? part.namedChildren[0] ?? part : part;
        const variable = parseVariableDecl(decl, type);
        if (firstOfType(decl, "pointer_declarator")) variable.type = `${type}*`;
        fields.push(variable);
      }
    } else if (member.type === "function_definition" || member.type === "declaration" || member.type === "template_declaration") {
      const templatedMethod = member.type === "template_declaration" ? member.namedChildren.find((part) => part.type === "function_definition") : undefined;
      const methodNode = templatedMethod ?? member;
      if (methodNode.type === "function_definition") {
        const method = parseFunction(methodNode);
        methods.push(method);
        if (method.name === name) {
          const initList = methodNode.namedChildren.find((part) => part.type === "field_initializer_list");
          for (const init of initList?.namedChildren ?? []) {
            const fieldName = field(init, "field")?.text ?? init.namedChildren[0]?.text;
            const args = field(init, "arguments")?.namedChildren ?? init.namedChildren.find((part) => part.type === "argument_list")?.namedChildren ?? [];
            if (fieldName) constructorInitializers[fieldName] = args.map(parseExpression);
          }
        }
      }
      else {
        const declarator = member.namedChildren.find((part) => part.type === "function_declarator");
        if (declarator) {
          const fake = member;
          const methodName = findDeclaredName(field(declarator, "declarator") ?? declarator);
          methods.push({ name: methodName, returnType: field(member, "type")?.text ?? "void", parameters: field(declarator, "parameters")?.namedChildren.filter((part) => part.type === "parameter_declaration").map(parseParameter) ?? [], body: { kind: "empty", line: lineOf(member) }, line: lineOf(fake) });
        }
      }
    }
  }
  return { name, fields, methods, constructorInitializers, line: lineOf(node) };
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
    case "comment":
      return { kind: "empty", line };
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
      const loopDeclarator = field(node, "declarator");
      const variableType = loopDeclarator?.type === "reference_declarator" ? `${type}&` : type;
      const name = loopDeclarator ? findDeclaredName(loopDeclarator) : "item";
      const iterable = field(node, "right") ?? field(node, "range");
      return {
        kind: "rangeFor",
        variable: { name, type: variableType, line },
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
    part.type === "reference_declarator" ||
    part.type === "function_declarator",
  );
  const declarations = declarators.map((part) => parseVariableDecl(part, type));
  for (const declaration of declarations) {
    if (declaration.initializer?.kind === "lambda") declaration.initializer.name = declaration.name;
  }
  if (containsUnsupportedType(typeNode, type)) {
    return { kind: "unsupported", label: unsupportedTypeName(typeNode, type), line };
  }
  declarations.forEach((decl, index) => {
    const source = declarators[index];
    if (source?.type === "pointer_declarator" || source?.type === "reference_declarator" || firstOfType(source, "pointer_declarator")) decl.type = `${type}*`;
  });
  return { kind: "declaration", declarations, line };
}

function parseVariableDecl(node: Node, type: string): VariableDecl {
  const declarator = node.type === "init_declarator" ? field(node, "declarator") : node;
  let initializer = node.type === "init_declarator" ? field(node, "value") : undefined;
  // Tree-sitter can parse direct construction such as vector<int> values(n)
  // as a function declarator because the single argument is ambiguous with a
  // function prototype. In a local declaration, treat it as construction.
  if (declarator?.type === "function_declarator") {
    const parameters = field(declarator, "parameters");
    if (parameters) initializer = parameters;
  }
  const arrayNode = firstOfType(declarator, "array_declarator");
  const arraySizeNode = arrayNode?.namedChildren.find((part) => part.type !== "identifier");
  return {
    name: declarator ? findDeclaredName(declarator) : "<unknown>",
    type,
    initializer: initializer
      ? initializer.type === "parameter_list"
        ? { kind: "list", values: initializer.namedChildren.map((argument) => parseExpression(argument.namedChildren[0] ?? argument)), form: "arguments", line: lineOf(initializer) }
        : parseExpression(initializer)
      : undefined,
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
    case "type_identifier":
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
      if (node.type === "pointer_expression") {
        const argument = field(node, "argument") ?? node.namedChildren[0];
        return argument ? { kind: "unary", operator: field(node, "operator")?.text ?? node.text[0] ?? "*", argument: parseExpression(argument), line } : { kind: "unsupported", label: "pointer expression", line };
      }
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
    case "lambda_expression": {
      const declarator = node.namedChildren.find((child) => child.type === "abstract_function_declarator" || child.type === "function_declarator");
      const parameters = declarator?.namedChildren.find((child) => child.type === "parameter_list")?.namedChildren
        .filter((child) => child.type === "parameter_declaration")
        .map(parseParameter) ?? [];
      const body = node.namedChildren.find((child) => child.type === "compound_statement");
      return { kind: "lambda", parameters, body: body ? parseStatement(body) : { kind: "empty", line }, line };
    }
    case "template_function":
      return { kind: "identifier", name: node.namedChildren[0]?.text ?? node.text.split("<")[0] ?? "", line };
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
    case "initializer_list_expression":
      return { kind: "list", values: node.namedChildren.map(parseExpression), form: "braces", line };
    case "argument_list":
      return { kind: "list", values: node.namedChildren.map(parseExpression), form: "arguments", line };
    case "cast_expression":
    case "type_cast_expression":
      return node.namedChildren.length > 1
        ? parseExpression(node.namedChildren.at(-1)!)
        : { kind: "unsupported", label: "type casts", line };
    case "new_expression": {
      const type = field(node, "type")?.text ?? node.namedChildren.find((part) => part.type === "type_identifier")?.text ?? "";
      const args = (field(node, "arguments") ?? node.namedChildren.find((part) => part.type === "argument_list"))?.namedChildren.map(parseExpression) ?? [];
      return { kind: "call", callee: `new:${type}`, args, line };
    }
    case "delete_expression": {
      const argument = node.namedChildren[0];
      return argument ? { kind: "call", callee: "delete", args: [parseExpression(argument)], line } : { kind: "literal", value: undefined, line };
    }
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
  if (text.includes("&")) return true;
  if (typeNode?.type === "template_type") {
    return false;
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
