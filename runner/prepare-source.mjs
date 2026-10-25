/** Add a small entry point when a learner submits a statement snippet or a
 * parameterless helper function. Full programs that already define main pass
 * through unchanged. */
export function prepareCppSource(source) {
  if (/\bmain\s*\([^)]*\)\s*\{/.test(source)) return { source, error: '' };

  const includes = [];
  const bodyLines = [];
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*#\s*\w+/.test(line)) includes.push(line);
    else if (/^\s*using\s+namespace\b/.test(line)) includes.push(line);
    else bodyLines.push(line);
  }
  const body = bodyLines.join('\n').trim();
  const functionPattern = /^[ \t]*(?:[\w:<>*&]+\s+)+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:const\s*)?\{/gm;
  const functions = [...body.matchAll(functionPattern)];

  if (functions.length) {
    const entry = functions[0];
    const name = entry[1];
    const parameters = entry[2].trim();
    if (parameters && parameters !== 'void') {
      return { source, error: `No main() function was found. TraceFlow can start ${name}() automatically only when it has no parameters. Add a main() function to provide arguments.` };
    }
    return { source: `${includes.join('\n')}\n${body}\n\nint main() { ${name}(); return 0; }`, error: '' };
  }

  return { source: `${includes.join('\n')}\nint main() {\n${body}\n  return 0;\n}\n`, error: '' };
}
