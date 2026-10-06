import { buildProgramGraph } from "./graph";
import { parseProgram } from "./parser";
import type { Expr, FunctionAst, RunResult, RuntimeError, Stmt, TraceSnapshot } from "./types";

const STEP_LIMIT = 5_000;
const CALL_LIMIT = 200;
const inputStream = Symbol("cin");
const outputStream = Symbol("cout");
const endLine = Symbol("endl");
const uninitialized = Symbol("uninitialized");

type Frame = {
  fn: FunctionAst;
  vars: Map<string, unknown>;
  types: Map<string, string>;
  scopes: Array<{ vars: Map<string, unknown>; types: Map<string, string> }>;
};

type Location =
  | { kind: "variable"; vars: Map<string, unknown>; name: string }
  | { kind: "property"; object: Record<string, unknown>; name: string }
  | { kind: "cell"; array: unknown[]; index: number; name: string }
  | { kind: "mapEntry"; map: { entries: Array<{ key: unknown; value: unknown }> }; key: unknown; name: string };
type RuntimeLambda = { __traceflowLambda: true; fn: FunctionAst };
type RuntimeIterator = { __traceflowIterator: true; array: unknown[]; index: number };

class RuntimeFault extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = "RuntimeFault";
  }
}

class FlowSignal {
  constructor(readonly type: "return" | "break" | "continue", readonly value?: unknown) {}
}

export function runProgram(source: string, stdin: string): RunResult {
  const parsed = parseProgram(source);
  const snapshots: TraceSnapshot[] = [];
  const output: string[] = [];
  let error: RuntimeError | undefined;
  let stepCount = 0;
  const functions = new Map(parsed.functions.map((fn) => [fn.name, fn]));
  const classes = new Map(parsed.classes.map((type) => [type.name, type]));
  const main = functions.get("main");
  const frames: Frame[] = [];
  const tokens = stdin.split(/\s+/).filter(Boolean);
  let inputIndex = 0;
  let returned: unknown;
  const reads = new Set<string>();
  const changes = new Set<string>();
  const graphs = buildProgramGraph(source).functions;
  const graphByFunction = new Map(graphs.map((graph) => [graph.name, graph]));

  const currentFrame = () => frames.at(-1);
  const resolveVariable = (name: string) => {
    for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
      const frame = frames[frameIndex]!;
      for (let scopeIndex = frame.scopes.length - 1; scopeIndex >= 0; scopeIndex -= 1) {
        const scope = frame.scopes[scopeIndex]!;
        if (scope.vars.has(name)) return { frame, vars: scope.vars, types: scope.types };
      }
      if (frame.vars.has(name)) return { frame, vars: frame.vars, types: frame.types };
    }
    return undefined;
  };
  const resolveThisProperty = (name: string) => {
    for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
      const frame = frames[frameIndex]!;
      const instance = frame.vars.get("this");
      if (instance && typeof instance === "object" && name in instance) {
        return instance as Record<string, unknown>;
      }
    }
    return undefined;
  };
  const typeOfVariable = (name: string) => resolveVariable(name)?.types.get(name);
  const currentVariables = () => {
    const result: Record<string, unknown> = {};
    for (const frame of frames) {
      for (const [name, value] of visibleVariables(frame)) {
        const key = frames.filter((candidate) => visibleVariables(candidate).has(name)).length > 1
          ? `${frame.fn.name}.${name}`
          : name;
        result[key] = clone(value);
      }
    }
    return result;
  };
  const frameVariables = () => Object.fromEntries(frames.map((frame, index) => {
    const name = `${frame.fn.name}${frames.slice(0, index).filter((previous) => previous.fn.name === frame.fn.name).length ? ` #${frames.slice(0, index).filter((previous) => previous.fn.name === frame.fn.name).length + 1}` : ""}`;
    return [name, Object.fromEntries([...visibleVariables(frame)].map(([key, value]) => [key, clone(value)]))];
  }));
  const nodeForLine = (line: number) => {
    const fn = currentFrame()?.fn.name ?? "main";
    const nodes = graphByFunction.get(fn)?.nodes ?? [];
    const exact = nodes.find((node) => node.lines?.includes(line) || node.line === line);
    const nearby = exact ?? nodes
      .filter((node) => node.line <= line && node.kind !== "start" && node.kind !== "end")
      .sort((a, b) => b.line - a.line)[0];
    return nearby?.id ?? `${fn}:start`;
  };
  const record = (line: number) => {
    stepCount += 1;
    if (stepCount > STEP_LIMIT) throw new RuntimeFault("Possible infinite loop: execution stopped after 5,000 steps.", line);
    snapshots.push({
      line,
      nodeId: nodeForLine(line),
      variables: currentVariables(),
      frames: frames.map((frame) => frame.fn.name),
      frameVariables: frameVariables(),
      output: output.join(""),
      changes: [...changes],
      reads: [...reads],
    });
    changes.clear();
    reads.clear();
  };
  const fault = (message: string, line: number): never => {
    throw new RuntimeFault(message, line);
  };

  const execute = (statement: Stmt): void => {
    switch (statement.kind) {
      case "block": {
        const frame = currentFrame();
        if (!frame) return fault("A block is outside a function.", statement.line);
        frame.scopes.push({ vars: new Map(), types: new Map() });
        try {
          for (const child of statement.body) execute(child);
        } finally {
          frame.scopes.pop();
        }
        return;
      }
      case "empty":
        record(statement.line);
        return;
      case "unsupported":
        return fault(`${statement.label} are not supported yet.`, statement.line);
      case "declaration":
        for (const declaration of statement.declarations) {
          const frame = currentFrame();
          if (!frame) return fault("Variable declaration is outside a function.", declaration.line);
          const scope = currentScope(frame);
          if (scope.vars.has(declaration.name)) return fault(`“${declaration.name}” is already declared in this scope.`, declaration.line);
          const declaredClass = classTypeName(declaration.type);
          let value: unknown = classes.has(declaredClass) ? makeObject(declaredClass) : defaultValue(declaration.type);
          if (declaration.arraySize) {
            const size = toNumber(evaluate(declaration.arraySize));
            if (!Number.isInteger(size) || size < 0 || size > 100_000) return fault("Array size must be a non-negative integer no greater than 100,000.", declaration.line);
            value = Array.from({ length: size }, () => defaultValue(arrayElementType(declaration.type)));
          }
          if (declaration.initializer) {
            if (classes.has(declaredClass) && declaration.initializer.kind === "list" && declaration.initializer.form === "arguments") {
              construct(value, declaredClass, declaration.initializer.values.map(evaluate), declaration.line);
            } else {
            const initial = evaluate(declaration.initializer);
            if (declaration.type.includes("vector") && declaration.initializer.kind === "list" && declaration.initializer.form === "arguments" && Array.isArray(initial) && typeof initial[0] === "number") {
              const size = toNumber(initial[0]);
              if (!Number.isInteger(size) || size < 0 || size > 100_000) return fault("Vector size must be a non-negative integer no greater than 100,000.", declaration.line);
              value = Array.from({ length: size }, () => clone(initial.length > 1 ? initial[1] : defaultValue(arrayElementType(declaration.type))));
            } else value = Array.isArray(initial) ? clone(initial) : initial;
            }
          }
          scope.vars.set(declaration.name, value);
          scope.types.set(declaration.name, declaration.type);
          changes.add(declaration.name);
        }
        record(statement.line);
        return;
      case "expression":
        evaluate(statement.expression);
        record(statement.line);
        return;
      case "if": {
        const branch = truthy(evaluate(statement.condition));
        record(statement.line);
        if (branch) execute(statement.consequence);
        else if (statement.alternative) execute(statement.alternative);
        return;
      }
      case "while":
        while (truthy(evaluate(statement.condition))) {
          record(statement.line);
          try {
            execute(statement.body);
          } catch (signal) {
            if (signal instanceof FlowSignal && signal.type === "break") break;
            if (!(signal instanceof FlowSignal && signal.type === "continue")) throw signal;
          }
        }
        record(statement.line);
        return;
      case "do": {
        let first = true;
        while (first || truthy(evaluate(statement.condition))) {
          first = false;
          record(statement.line);
          try {
            execute(statement.body);
          } catch (signal) {
            if (signal instanceof FlowSignal && signal.type === "break") break;
            if (!(signal instanceof FlowSignal && signal.type === "continue")) throw signal;
          }
        }
        record(statement.line);
        return;
      }
      case "for": {
        const frame = currentFrame();
        if (!frame) return fault("For loop is outside a function.", statement.line);
        frame.scopes.push({ vars: new Map(), types: new Map() });
        try {
          if (statement.initializer) execute(statement.initializer);
          while (statement.condition ? truthy(evaluate(statement.condition)) : true) {
            record(statement.line);
            try {
              execute(statement.body);
            } catch (signal) {
              if (signal instanceof FlowSignal && signal.type === "break") break;
              if (!(signal instanceof FlowSignal && signal.type === "continue")) throw signal;
            }
            if (statement.update) {
              evaluate(statement.update);
              record(statement.update.line);
            }
          }
          record(statement.line);
        } finally {
          frame.scopes.pop();
        }
        return;
      }
      case "rangeFor": {
        const values = evaluate(statement.iterable);
        if (!Array.isArray(values) && typeof values !== "string" && !isStdContainer(values) && !isStdMap(values)) {
          fault("A range-for loop needs an array, vector, or string.", statement.line);
        }
        const frame = currentFrame();
        if (!frame) return fault("Range-for loop is outside a function.", statement.line);
        const rangeScope = { vars: new Map<string, unknown>(), types: new Map<string, string>() };
        frame.scopes.push(rangeScope);
        rangeScope.types.set(statement.variable.name, statement.variable.type);
        const iterable = isStdContainer(values) ? values.items : isStdMap(values) ? values.entries.map((entry) => ({ first: entry.key, second: entry.value })) : values as Iterable<unknown>;
        let rangeIndex = 0;
        for (const value of iterable) {
          rangeScope.vars.set(statement.variable.name, value);
          changes.add(statement.variable.name);
          record(statement.line);
          try {
            execute(statement.body);
          } catch (signal) {
            if (signal instanceof FlowSignal && signal.type === "break") break;
            if (!(signal instanceof FlowSignal && signal.type === "continue")) throw signal;
          } finally {
            // A reference range variable aliases its element in C++. Reflect
            // assignments (including cin >> value) back into the source vector.
            if (statement.variable.type.includes("&") && Array.isArray(values)) {
              values[rangeIndex] = clone(rangeScope.vars.get(statement.variable.name));
            }
          }
          rangeIndex += 1;
        }
        frame.scopes.pop();
        record(statement.line);
        return;
      }
      case "return":
        returned = statement.value ? evaluate(statement.value) : undefined;
        record(statement.line);
        throw new FlowSignal("return", returned);
      case "break":
      case "continue":
        record(statement.line);
        throw new FlowSignal(statement.kind);
    }
  };

  const evaluate = (expression: Expr): unknown => {
    switch (expression.kind) {
      case "literal":
        return expression.value;
      case "unsupported":
        return fault(`${expression.label} are not supported yet.`, expression.line);
      case "identifier": {
        if (expression.name === "cin") return inputStream;
        if (expression.name === "cout") return outputStream;
        if (expression.name === "endl") return endLine;
        if (expression.name === "NULL") return null;
        if (expression.name === "true") return true;
        if (expression.name === "false") return false;
        const resolved = resolveVariable(expression.name);
        const frame = resolved?.frame;
        if (!frame) {
          const instance = resolveThisProperty(expression.name);
          if (!instance) return fault(`“${expression.name}” is not defined.`, expression.line);
          reads.add(expression.name);
          return instance[expression.name];
        }
        reads.add(expression.name);
        const value = resolved!.vars.get(expression.name);
        if (value === uninitialized) fault(`“${expression.name}” is used before it is initialized.`, expression.line);
        return value;
      }
      case "list":
        return expression.values.map(evaluate);
      case "lambda":
        return { __traceflowLambda: true, fn: { name: expression.name ?? "<lambda>", returnType: "auto", parameters: expression.parameters, body: expression.body, line: expression.line } } satisfies RuntimeLambda;
      case "index": {
        const object = evaluate(expression.object);
        const index = evaluate(expression.index);
        if (isStdMap(object)) {
          const entry = object.entries.find((candidate) => candidate.key === index);
          if (entry) return entry.value;
          const rootName = expression.object.kind === "identifier" ? expression.object.name : "";
          const type = rootName ? typeOfVariable(rootName) ?? "" : "";
          const mappedType = mapValueType(type);
          const value = mappedType ? defaultValue(mappedType) : undefined;
          object.entries.push({ key: index, value });
          changes.add(`${rootName}[${format(index)}]`);
          return value;
        }
        const numeric = toNumber(index);
        if (!Number.isInteger(numeric)) fault("An array index must be an integer.", expression.line);
        if (!Array.isArray(object) && typeof object !== "string") return fault("Only arrays, vectors, and strings can be indexed.", expression.line);
        if (numeric < 0 || numeric >= object.length) fault(`Index ${numeric} is out of bounds for length ${object.length}.`, expression.line);
        reads.add(`${expressionText(expression.object)}[${numeric}]`);
        return object[numeric];
      }
      case "member": {
        const object = evaluate(expression.object);
        if (object === null || object === undefined) return fault("Cannot access a field through nullptr.", expression.line);
        if (expression.property === "size" && Array.isArray(object)) return object.length;
        if (expression.property === "length" && typeof object === "string") return object.length;
        return (object as Record<string, unknown> | null)?.[expression.property];
      }
      case "unary": {
        const value = evaluate(expression.argument);
        switch (expression.operator) {
          case "!": return !truthy(value);
          case "-": return -toNumber(value);
          case "+": return toNumber(value);
          case "~": return ~toNumber(value);
          case "*":
            if (value === null || value === undefined) return fault("Cannot dereference nullptr.", expression.line);
            return value;
          case "&": return value;
          default:
            return fault(`Unary operator “${expression.operator}” is not supported yet.`, expression.line);
        }
      }
      case "update": {
        const location = getLocation(expression.argument, expression.line);
        const oldValue = readLocation(location, expression.line);
        const next = toNumber(oldValue) + (expression.operator === "++" ? 1 : -1);
        writeLocation(location, next);
        return expression.prefix ? next : oldValue;
      }
      case "assignment": {
        const location = getLocation(expression.left, expression.line);
        const right = evaluate(expression.right);
        const previous = expression.operator === "=" ? undefined : readLocation(location, expression.line);
        const value = expression.operator === "="
          ? right
          : applyOperator(expression.operator.slice(0, -1), previous, right, expression.line);
        writeLocation(location, value);
        return value;
      }
      case "binary": {
        if (expression.operator === "<<" && isOutputChain(expression.left)) {
          for (const part of streamParts(expression, "<<")) {
            const value = evaluate(part);
            output.push(value === endLine ? "\n" : format(value));
          }
          return outputStream;
        }
        if (expression.operator === ">>" && isInputChain(expression.left)) {
          for (const part of streamParts(expression, ">>")) {
            const location = getLocation(part, expression.line);
            const token = tokens[inputIndex++];
            if (token === undefined) fault("cin ran out of input. Add the missing value to the input box.", expression.line);
            writeLocation(location, convertInput(token, variableType(location)));
          }
          return inputStream;
        }
        const left = evaluate(expression.left);
        if (expression.operator === "&&" && !truthy(left)) return false;
        if (expression.operator === "||" && truthy(left)) return true;
        const right = evaluate(expression.right);
        return applyOperator(expression.operator, left, right, expression.line);
      }
      case "conditional":
        return truthy(evaluate(expression.condition))
          ? evaluate(expression.consequence)
          : evaluate(expression.alternative);
      case "call": {
        const args = expression.args.map(evaluate);
        const name = expression.callee;
        const builtinName = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
        if (name.startsWith("new:")) {
          const typeName = name.slice(4);
          if (!classes.has(typeName)) return fault(`Cannot allocate unknown type “${typeName}”.`, expression.line);
          const object = makeObject(typeName);
          construct(object, typeName, args, expression.line);
          return object;
        }
        if (name === "delete") return undefined;
        if (classes.has(name)) {
          const object = makeObject(name);
          construct(object, name, args, expression.line);
          return object;
        }
        const lastSeparator = name.lastIndexOf(".");
        const method = lastSeparator >= 0 ? name.slice(lastSeparator + 1) : name;
        const receiver = lastSeparator >= 0 ? args[0] : undefined;
        const callArgs = lastSeparator >= 0 ? args.slice(1) : args;
        if (lastSeparator >= 0) return callMethod(receiver, method, callArgs, expression.line);
        switch (builtinName) {
          case "min": return Math.min(...callArgs.map(toNumber));
          case "max": return Math.max(...callArgs.map(toNumber));
          case "abs": return Math.abs(toNumber(callArgs[0]));
          case "sort": {
            const first = callArgs[0];
            const last = callArgs[1];
            if (!isRuntimeIterator(first) || !isRuntimeIterator(last) || first.array !== last.array) {
              return fault("sort() expects begin/end iterators from the same vector.", expression.line);
            }
            const compare = callArgs[2];
            const values = first.array.slice(first.index, last.index);
            values.sort((left, right) => {
              if (compare && typeof compare === "object" && "__traceflowLambda" in compare) {
                return truthy(executeLambda(compare as RuntimeLambda, [left, right], expression.line)) ? -1 : 1;
              }
              return toNumber(left) - toNumber(right);
            });
            first.array.splice(first.index, values.length, ...values);
            changes.add(nameOfValue(first.array));
            return undefined;
          }
          case "accumulate": {
            const first = callArgs[0];
            const last = callArgs[1];
            if (!isRuntimeIterator(first) || !isRuntimeIterator(last) || first.array !== last.array) {
              return fault("accumulate() expects begin/end iterators from the same vector.", expression.line);
            }
            let result: unknown = callArgs[2] ?? 0;
            const operation = callArgs[3];
            for (const value of first.array.slice(first.index, last.index)) {
              if (operation && typeof operation === "object" && "__traceflowLambda" in operation) {
                result = executeLambda(operation as RuntimeLambda, [result, value], expression.line);
              } else result = applyOperator("+", result, value, expression.line);
            }
            return result;
          }
          case "vector": {
            const size = toNumber(callArgs[0]);
            if (!Number.isInteger(size) || size < 0 || size > 100_000) return fault("Vector size must be a non-negative integer no greater than 100,000.", expression.line);
            return Array.from({ length: size }, () => clone(callArgs.length > 1 ? callArgs[1] : 0));
          }
          case "swap": {
            if (expression.args.length !== 2) fault("swap expects two values.", expression.line);
            const first = getLocation(expression.args[0]!, expression.line);
            const second = getLocation(expression.args[1]!, expression.line);
            const old = readLocation(first, expression.line);
            writeLocation(first, readLocation(second, expression.line));
            writeLocation(second, old);
            return undefined;
          }
          default: {
            const callable = resolveVariable(name)?.vars.get(name) as RuntimeLambda | undefined;
            if (callable?.__traceflowLambda) return executeLambda(callable, callArgs, expression.line);
            const self = currentFrame()?.vars.get("this");
            if (self && typeof self === "object") {
              const owner = classes.get(String((self as Record<string, unknown>).__type ?? ""));
              if (owner?.methods.some((candidate) => candidate.name === name)) {
                return callMethod(self, name, callArgs, expression.line);
              }
            }
            return callFunction(name, callArgs, expression.line);
          }
        }
      }
    }
  };

  const getLocation = (expression: Expr, line: number): Location => {
    if (expression.kind === "identifier") {
      const resolved = resolveVariable(expression.name);
      if (!resolved) {
        const instance = resolveThisProperty(expression.name);
        if (instance) return { kind: "property", object: instance, name: expression.name };
        return fault(`“${expression.name}” is not defined.`, line);
      }
      return { kind: "variable", vars: resolved.vars, name: expression.name };
    }
    if (expression.kind === "member") {
      const object = evaluate(expression.object);
      if (!object || typeof object !== "object") return fault("Member access requires an object.", line);
      return { kind: "property", object: object as Record<string, unknown>, name: expression.property };
    }
    if (expression.kind === "unary" && expression.operator === "*") {
      const object = evaluate(expression.argument);
      if (!object || typeof object !== "object") return fault("Cannot dereference nullptr.", line);
      return { kind: "property", object: object as Record<string, unknown>, name: "value" };
    }
    if (expression.kind === "index") {
      const object = evaluate(expression.object);
      if (isStdMap(object)) {
        const key = evaluate(expression.index);
        return { kind: "mapEntry", map: object, key, name: `${expressionText(expression.object)}[${format(key)}]` };
      }
      if (!Array.isArray(object)) return fault("Only arrays and vectors can be assigned through an index.", line);
      const index = toNumber(evaluate(expression.index));
      if (!Number.isInteger(index) || index < 0 || index >= object.length) {
        fault(`Index ${index} is out of bounds for length ${object.length}.`, line);
      }
      return { kind: "cell", array: object, index, name: `${expressionText(expression.object)}[${index}]` };
    }
    return fault("This value cannot be assigned to.", line);
  };
  const readLocation = (location: Location, line: number) => {
    if (location.kind === "variable") {
      const value = location.vars.get(location.name);
      if (value === uninitialized) fault(`“${location.name}” is used before it is initialized.`, line);
      return value;
    }
    if (location.kind === "property") { reads.add(location.name); return location.object[location.name]; }
    if (location.kind === "mapEntry") {
      reads.add(location.name);
      return location.map.entries.find((entry) => entry.key === location.key)?.value;
    }
    reads.add(location.name);
    return location.array[location.index];
  };
  const writeLocation = (location: Location, value: unknown) => {
    if (location.kind === "variable") {
      location.vars.set(location.name, value);
      changes.add(location.name);
    } else if (location.kind === "property") {
      location.object[location.name] = value;
      changes.add(location.name);
    } else if (location.kind === "mapEntry") {
      const entry = location.map.entries.find((candidate) => candidate.key === location.key);
      if (entry) entry.value = value;
      else location.map.entries.push({ key: location.key, value });
      changes.add(location.name);
    } else {
      location.array[location.index] = value;
      changes.add(location.name);
    }
  };
  const variableType = (location: Location) =>
    location.kind === "variable" ? typeOfVariable(location.name) ?? "auto" : "auto";

  const callFunction = (name: string, args: unknown[], line: number): unknown => {
    const fn = functions.get(name);
    if (!fn) return fault(`Function “${name}” is not defined.`, line);
    if (frames.length >= CALL_LIMIT) fault("Call stack exceeded 200 frames; recursion stopped.", line);
    if (args.length !== fn.parameters.length) {
      fault(`${name} expects ${fn.parameters.length} argument${fn.parameters.length === 1 ? "" : "s"}, but received ${args.length}.`, line);
    }
    const frame: Frame = { fn, vars: new Map(), types: new Map(), scopes: [] };
    fn.parameters.forEach((parameter, index) => {
      frame.vars.set(parameter.name, args[index]);
      frame.types.set(parameter.name, parameter.type);
    });
    frames.push(frame);
    record(fn.line);
    let value: unknown;
    try {
      execute(fn.body);
      value = undefined;
    } catch (signal) {
      if (signal instanceof FlowSignal && signal.type === "return") value = signal.value;
      else throw signal;
    } finally {
      frames.pop();
    }
    returned = value;
    return value;
  };

  const executeLambda = (lambda: RuntimeLambda, args: unknown[], line: number) => {
    const fn = lambda.fn;
    if (args.length !== fn.parameters.length) return fault(`Lambda expects ${fn.parameters.length} arguments, but received ${args.length}.`, line);
    const frame: Frame = { fn, vars: new Map(), types: new Map(), scopes: [] };
    fn.parameters.forEach((parameter, index) => { frame.vars.set(parameter.name, args[index]); frame.types.set(parameter.name, parameter.type); });
    frames.push(frame); record(fn.line);
    try { execute(fn.body); return undefined; }
    catch (signal) { if (signal instanceof FlowSignal && signal.type === "return") return signal.value; throw signal; }
    finally { frames.pop(); }
  };

  const callMethod = (receiver: unknown, method: string, args: unknown[], line: number) => {
    if (receiver && typeof receiver === "object") {
      const typeName = String((receiver as Record<string, unknown>).__type ?? "");
      const type = classes.get(typeName);
      const fn = type?.methods.find((candidate) => candidate.name === method);
      if (fn) return executeMethod(fn, receiver, args, line);
    }
    if (isStdMap(receiver)) {
      const entries = receiver.entries;
      if (method === "size") return entries.length;
      if (method === "empty") return entries.length === 0;
      if (method === "clear") { entries.length = 0; changes.add(nameOfValue(receiver)); return undefined; }
      if (method === "count" || method === "contains") {
        const found = entries.some((entry) => entry.key === args[0]);
        return method === "contains" ? found : Number(found);
      }
      if (method === "erase") {
        const index = entries.findIndex((entry) => entry.key === args[0]);
        if (index >= 0) entries.splice(index, 1);
        changes.add(nameOfValue(receiver));
        return undefined;
      }
      if (method === "insert") {
        const pair = args[0];
        if (!Array.isArray(pair) || pair.length < 2) return fault(`${receiver.__container}.insert() expects a key/value pair.`, line);
        if (!entries.some((entry) => entry.key === pair[0])) entries.push({ key: pair[0], value: pair[1] });
        changes.add(nameOfValue(receiver));
        return undefined;
      }
      return fault(`${receiver.__container} method “${method}” is not supported yet.`, line);
    }
    if (isStdContainer(receiver)) {
      const items = receiver.items;
      const kind = receiver.__container;
      const label = kind;
      if (method === "size") return items.length;
      if (method === "empty") return items.length === 0;
      if (method === "push" || method === "push_back" || method === "push_front") {
        if (args.length !== 1) return fault(`${label}.${method}() expects one value.`, line);
        const value = args[0];
        if (kind === "set" || kind === "unordered_set") {
          if (!items.some((item) => item === value)) items.push(value);
        } else if (kind === "priority_queue") {
          items.push(value);
          items.sort((a, b) => receiver.__order === "min" ? toNumber(a) - toNumber(b) : toNumber(b) - toNumber(a));
        } else if ((method === "push_front" || kind === "stack") && kind !== "queue") items.unshift(value);
        else items.push(value);
        changes.add(nameOfValue(receiver));
        return undefined;
      }
      if (method === "pop" || method === "pop_back" || method === "pop_front") {
        if (!items.length) return fault(`${label}.${method}() cannot be used on an empty container.`, line);
        if (kind === "queue" || method === "pop_front") items.shift();
        else if (kind === "stack" || kind === "priority_queue") items.shift();
        else items.pop();
        changes.add(nameOfValue(receiver));
        return undefined;
      }
      if (method === "front" || method === "back" || method === "top") {
        if (!items.length) return fault(`${label}.${method}() cannot be used on an empty container.`, line);
        if (kind === "stack" || kind === "priority_queue") return items[0];
        return method === "front" ? items[0] : items.at(-1);
      }
      if (method === "insert" && (kind === "set" || kind === "unordered_set")) {
        if (args.length !== 1) return fault(`${label}.insert() expects one value.`, line);
        if (!items.some((item) => item === args[0])) items.push(args[0]);
        items.sort((a, b) => toNumber(a) - toNumber(b));
        changes.add(nameOfValue(receiver));
        return undefined;
      }
      if ((method === "count" || method === "contains") && (kind === "set" || kind === "unordered_set")) {
        const found = items.includes(args[0]);
        return method === "contains" ? found : Number(found);
      }
      if (method === "erase" && (kind === "set" || kind === "unordered_set")) {
        const index = items.indexOf(args[0]);
        if (index >= 0) items.splice(index, 1);
        changes.add(nameOfValue(receiver));
        return undefined;
      }
      return fault(`${label} method “${method}” is not supported yet.`, line);
    }
    if (Array.isArray(receiver) && (method === "begin" || method === "end")) {
      return { __traceflowIterator: true, array: receiver, index: method === "begin" ? 0 : receiver.length } satisfies RuntimeIterator;
    }
    if (method === "size" || method === "length") {
      if (Array.isArray(receiver) || typeof receiver === "string") return receiver.length;
      fault(`${method}() requires a vector, array, or string.`, line);
    }
    if (method === "empty") {
      if (Array.isArray(receiver) || typeof receiver === "string") return receiver.length === 0;
      fault("empty() requires a vector, array, or string.", line);
    }
    if (method === "back") {
      if (Array.isArray(receiver) && receiver.length > 0) return receiver.at(-1);
      fault("back() cannot be used on an empty vector.", line);
    }
    if (method === "push_back") {
      if (!Array.isArray(receiver)) return fault("push_back() requires a vector.", line);
      receiver.push(args[0]);
      changes.add(`${nameOfValue(receiver)}[${receiver.length - 1}]`);
      return undefined;
    }
    if (method === "pop_back") {
      if (!Array.isArray(receiver)) return fault("pop_back() requires a vector.", line);
      if (!receiver.length) fault("pop_back() cannot be used on an empty vector.", line);
      const index = receiver.length - 1;
      receiver.pop();
      changes.add(`${nameOfValue(receiver)}[${index}]`);
      return undefined;
    }
    if (method === "swap") {
      if (!Array.isArray(receiver) || !Array.isArray(args[0])) return fault("swap() requires two vectors.", line);
      const copy = [...receiver];
      receiver.splice(0, receiver.length, ...args[0]);
      (args[0] as unknown[]).splice(0, (args[0] as unknown[]).length, ...copy);
      changes.add(nameOfValue(receiver));
      changes.add(nameOfValue(args[0]));
      return undefined;
    }
    return fault(`Vector method “${method}” is not supported yet.`, line);
  };

  const makeObject = (name: string): Record<string, unknown> => {
    const type = classes.get(name)!;
    const object: Record<string, unknown> = {};
    Object.defineProperty(object, "__type", { value: name, enumerable: false });
    for (const field of type.fields) object[field.name] = defaultValue(field.type);
    return object;
  };
  const executeMethod = (fn: FunctionAst, self: unknown, args: unknown[], line: number) => {
    if (args.length !== fn.parameters.length) return fault(`${fn.name} expects ${fn.parameters.length} argument(s), but received ${args.length}.`, line);
    const frame: Frame = { fn, vars: new Map([["this", self]]), types: new Map([["this", "object"]]), scopes: [] };
    fn.parameters.forEach((parameter, index) => { frame.vars.set(parameter.name, args[index]); frame.types.set(parameter.name, parameter.type); });
    frames.push(frame); record(fn.line);
    try {
      if (self && typeof self === "object") {
        const classType = classes.get(String((self as Record<string, unknown>).__type ?? ""));
        if (classType?.name === fn.name) {
          for (const [field, initializers] of Object.entries(classType.constructorInitializers)) {
            (self as Record<string, unknown>)[field] = initializers.length ? evaluate(initializers[0]!) : undefined;
          }
        }
      }
      execute(fn.body); return undefined;
    }
    catch (signal) { if (signal instanceof FlowSignal && signal.type === "return") return signal.value; throw signal; }
    finally { frames.pop(); }
  };
  const construct = (object: unknown, name: string, args: unknown[], line: number) => {
    const type = classes.get(name)!;
    const constructor = type.methods.find((fn) => fn.name === name);
    if (constructor) executeMethod(constructor, object, args, line);
    else if (args.length) fault(`${name} has no matching constructor.`, line);
  };

  try {
    if (parsed.errors.length) {
      const first = parsed.errors[0]!;
      throw new RuntimeFault(first.message, first.line);
    }
    if (!main) throw new RuntimeFault("No main() function was found.", 1);
    callFunction("main", [], main.line);
    if (returned !== undefined) {
      // The return value is exposed in the final snapshot for inspection.
      const final = snapshots.at(-1);
      if (final) final.variables["$return"] = clone(returned);
    }
  } catch (caught) {
    if (caught instanceof RuntimeFault) {
      error = { line: caught.line, message: caught.message, nodeId: nodeForLine(caught.line) };
      if (stepCount < STEP_LIMIT) {
        try {
          record(caught.line);
        } catch {
          // The cap was already reached; the last recorded snapshot remains useful.
        }
      }
    } else if (caught instanceof FlowSignal) {
      error = { line: main?.line ?? 1, message: `${caught.type} used outside a matching statement.` };
    } else {
      error = { line: main?.line ?? 1, message: caught instanceof Error ? caught.message : "The program stopped with an unknown error." };
    }
  }
  return {
    snapshots,
    error,
    output: output.join(""),
    variables: snapshots.at(-1)?.variables ?? {},
    unusedInput: tokens.slice(inputIndex),
  };

  function applyOperator(operator: string, left: unknown, right: unknown, line: number): unknown {
    const a = left as number | string;
    const b = right as number | string;
    switch (operator) {
      case "+": return typeof a === "string" || typeof b === "string" ? String(a) + String(b) : toNumber(a) + toNumber(b);
      case "-": return toNumber(a) - toNumber(b);
      case "*": return toNumber(a) * toNumber(b);
      case "/":
        if (toNumber(b) === 0) fault("Division by zero.", line);
        return toNumber(a) / toNumber(b);
      case "%":
        if (toNumber(b) === 0) fault("Division by zero.", line);
        return toNumber(a) % toNumber(b);
      case "<": return (a as never) < (b as never);
      case "<=": return (a as never) <= (b as never);
      case ">": return (a as never) > (b as never);
      case ">=": return (a as never) >= (b as never);
      case "==": return a === b;
      case "!=": return a !== b;
      case "&&": return truthy(left) && truthy(right);
      case "||": return truthy(left) || truthy(right);
      case "&": return toNumber(a) & toNumber(b);
      case "|": return toNumber(a) | toNumber(b);
      case "^": return toNumber(a) ^ toNumber(b);
      case "<<": return toNumber(a) << toNumber(b);
      case ">>": return toNumber(a) >> toNumber(b);
      default: return fault(`Operator “${operator}” is not supported yet.`, line);
    }
  }

  function isOutputChain(expression: Expr): boolean {
    return expression.kind === "identifier" && expression.name === "cout" ||
      expression.kind === "binary" && expression.operator === "<<" && isOutputChain(expression.left);
  }
  function isInputChain(expression: Expr): boolean {
    return expression.kind === "identifier" && expression.name === "cin" ||
      expression.kind === "binary" && expression.operator === ">>" && isInputChain(expression.left);
  }
  function streamParts(expression: Expr, operator: "<<" | ">>"): Expr[] {
    if (expression.kind === "binary" && expression.operator === operator) {
      return [...streamParts(expression.left, operator), expression.right];
    }
    return [];
  }
}

function defaultValue(type: string): unknown {
  if (type.trimEnd().endsWith("*")) return null;
  if (type.includes("unordered_map")) return { __container: "unordered_map", entries: [] as Array<{ key: unknown; value: unknown }> };
  if (type.includes("map")) return { __container: "map", entries: [] as Array<{ key: unknown; value: unknown }> };
  for (const container of ["priority_queue", "unordered_set", "queue", "stack", "deque", "set"]) {
    if (type.includes(container)) return { __container: container, __order: container === "priority_queue" && type.includes("greater") ? "min" : "max", items: [] as unknown[] };
  }
  if (type.includes("vector")) return [];
  if (type.includes("string")) return "";
  if (type.includes("bool")) return false;
  if (type.includes("char")) return "\0";
  if (type.includes("int") || type.includes("double") || type.includes("float") || type.includes("long") || type.includes("short")) return 0;
  return uninitialized;
}

function classTypeName(type: string) {
  return type.replace(/\*+$/, "").split("<", 1)[0]!.trim();
}

function currentScope(frame: Frame) {
  return frame.scopes.at(-1) ?? { vars: frame.vars, types: frame.types };
}

function visibleVariables(frame: Frame) {
  const visible = new Map(frame.vars);
  for (const scope of frame.scopes) {
    for (const [name, value] of scope.vars) visible.set(name, value);
  }
  return visible;
}

function arrayElementType(type: string) {
  return type.includes("vector") ? type.slice(type.indexOf("<") + 1, type.lastIndexOf(">")) : type;
}

function toNumber(value: unknown) {
  if (typeof value === "boolean") return value ? 1 : 0;
  const converted = Number(value);
  if (!Number.isFinite(converted)) return 0;
  return converted;
}

function truthy(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function format(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "nullptr";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (isStdContainer(value)) return `${value.__container}{${value.items.map(format).join(", ")}}`;
  if (isStdMap(value)) return `${value.__container}{${value.entries.map((entry) => `${format(entry.key)}: ${format(entry.value)}`).join(", ")}}`;
  return String(value);
}

function isStdContainer(value: unknown): value is { __container: string; __order?: string; items: unknown[] } {
  return Boolean(value && typeof value === "object" && typeof (value as { __container?: unknown }).__container === "string" && Array.isArray((value as { items?: unknown }).items));
}

function isStdMap(value: unknown): value is { __container: "map" | "unordered_map"; entries: Array<{ key: unknown; value: unknown }> } {
  return Boolean(value && typeof value === "object" && ["map", "unordered_map"].includes(String((value as { __container?: unknown }).__container)) && Array.isArray((value as { entries?: unknown }).entries));
}

function isRuntimeIterator(value: unknown): value is RuntimeIterator {
  return Boolean(value && typeof value === "object" && "__traceflowIterator" in value && Array.isArray((value as RuntimeIterator).array));
}

function mapValueType(type: string) {
  const start = type.indexOf("<");
  const end = type.lastIndexOf(">");
  if (start < 0 || end <= start) return "";
  const argumentsText = type.slice(start + 1, end);
  let depth = 0;
  for (let i = 0; i < argumentsText.length; i += 1) {
    if (argumentsText[i] === "<") depth += 1;
    else if (argumentsText[i] === ">") depth -= 1;
    else if (argumentsText[i] === "," && depth === 0) return argumentsText.slice(i + 1).trim();
  }
  return "";
}

function convertInput(token: string, type: string) {
  if (type.includes("string")) return token;
  if (type.includes("char")) return token[0] ?? "";
  if (type.includes("bool")) return token === "true" || token === "1";
  const number = Number(token);
  if (Number.isNaN(number)) return token;
  return number;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === "object") {
    if ((value as { __traceflowLambda?: boolean }).__traceflowLambda) {
      const label = `[Function: ${(value as unknown as RuntimeLambda).fn.name}]`;
      return label as T;
    }
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, clone(nested)])) as T;
  }
  return value;
}

function nameOfValue(value: unknown) {
  if (isStdMap(value)) return value.__container;
  if (isStdContainer(value)) return value.__container;
  return Array.isArray(value) ? "vector" : "array";
}

function expressionText(expression: Expr): string {
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind === "literal") return String(expression.value);
  if (expression.kind === "index") return `${expressionText(expression.object)}[${expressionText(expression.index)}]`;
  return "value";
}
