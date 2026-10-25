/** Add an entry point for snippets and small functions/classes. Full programs
 * that already define main pass through unchanged. */
export function prepareCppSource(source, entryName = '') {
  if (/\bmain\s*\([^)]*\)\s*\{/.test(source)) return { source, error: '' };

  const includes = [];
  const bodyLines = [];
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*#\s*\w+/.test(line)) includes.push(line);
    else if (/^\s*using\s+namespace\b/.test(line)) includes.push(line);
    else bodyLines.push(line);
  }
  const body = bodyLines.join('\n').trim();
  const functionPattern = /(?:^|[;{}:])\s*((?:[\w:<>*&]+\s+)+)([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:const\s*)?\{/gm;
  const functions = [...body.matchAll(functionPattern)];

  if (functions.length) {
    const entry = functions.find((candidate) => candidate[2] === entryName) ?? functions[0];
    const name = entry[2];
    const parameters = splitParameters(entry[3].trim());
    const className = body.match(/\bclass\s+(\w+)/)?.[1] ?? body.match(/\bstruct\s+(\w+)/)?.[1];
    const args = [];
    const reads = [];
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index];
      const match = parameter.match(/^(.*?)\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?$/);
      if (!match) return { source, error: `TraceFlow could not read the parameter “${parameter}” for ${name}(). Give each parameter a name.` };
      const type = match[1].replace(/\bconst\b/g, '').replace(/&&?/g, '').trim();
      const variable = `traceflow_arg_${index}`;
      if (/\b(vector|array)\s*</.test(type)) {
        const cppType = type.replace(/\bvector\b/g, 'std::vector');
        const nested = /\bvector\s*<\s*(?:std::)?vector\s*</.test(type);
        const fallback = nested
          ? `else { std::cerr << "Enter nested vector input as bracketed arrays, for example [[1,0],[0,1]].\\n"; return 2; }`
          : `else { std::size_t ${variable}_size = 0; std::cin >> ${variable}_size; ${variable}.resize(${variable}_size); for (auto& item : ${variable}) std::cin >> item; }`;
        reads.push(`${cppType} ${variable}{}; if (std::cin >> std::ws && std::cin.peek() == '[') traceflow_read_input(std::cin, ${variable}); ${fallback}`);
      } else {
        reads.push(`${type} ${variable}{}; std::cin >> ${variable};`);
      }
      args.push(variable);
    }
    const receiver = className ? `traceflow_entry.${name}` : name;
    const returnType = entry[1].match(/([\w:<>]+)\s*[*&]*\s*$/)?.[1] ?? 'auto';
    const invocation = `${receiver}(${args.join(', ')})`;
    const result = returnType === 'void' ? `${invocation};` : `auto traceflow_result = ${invocation}; std::cout << traceflow_result << '\\n';`;
    const setup = `${className ? `${className} traceflow_entry{}; ` : ''}${reads.join(' ')} ${result}`;
    const supportIncludes = ['#include <iostream>', '#include <vector>', '#include <cstddef>'].filter((required) =>
      !includes.some((line) => line.includes(required.slice(required.indexOf('<')))));
    const vectorReader = `template <typename T> bool traceflow_read_input(std::istream& input, std::vector<T>& values);\ntemplate <typename T> bool traceflow_read_input(std::istream& input, T& value) { return static_cast<bool>(input >> value); }\ntemplate <typename T> bool traceflow_read_input(std::istream& input, std::vector<T>& values) { char ch; if (!(input >> ch) || ch != '[') return false; while (input >> std::ws && input.peek() != ']') { T value{}; if (!traceflow_read_input(input, value)) return false; values.push_back(std::move(value)); input >> std::ws; if (input.peek() == ',') input.get(); else if (input.peek() != ']') return false; } input.get(); return true; }`;
    return { source: `${supportIncludes.join('\n')}\n${includes.join('\n')}\n${vectorReader}\n${body}\n\nint main() { ${setup} return 0; }`, error: '' };
  }

  return { source: `${includes.join('\n')}\nint main() {\n${body}\n  return 0;\n}\n`, error: '' };
}

function splitParameters(text) {
  if (!text || text === 'void') return [];
  const parameters = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '<') depth += 1;
    else if (text[index] === '>') depth -= 1;
    else if (text[index] === ',' && depth === 0) {
      parameters.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parameters.push(text.slice(start).trim());
  return parameters;
}
