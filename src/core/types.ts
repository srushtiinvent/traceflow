export type FlowKind = "start" | "end" | "process" | "decision" | "return" | "call";

export type FlowNode = {
  id: string;
  label: string;
  kind: FlowKind;
  line: number;
  code: string;
  lines?: number[];
};

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
};

export type SyntaxIssue = { line: number; message: string };

export type FunctionGraph = {
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
};

export type ProgramGraph = {
  functions: FunctionGraph[];
  errors: SyntaxIssue[];
};

export type RuntimeError = { line: number; message: string; nodeId?: string };
export type TraceSnapshot = {
  line: number;
  nodeId: string;
  variables: Record<string, unknown>;
  frames: string[];
  frameVariables: Record<string, Record<string, unknown>>;
  output: string;
  changes: string[];
  reads: string[];
};

export type RunResult = {
  snapshots: TraceSnapshot[];
  error?: RuntimeError;
  output: string;
  variables: Record<string, unknown>;
};

export type Expr =
  | { kind: "literal"; value: unknown; line: number }
  | { kind: "identifier"; name: string; line: number }
  | { kind: "unary" | "update"; operator: string; argument: Expr; prefix?: boolean; line: number }
  | { kind: "binary" | "assignment"; operator: string; left: Expr; right: Expr; line: number }
  | { kind: "conditional"; condition: Expr; consequence: Expr; alternative: Expr; line: number }
  | { kind: "call"; callee: string; args: Expr[]; line: number }
  | { kind: "index"; object: Expr; index: Expr; line: number }
  | { kind: "member"; object: Expr; property: string; line: number }
  | { kind: "list"; values: Expr[]; line: number }
  | { kind: "unsupported"; label: string; line: number };

export type VariableDecl = {
  name: string;
  type: string;
  initializer?: Expr;
  arraySize?: Expr;
  line: number;
};

export type Stmt =
  | { kind: "block"; body: Stmt[]; line: number }
  | { kind: "declaration"; declarations: VariableDecl[]; line: number }
  | { kind: "expression"; expression: Expr; line: number }
  | { kind: "if"; condition: Expr; consequence: Stmt; alternative?: Stmt; line: number }
  | { kind: "while"; condition: Expr; body: Stmt; line: number }
  | { kind: "do"; condition: Expr; body: Stmt; line: number }
  | { kind: "for"; initializer?: Stmt; condition?: Expr; update?: Expr; body: Stmt; line: number }
  | { kind: "rangeFor"; variable: VariableDecl; iterable: Expr; body: Stmt; line: number }
  | { kind: "return"; value?: Expr; line: number }
  | { kind: "break" | "continue"; line: number }
  | { kind: "empty"; line: number }
  | { kind: "unsupported"; label: string; line: number };

export type Parameter = { name: string; type: string; line: number };
export type FunctionAst = {
  name: string;
  returnType: string;
  parameters: Parameter[];
  body: Stmt;
  line: number;
};
export type CppProgram = { functions: FunctionAst[]; errors: SyntaxIssue[] };

export type TraceVariable = {
  name: string;
  value: unknown;
  type: string;
};