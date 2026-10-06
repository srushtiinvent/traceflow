# TraceFlow

TraceFlow has two execution paths:

- **Visualise** uses the in-browser interpreter and records snapshots for the flowchart. It supports a growing C++ subset, not the complete language.
- **Compile & run** submits the source and standard input to the optional hosted compiler runner. It uses GCC C++20 and shows real stdout, compiler diagnostics, and exit status. This mode does not create variable-by-variable flowchart snapshots.

The local development server includes a compiler endpoint, so **Compile & run works on localhost** without a separate service. It requires `clang++` on your machine. Local programs run with your user account's permissions: only run code you trust.

GitHub Pages is static and cannot run a compiler process. For **Compile & run on the deployed website**, deploy the included isolated runner on a separate Linux host and configure the GitHub Actions variable described below. These are separate execution backends; both return compiler output, while only Visualise creates step-by-step traces.

## Run the website

```bash
npm install
npm run dev
npm run build
```

On macOS, install the compiler tools if needed with `xcode-select --install`; check availability with `clang++ --version`. The dev server binds to `127.0.0.1` and handles `POST /api/run` itself.

## Deploy the compiler runner

The included runner is intended for a dedicated Linux VM with Docker installed and a rootless Docker daemon. Put it behind an HTTPS reverse proxy. Do not expose the Docker socket or the runner on a shared, sensitive host: user-submitted C++ is untrusted code. The runner disables network access for programs, limits memory, CPU, process count, input, output, and run time, but container isolation is not a substitute for a dedicated host or stronger sandbox such as gVisor/Firecracker.

On the VM:

```bash
cd runner
cp env.example .env
# Edit .env and set TRACEFLOW_ALLOWED_ORIGINS to the exact website origin.
docker compose up --build -d
```

The API listens on port `8787` and exposes `POST /api/run` plus `GET /api/health`. Configure the reverse proxy to forward those paths to the runner. For this repository's GitHub Pages workflow, add a repository Actions variable named `CPP_RUNNER_URL` containing the public endpoint, such as `https://cpp-runner.example/api/run`. The allowed origin in the runner must exactly match the Pages site origin (for a project site, typically `https://OWNER.github.io`). Then rerun the Pages deployment. The deployment workflow now stops if this variable is missing, rather than publishing a site whose compile button cannot work. For other hosts, build the website with the public HTTPS runner URL:

```bash
VITE_CPP_RUNNER_URL=https://cpp-runner.example/api/run npm run build
```

For a same-origin proxy, `/api/run` is the default URL. Use ingress-level rate limits and request limits as well as the runner's built-in per-IP limit. Never put secrets in `VITE_CPP_RUNNER_URL`; frontend build variables are public. The hosted compiler service must be deployed and reachable before the GitHub Pages deployment can run native C++.

## Development

- `src/core/parser.ts` parses C++ with tree-sitter WebAssembly.
- `src/core/graph.ts` builds static control-flow charts.
- `src/core/interpreter.ts` executes the visualisable subset and captures trace snapshots.
- `runner/server.mjs` accepts compile requests and starts isolated compiler containers.
- `runner/Dockerfile` builds the GCC runtime image.
