# TraceFlow

A live C++ → flowchart visualiser. Type C++ on the left and the flowchart updates as you type.
Press **Visualise** to run the program step by step (play / pause / step / scrub) and watch
variables, the call stack, arrays and output change.

Everything runs in your browser — no server, no accounts.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/ (serve dist/ with any static host)
npm test           # parser / flowchart / interpreter tests
```

## How it works

- `src/core/parser.ts` – parses C++ with tree-sitter (WebAssembly, in `public/`).
- `src/core/graph.ts` – turns the syntax tree into a control-flow graph (branches, loops, calls).
- `src/core/interpreter.ts` – runs a C++ subset and records a snapshot at every step.
- `src/App.tsx` – editor (Monaco), flowchart (React Flow + dagre), playback and inspectors.

## Supported C++

Variables, arithmetic, `if/else`, `for`, `while`, `do-while`, range-for, functions and recursion,
arrays, `vector`, `string`, `cin` / `cout`. Not supported yet: classes/structs, templates, pointers,
`map`/`set`, global variables. Runs are capped at 5,000 steps and 200 recursion frames.

## Notes

`package.json` pins `rollup` to 4.63.1 (`overrides`) because 4.64.0 hung while bundling in some environments.
