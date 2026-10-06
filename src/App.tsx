import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Editor from '@monaco-editor/react';
import { ReactFlow, ReactFlowProvider, useReactFlow, Background, Controls, Handle, Position, type Edge as RFEdge, type EdgeProps, type Node as RFNode, type NodeProps } from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';
import {
  Activity, ArrowDownToLine, Braces, Check, ChevronDown, Code2, Copy, GitBranch,
  Layers3, Moon, Play, RotateCcw, SkipBack, SkipForward, Sun, Terminal,
  Variable, X,
} from 'lucide-react';
import { buildProgramGraph, initializeParser, runProgram } from './core/traceflow';
import type { FlowNode as FlowItem, FunctionGraph, ProgramGraph, RunResult, TraceSnapshot } from './core/types';
import { examples as cppExamples } from './core/examples';

type MobileView = 'code' | 'flow' | 'visualise';
type InspectorTab = 'variables' | 'stack' | 'arrays' | 'output';
type Example = { name: string; description: string; code: string; stdin?: string };
type NativeRun = { stdout: string; stderr: string; exitCode: number; timedOut?: boolean; error?: string };

const EXAMPLES: Example[] = cppExamples.map((example) => ({
  name: example.name,
  description: example.category,
  code: example.source,
  stdin: example.input,
}));

const INITIAL_CODE = EXAMPLES[0].code;

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function decodeBase64(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytes;
}
async function encodeSharedState(source: string, stdin: string) {
  if (!('CompressionStream' in window)) throw new Error('Compressed sharing is not supported in this browser.');
  const stream = new Blob([JSON.stringify({ source, stdin })]).stream()
    .pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return encodeBase64(bytes);
}
async function decodeSharedState(encoded: string) {
  if (!('DecompressionStream' in window)) throw new Error('This browser cannot open compressed TraceFlow links.');
  const compressed = decodeBase64(encoded);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const state = JSON.parse(await new Response(stream).text()) as { source?: string; stdin?: string };
  if (typeof state.source !== 'string' || typeof state.stdin !== 'string') {
    throw new Error('The shared link does not contain a valid program and input.');
  }
  return state;
}
function formatValue(value: unknown) {
  if (typeof value === 'string') return value.startsWith('[Function: ') ? value : `"${value}"`;
  if (Array.isArray(value)) return `[${value.map((item) => String(item)).join(', ')}]`;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function snapshotValues(snapshot?: TraceSnapshot): Record<string, unknown> {
  const vars = snapshot?.variables;
  if (!vars) return {};
  return Array.isArray(vars) ? Object.fromEntries(vars.map((item: any, index) => [item?.name ?? `item${index}`, item?.value])) : vars as Record<string, unknown>;
}
function nodeKind(node: FlowItem) {
  return String(node.kind ?? 'statement').replace(/[_-]/g, ' ');
}
function readDraft(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; }
  catch { return fallback; }
}

function App() {
  const [source, setSource] = useState(() => readDraft('traceflow-draft-source', INITIAL_CODE));
  const [stdin, setStdin] = useState(() => readDraft('traceflow-draft-stdin', ''));
  const [graph, setGraph] = useState<ProgramGraph | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [nativeRun, setNativeRun] = useState<NativeRun | null>(null);
  const [nativeRunning, setNativeRunning] = useState(false);
  const [parserReady, setParserReady] = useState(false);
  const [graphError, setGraphError] = useState('');
  const [syntaxIssues, setSyntaxIssues] = useState<Array<{ line: number; message: string }>>([]);
  const [staleGraph, setStaleGraph] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState('1×');
  const [functionName, setFunctionName] = useState('');
  const [followTraceFunction, setFollowTraceFunction] = useState(true);
  const [cursorLine, setCursorLine] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('traceflow-theme');
    return saved === 'dark' || saved === 'light' ? saved : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  });
  const [mobileView, setMobileView] = useState<MobileView>('code');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('variables');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [showExamples, setShowExamples] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareSource, setCompareSource] = useState('');
  const [compareRun, setCompareRun] = useState<RunResult | null>(null);
  const [compareEditorTab, setCompareEditorTab] = useState<'A' | 'B'>('A');
  const [stdinOpen, setStdinOpen] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const sourceRef = useRef(source);
  const editorRef = useRef<any>(null);
  const lineDecorations = useRef<string[]>([]);
  const activeFunctionRef = useRef<FunctionGraph | undefined>(undefined);
  sourceRef.current = source;

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2300);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('traceflow-theme', theme);
  }, [theme]);

  useEffect(() => {
    try { localStorage.setItem('traceflow-draft-source', source); } catch { /* Storage may be unavailable or full. */ }
  }, [source]);

  useEffect(() => {
    try { localStorage.setItem('traceflow-draft-stdin', stdin); } catch { /* Storage may be unavailable or full. */ }
    setNativeRun(null);
    setRun(null);
    setCompareRun(null);
  }, [stdin]);

  useEffect(() => {
    let active = true;
    initializeParser().then(() => {
      if (active) setParserReady(true);
    }).catch((error) => {
      if (active) setGraphError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith('#trace=')) {
      decodeSharedState(hash.slice(7)).then((state) => {
        setSource(state.source!);
        setStdin(state.stdin!);
      }).catch((error) => {
        notify(error instanceof Error ? error.message : 'This shared trace could not be decoded.');
      });
    }
  }, [notify]);

  useEffect(() => {
    if (!parserReady) return;
    const timeout = window.setTimeout(() => {
      try {
        const nextGraph: ProgramGraph = buildProgramGraph(source);
        const syntax = nextGraph.errors.filter((issue) =>
          issue.message.startsWith('Expected ') || issue.message.startsWith('Unexpected token'),
        );
        setRun(null);
        setCompareRun(null);
        setNativeRun(null);
        setActiveIndex(0);
        setIsPlaying(false);
        if (syntax.length) {
          setSyntaxIssues(syntax);
          setStaleGraph(true);
          setGraphError('');
          return;
        }
        setGraph(nextGraph);
        setSyntaxIssues(nextGraph.errors);
        setStaleGraph(false);
        setGraphError('');
        setFunctionName((current) => nextGraph.functions.some((fn) => fn.name === current) ? current : nextGraph.functions[0]?.name ?? '');
      } catch (error) {
        setGraphError(error instanceof Error ? error.message : String(error));
        setStaleGraph(true);
        setRun(null);
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [source, parserReady]);

  const snapshots = run?.snapshots ?? [];
  const activeSnapshot = snapshots[Math.min(activeIndex, Math.max(0, snapshots.length - 1))];
  const traceFunctionName = activeSnapshot?.nodeId.split(':')[0];
  const activeFunction: FunctionGraph | undefined = useMemo(
    () => (followTraceFunction ? graph?.functions.find((fn) => fn.name === traceFunctionName) : undefined) ?? graph?.functions.find((fn) => fn.name === functionName) ?? graph?.functions[0],
    [followTraceFunction, graph, functionName, traceFunctionName],
  );
  activeFunctionRef.current = activeFunction;
  const nodes = activeFunction?.nodes ?? [];
  const edges = activeFunction?.edges ?? [];
  const values = snapshotValues(activeSnapshot);
  const prevValues = activeIndex > 0 ? snapshotValues(snapshots[Math.min(activeIndex, snapshots.length - 1) - 1]) : {};
  const errors = syntaxIssues;
  const activeLine = activeSnapshot?.line ?? cursorLine;

  useEffect(() => {
    if (!isPlaying || snapshots.length < 2) return;
    const delay = speed === '0.5×' ? 1200 : speed === '2×' ? 300 : speed === '4×' ? 150 : 600;
    timerRef.current = window.setInterval(() => {
      setActiveIndex((current) => {
        if (current >= snapshots.length - 1) { setIsPlaying(false); return current; }
        return current + 1;
      });
    }, delay);
    return () => window.clearInterval(timerRef.current);
  }, [isPlaying, snapshots.length, speed]);

  useEffect(() => () => window.clearInterval(timerRef.current), []);
  useEffect(() => {
    if (!editorRef.current) return;
    const decorations: Array<{ range: any; options: any }> = errors.map((issue) => ({
      range: { startLineNumber: issue.line, startColumn: 1, endLineNumber: issue.line, endColumn: 1 },
      options: { isWholeLine: true, className: 'syntax-error-line', glyphMarginClassName: 'syntax-error-glyph', hoverMessage: { value: issue.message } },
    }));
    if (activeLine) decorations.push({
      range: { startLineNumber: activeLine, startColumn: 1, endLineNumber: activeLine, endColumn: 1 },
      options: { isWholeLine: true, className: 'trace-active-line', glyphMarginClassName: 'trace-active-glyph' },
    });
    lineDecorations.current = editorRef.current.deltaDecorations(lineDecorations.current, decorations);
    if (activeLine) editorRef.current.revealLineInCenterIfOutsideViewport(activeLine);
  }, [activeLine, errors]);

  const execute = useCallback((code: string, input: string) => {
    try { return runProgram(code, input); }
    catch (error) {
      notify(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [notify]);

  const runCurrent = useCallback(() => {
    const result = execute(sourceRef.current, stdin);
    if (!result) return;
    const firstAlgorithmStep = result.snapshots.findIndex((snapshot) => {
      const name = snapshot.nodeId.split(':')[0];
      // Skip trivial constructors/accessors (for example Box()) so a helper
      // object does not become the chart for an otherwise main()-driven run.
      return name !== 'main' && (graph?.functions.find((fn) => fn.name === name)?.nodes.length ?? 0) > 3;
    });
    const initialNodeId = result.snapshots[firstAlgorithmStep >= 0 ? firstAlgorithmStep : 0]?.nodeId;
    const initialFunction = initialNodeId?.split(':')[0] ?? 'main';
    setRun(result);
    setNativeRun(null);
    setCompareRun(null);
    setFunctionName(initialFunction);
    // Keep one function's chart visible throughout playback. The active step
    // can enter helper functions without replacing the user's current chart.
    setFollowTraceFunction(false);
    setActiveIndex(firstAlgorithmStep >= 0 ? firstAlgorithmStep : 0);
    setIsPlaying(false);
    setMobileView('visualise');
    notify(`${result.snapshots.length} steps ready`);
  }, [execute, graph, notify, stdin]);

  const compileAndRun = useCallback(async () => {
    setNativeRunning(true);
    setNativeRun(null);
    setRun(null);
    setCompareRun(null);
    try {
      const endpoint = import.meta.env.DEV
        ? `${window.location.origin}/api/run`
        : ((import.meta.env.VITE_CPP_RUNNER_URL as string | undefined) || `${window.location.origin}/api/run`);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: sourceRef.current, stdin }),
      });
      const responseText = await response.text();
      let payload: any;
      try {
        payload = JSON.parse(responseText);
      } catch {
        const detail = responseText.replace(/\s+/g, ' ').trim().slice(0, 300);
        throw new Error(`Compiler endpoint returned non-JSON (HTTP ${response.status})${detail ? `: ${detail}` : '.'} Check that CPP_RUNNER_URL points to the runner's /api/run endpoint.`);
      }
      if (!response.ok) throw new Error(payload.error || `Compiler service returned ${response.status}.`);
      setNativeRun(payload as NativeRun);
      setMobileView('visualise');
      setInspectorTab('output');
      notify(payload.exitCode === 0 ? 'C++ program finished' : 'C++ program exited with an error');
    } catch (error) {
      setNativeRun({ stdout: '', stderr: '', exitCode: 1, error: error instanceof Error ? error.message : 'Could not reach the compiler service.' });
      setMobileView('visualise');
      notify('Could not run with the C++ compiler');
    } finally {
      setNativeRunning(false);
    }
  }, [stdin, notify]);

  const step = (direction: number) => {
    setIsPlaying(false);
    setActiveIndex((current) => Math.max(0, Math.min(Math.max(0, snapshots.length - 1), current + direction)));
  };
  const seekNode = (nodeId: string) => {
    const selected = nodes.find((node) => node.id === nodeId);
    setSelectedNodeId(nodeId);
    if (selected && editorRef.current) {
      editorRef.current.setPosition({ lineNumber: selected.line, column: 1 });
      editorRef.current.revealLineInCenter(selected.line);
      setCursorLine(selected.line);
    }
    const snapshotIndex = snapshots.findIndex((snapshot) => snapshot.nodeId === nodeId);
    if (snapshotIndex >= 0) { setActiveIndex(snapshotIndex); setMobileView('visualise'); }
  };

  const loadExample = (example: Example) => {
    setSource(example.code);
    editorRef.current?.setScrollPosition({ scrollLeft: 0, scrollTop: 0 });
    setStdin(example.stdin ?? '');
    setShowExamples(false);
    setMobileView('code');
    notify(`${example.name} loaded`);
  };
  const shareCode = async () => {
    try {
      const url = `${window.location.origin}${window.location.pathname}#trace=${await encodeSharedState(source, stdin)}`;
      window.history.replaceState(null, '', url);
      await navigator.clipboard.writeText(url);
      notify('Compressed program and input link copied');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The share link could not be created.');
    }
  };

  const exportPng = () => {
    if (!nodes.length) { notify('Build a flowchart before exporting'); return; }
    const L = layoutGraph(nodes, edges);
    const light = theme === 'light';
    const c = light
      ? { bg: '#FFF7E6', node: '#FFFBF2', stroke: '#B46A72', text: '#2D3A47', muted: '#71808E', edge: '#71808E' }
      : { bg: '#0D0D11', node: '#16171D', stroke: '#A68B5B', text: '#D7D2C6', muted: '#A68B5B', edge: '#8E8A85' };
    const pathEls = edges.map((edge) => {
      const l = L.edges.get(edge.id); if (!l) return '';
      const label = edge.label ? `<rect x="${l.lx - 17}" y="${l.ly - 9}" width="34" height="18" rx="9" fill="${c.bg}" stroke="${c.edge}"/><text x="${l.lx}" y="${l.ly + 4}" text-anchor="middle" fill="${c.text}" font-size="10" font-family="monospace">${escapeXml(edge.label)}</text>` : '';
      return `<path d="${roundedPath(l.points)}" fill="none" stroke="${c.edge}" stroke-width="1.6" marker-end="url(#arrow)"/>${label}`;
    }).join('');
    const nodeEls = nodes.map((node) => {
      const p = L.nodes.get(node.id); if (!p) return '';
      const x = p.x - p.w / 2; const y = p.y - p.h / 2;
      const shape = node.kind === 'decision'
        ? `<polygon points="${p.x},${y} ${x + p.w},${p.y} ${p.x},${y + p.h} ${x},${p.y}" fill="${c.node}" stroke="${c.stroke}" stroke-width="1.4"/>`
        : `<rect x="${x}" y="${y}" width="${p.w}" height="${p.h}" rx="${node.kind === 'start' || node.kind === 'end' ? p.h / 2 : 9}" fill="${c.node}" stroke="${c.stroke}" stroke-width="1.4"/>`;
      return `<g>${shape}<text x="${p.x}" y="${p.y - 4}" text-anchor="middle" fill="${c.muted}" font-size="9" font-family="monospace">${escapeXml(nodeKind(node).toUpperCase())}</text><text x="${p.x}" y="${p.y + 11}" text-anchor="middle" fill="${c.text}" font-size="11" font-family="monospace">${escapeXml(shortLabel(node.label || node.code || `line ${node.line}`, node.kind === 'decision' ? 22 : 28))}</text></g>`;
    }).join('');
    const width = Math.ceil(L.width); const height = Math.ceil(L.height);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c.edge}"/></marker></defs><rect width="100%" height="100%" fill="${c.bg}"/>${pathEls}${nodeEls}</svg>`;
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * 2; canvas.height = height * 2;
      const context = canvas.getContext('2d');
      if (!context) { notify('Image export is not available in this browser'); return; }
      context.scale(2, 2); context.drawImage(image, 0, 0, width, height);
      const link = document.createElement('a');
      link.download = 'traceflow-chart.png'; link.href = canvas.toDataURL('image/png'); link.click();
      notify('Flowchart saved as an image');
    };
    image.onerror = () => notify('Could not render the flowchart image');
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  };

  const compare = () => {
    const resultA = execute(sourceRef.current, stdin);
    const resultB = execute(compareSource, stdin);
    if (resultA && resultB) {
      setRun(resultA);
      setNativeRun(null);
      setCompareRun(resultB);
      setActiveIndex(0);
      setIsPlaying(false);
      const status = resultA.error || resultB.error ? 'Comparison finished with a runtime error' : 'Both traces ran with the same input';
      notify(status);
    }
  };
  useEffect(() => { setCompareRun(null); }, [compareSource]);
  const comparisonSummary = useMemo(() => {
    if (!run || !compareRun) return null;
    const firstDifference = (() => {
      const count = Math.min(run.snapshots.length, compareRun.snapshots.length);
      for (let index = 0; index < count; index += 1) {
        const left = run.snapshots[index];
        const right = compareRun.snapshots[index];
        if (left.line !== right.line || left.nodeId !== right.nodeId || left.output !== right.output || JSON.stringify(left.variables) !== JSON.stringify(right.variables)) return index + 1;
      }
      return run.snapshots.length === compareRun.snapshots.length ? null : count + 1;
    })();
    return {
      outputMatches: run.output === compareRun.output,
      traceMatches: firstDifference === null,
      firstDifference,
      leftError: run.error ? `Line ${run.error.line}: ${run.error.message}` : '',
      rightError: compareRun.error ? `Line ${compareRun.error.line}: ${compareRun.error.message}` : '',
    };
  }, [run, compareRun]);
  const variables = Object.entries(values);
  const arrayVariables = variables.filter(([, value]) => Array.isArray(value));
  const frameList = activeSnapshot?.frames ?? [];
  const graphMessages = errors.length
    ? `${staleGraph ? 'Showing the last valid graph. ' : ''}${errors.map((issue) => `Line ${issue.line}: ${issue.message}`).join(' · ')}`
    : graphError;

  return (
    <div className={`tf-app ${mobileView === 'visualise' ? 'visualise-mode' : ''}`} data-testid="traceflow-app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true" />
          <div className="brand-word">trace<em>flow</em></div>
          <div className="workspace-title"><strong>Untitled program</strong><span>C++ visualiser</span></div>
        </div>
        <div className="top-actions">
          <button className="quiet-button" onClick={() => setShowExamples(true)} data-testid="button-examples"><Braces size={14} /><span>Examples</span><ChevronDown size={12} /></button>
          <button className="icon-button" title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} aria-label="Toggle color theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} data-testid="button-theme">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
        </div>
      </header>

      <main className="workspace">
        <div className="toolbar">
          <div className="file-title"><span className="file-dot" /><b>main.cpp</b><span>·</span><span>{source.split('\n').length} lines</span></div>
          <div className="toolbar-actions">
            <button className="quiet-button" onClick={() => setStdinOpen(true)} data-testid="button-stdin"><Terminal size={14} /><span>Input {stdin ? '· ready' : ''}</span></button>
            <button className="quiet-button" onClick={() => { setCompareOpen((current) => !current); if (!compareSource) setCompareSource(source); }} data-testid="button-compare"><Layers3 size={14} /><span>Compare</span></button>
            <button className="quiet-button" onClick={shareCode} data-testid="button-share"><Copy size={14} /><span>Share</span></button>
            <button className="quiet-button" onClick={exportPng} data-testid="button-export"><ArrowDownToLine size={14} /><span>PNG</span></button>
            <button className="quiet-button" onClick={compileAndRun} disabled={nativeRunning} data-testid="button-compile-run"><Terminal size={13} /> {nativeRunning ? 'Compiling…' : 'Compile & run'}</button>
            <button className="primary-button" onClick={runCurrent} data-testid="button-run"><Play size={13} fill="currentColor" /> Visualise <span className="pane-meta">⌘ ↵</span></button>
          </div>
        </div>

        <nav className="mobile-tabs" aria-label="Workspace view">
          {(['code', 'flow', 'visualise'] as MobileView[]).map((tab) => <button key={tab} className={`tab-button ${mobileView === tab ? 'selected' : ''}`} onClick={() => setMobileView(tab)} data-testid={`tab-mobile-${tab}`}>{tab === 'code' ? 'Code' : tab === 'flow' ? 'Flowchart' : 'Visualise'}</button>)}
        </nav>

        <section className="editor-flow-grid">
          <section className={`surface code-surface ${mobileView !== 'code' ? 'mobile-hidden' : ''}`} aria-label="C++ editor">
            <div className="pane-head">
              <div className="pane-label"><Code2 size={15} /> Source</div>
              <div className="pane-meta">C++ · {source.split('\n').length} LOC</div>
            </div>
            <div className="editor-frame">
              <div className="monaco-host" data-testid="input-source-code">
                <Editor
                  height="100%"
                  language="cpp"
                  theme={theme === 'dark' ? 'traceflow-dark' : 'traceflow-light'}
                  value={source}
                  onChange={(value) => setSource(value ?? '')}
                  onMount={(editor, monaco) => {
                    editorRef.current = editor;
                    monaco.editor.defineTheme('traceflow-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#0D0D11', 'editor.foreground': '#D7D2C6', 'editorLineNumber.foreground': '#8E8A85', 'editorLineNumber.activeForeground': '#A68B5B', 'editor.lineHighlightBackground': '#16171D', 'editor.selectionBackground': '#413A2D' } });
                    monaco.editor.defineTheme('traceflow-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#FFF7E6', 'editor.foreground': '#2D3A47', 'editorLineNumber.foreground': '#71808E', 'editorLineNumber.activeForeground': '#B46A72', 'editor.lineHighlightBackground': '#FFFBF2', 'editor.selectionBackground': '#F7C8D3' } });
                    monaco.editor.setTheme(theme === 'dark' ? 'traceflow-dark' : 'traceflow-light');
                    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runCurrent);
                  }}
                  options={{ minimap: { enabled: false }, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 22, tabSize: 4, insertSpaces: true, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 15, bottom: 14 }, lineNumbersMinChars: 3, renderLineHighlight: 'line', overviewRulerBorder: false, guides: { indentation: true }, suggestOnTriggerCharacters: true }}
                />
              </div>
            </div>
            <div className="editor-foot"><span><strong>{activeLine ? `Ln ${activeLine}` : 'Ready'}</strong> · C++17</span><span>Spaces: 4</span></div>
          </section>

          <section className={`surface flow-surface ${mobileView !== 'flow' ? 'mobile-hidden' : ''}`} aria-label="Program flowchart">
            <div className="pane-head">
              <div className="pane-label"><GitBranch size={15} /> Flowchart <span className="pane-meta">{nodes.length ? `${nodes.length} nodes` : ''}</span></div>
              <div className="flow-head-right">
                {graph?.functions?.length ? <select aria-label="Select function" value={activeFunction?.name ?? ''} onChange={(event) => { setFunctionName(event.target.value); setFollowTraceFunction(false); }} className="function-select" data-testid="select-function">{graph.functions.map((fn) => <option key={fn.name} value={fn.name}>{fn.name}()</option>)}</select> : null}
                <button className="icon-button" title="Reset" aria-label="Reset" onClick={() => { setRun(null); setActiveIndex(0); setIsPlaying(false); }} data-testid="button-reset"><RotateCcw size={14} /></button>
              </div>
            </div>
            <div className="flow-canvas">
              {nodes.length > 0 ? <FlowChart nodes={nodes} edges={edges} snapshots={snapshots} activeSnapshot={activeSnapshot} errorNodeId={run?.error && activeIndex >= snapshots.length - 1 ? (run.error.nodeId ?? snapshots[snapshots.length - 1]?.nodeId) : undefined} onSelect={seekNode} /> :
                <div className="flow-empty"><div className="empty-content"><div className="empty-glyph"><GitBranch size={22} /></div><h2>{graphMessages ? 'Fix this to continue' : 'Your flowchart appears here'}</h2><p>{graphMessages || 'Write some C++ on the left and its flowchart appears here. Press Visualise to watch it run step by step.'}</p></div></div>}
            </div>
            {graphMessages && nodes.length > 0 ? <div className="run-alert" data-testid="status-syntax-issues">{graphMessages}</div> : null}
            {nativeRun && !run ? <div className="run-info" data-testid="status-native-run-chart">Native C++ completed. This chart shows the program structure; native compilation does not capture step-by-step variable states. Use Visualise for an interpreter trace of the supported subset.</div> : null}
          </section>
        </section>

        <div className="mobile-visualiser"><Inspector activeSnapshot={activeSnapshot} values={values} prev={prevValues} arrays={arrayVariables} frames={frameList} result={run} nativeRun={nativeRun} selected={inspectorTab} onSelect={setInspectorTab} /></div>
        <section className="lower-grid">
          <Inspector activeSnapshot={activeSnapshot} values={values} prev={prevValues} arrays={arrayVariables} frames={frameList} result={run} nativeRun={nativeRun} selected={inspectorTab} onSelect={setInspectorTab} />
          {compareOpen ? <div className="surface compare-panel"><div className="compare-head"><h3>Compare traces</h3><div><button className="primary-button" onClick={compare} data-testid="button-run-compare"><Play size={12} /> Run comparison</button><button className="icon-button" onClick={() => setCompareOpen(false)} aria-label="Close comparison" data-testid="button-close-compare"><X size={14} /></button></div></div><p className="modal-hint">Both programs run in the visualiser with the same standard input. Native Compile &amp; run output is not part of trace comparison.</p><textarea aria-label="Comparison source code" value={compareSource} onChange={(event) => setCompareSource(event.target.value)} data-testid="input-compare-code" /><div className="compare-diff" data-testid="text-compare-results">{comparisonSummary ? `Trace: ${comparisonSummary.traceMatches ? 'same path and state at every step' : `first difference at step ${comparisonSummary.firstDifference}`}\nOutput: ${comparisonSummary.outputMatches ? 'matches' : 'differs'}\nSteps: ${run?.snapshots.length ?? 0} vs ${compareRun?.snapshots.length ?? 0}\nInput used for both: ${stdin.trim() || '(empty)'}${comparisonSummary.leftError ? `\nProgram A error: ${comparisonSummary.leftError}` : ''}${comparisonSummary.rightError ? `\nProgram B error: ${comparisonSummary.rightError}` : ''}\n\nProgram A output:\n${run?.output || '(empty)'}\n\nProgram B output:\n${compareRun?.output || '(empty)'}` : 'Edit a second version of the program, then run both traces to compare their output, executed path, variables, and step counts.'}</div></div> :
            <div className="surface compare-panel">
              <div className="pane-head"><div className="pane-label"><Activity size={15} /> Execution</div><span className="pane-meta">{nativeRun ? 'Compiler run' : run ? `${snapshots.length} captured steps` : 'Waiting for run'}</span></div>
              <div className="inspector-body">{nativeRun ? <><div className="state-grid"><div className="state-card"><span className="state-name">PROGRAM STATUS</span><span className="state-value">{nativeRun.error ? 'Service error' : nativeRun.timedOut ? 'Timed out' : `Exit ${nativeRun.exitCode}`}</span></div><div className="state-card"><span className="state-name">EXECUTION</span><span className="state-value">Native C++</span></div><div className="state-card"><span className="state-name">INPUT</span><span className="state-value">{stdin ? 'Provided' : 'Empty'}</span></div></div><div className="pane-meta" style={{ marginTop: 12, marginBottom: 6 }}>PROGRAM OUTPUT</div><pre className="output-text" data-testid="text-program-output">{nativeRun.stdout || '(no output)'}</pre>{nativeRun.error || nativeRun.stderr ? <><div className="pane-meta" style={{ marginTop: 12, marginBottom: 6 }}>{nativeRun.error ? 'RUNNER ERROR' : 'COMPILER / STDERR'}</div><pre className="output-text">{nativeRun.error || nativeRun.stderr}</pre></> : null}</> : run ? <><div className="state-grid"><div className="state-card"><span className="state-name">TRACE STATUS</span><span className="state-value">{run.error ? 'Runtime error' : 'Completed'}</span></div><div className="state-card"><span className="state-name">CURRENT STEP</span><span className="state-value">{snapshots.length ? `${activeIndex + 1} / ${snapshots.length}` : '—'}</span></div><div className="state-card"><span className="state-name">SOURCE LINE</span><span className="state-value">{activeLine || '—'}</span></div></div><div className="pane-meta" style={{ marginTop: 10 }}>INPUT USED · {stdin.trim() || '(empty)'}</div>{run.unusedInput?.length ? <div className="pane-meta" style={{ marginTop: 6 }}>UNUSED INPUT · {run.unusedInput.join(' ')}</div> : null}<div className="pane-meta" style={{ marginTop: 12, marginBottom: 6 }}>PROGRAM OUTPUT</div><pre className="output-text" data-testid="text-program-output">{run.output || '(no output)'}</pre>{run.error ? <div className="inspector-empty" style={{ minHeight: 32, alignItems: 'flex-start' }}>{run.error.message}</div> : null}</> : <div className="inspector-empty"><Activity size={18} /><span>Run with Compile &amp; run for C++ output, or Visualise for a supported step-by-step trace.</span></div>}</div>
            </div>}
        </section>
      </main>

      <div className="playback" role="group" aria-label="Trace playback controls">
        <button className="icon-button" title="First step" aria-label="Go to first step" disabled={!snapshots.length} onClick={() => { setActiveIndex(0); setIsPlaying(false); }} data-testid="button-first-step"><SkipBack size={15} /></button>
        <button className="icon-button" title="Previous step" aria-label="Previous step" disabled={!snapshots.length} onClick={() => step(-1)} data-testid="button-step-back"><SkipBack size={15} /></button>
        <button className="play-button" aria-label={isPlaying ? 'Pause trace' : 'Play trace'} disabled={snapshots.length < 2} onClick={() => { if (activeIndex >= snapshots.length - 1) setActiveIndex(0); setIsPlaying((playing) => !playing); }} data-testid="button-play-pause">{isPlaying ? <span className="pause-glyph">Ⅱ</span> : <Play size={14} fill="currentColor" />}</button>
        <button className="icon-button" title="Next step" aria-label="Next step" disabled={!snapshots.length} onClick={() => step(1)} data-testid="button-step-forward"><SkipForward size={15} /></button>
        <span className="playback-sub">{run ? 'PLAYBACK' : 'PRESS VISUALISE'}</span>
        <input className="scrubber" type="range" min={0} max={Math.max(0, snapshots.length - 1)} value={Math.min(activeIndex, Math.max(0, snapshots.length - 1))} disabled={!snapshots.length} aria-label="Trace step" onChange={(event) => { setIsPlaying(false); setActiveIndex(Number(event.target.value)); }} data-testid="input-trace-scrubber" />
        <span className="step-count">{snapshots.length ? `${activeIndex + 1} / ${snapshots.length}` : '0 / 0'}</span>
        <select className="speed-select" aria-label="Playback speed" value={speed} onChange={(event) => setSpeed(event.target.value)} data-testid="select-playback-speed"><option>0.5×</option><option>1×</option><option>2×</option><option>4×</option></select>
        <button className="icon-button mobile-inspector-open" onClick={() => setSheetOpen(true)} aria-label="Open inspectors" data-testid="button-open-inspector"><Variable size={15} /></button>
      </div>

      {sheetOpen ? <><button className="sheet-scrim" aria-label="Close inspector" onClick={() => setSheetOpen(false)} data-testid="button-close-inspector-scrim" /><Inspector activeSnapshot={activeSnapshot} values={values} prev={prevValues} arrays={arrayVariables} frames={frameList} result={run} nativeRun={nativeRun} selected={inspectorTab} onSelect={setInspectorTab} sheet onClose={() => setSheetOpen(false)} /></> : null}

      {showExamples ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowExamples(false); }}><div className="modal"><div className="modal-head"><h2>Start with an example</h2><button className="icon-button" aria-label="Close examples" onClick={() => setShowExamples(false)} data-testid="button-close-examples"><X size={15} /></button></div>{EXAMPLES.map((example) => <button key={example.name} className="example-item" onClick={() => loadExample(example)} data-testid={`button-example-${example.name.toLowerCase().replaceAll(' ', '-')}`}><span><b>{example.name}</b><small>{example.description}</small></span><ChevronDown size={14} /></button>)}</div></div> : null}
      {stdinOpen ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setStdinOpen(false); }}><div className="modal"><div className="modal-head"><h2>Program input</h2><button className="icon-button" aria-label="Close input" onClick={() => setStdinOpen(false)} data-testid="button-close-stdin"><X size={15} /></button></div><p className="modal-hint">Lines here are passed to the program as standard input.</p><textarea aria-label="Standard input" value={stdin} onChange={(event) => setStdin(event.target.value)} placeholder="Enter input, one line at a time…" data-testid="input-stdin" /><div className="modal-actions"><button className="quiet-button" onClick={() => setStdin('')} data-testid="button-clear-stdin">Clear</button><button className="primary-button" onClick={() => setStdinOpen(false)} data-testid="button-save-stdin"><Check size={13} /> Done</button></div></div></div> : null}
      {toast ? <div className="toast-note" role="status" data-testid="status-toast">{toast}</div> : null}
    </div>
  );
}

type NodeData = { label: string; runtime?: string; kind: string; shape: string; line: number; active: boolean; done: boolean; error: boolean; w: number; h: number };
type EdgeData = { points: Array<{ x: number; y: number }>; label?: string; lx: number; ly: number; active: boolean; taken: boolean };

function nodeSize(node: FlowItem) {
  if (node.kind === 'decision') return { w: 240, h: 108 };
  if (node.kind === 'start' || node.kind === 'end') return { w: 150, h: 66 };
  return { w: 220, h: 72 };
}
type Layout = {
  nodes: Map<string, { x: number; y: number; w: number; h: number }>;
  edges: Map<string, { points: Array<{ x: number; y: number }>; lx: number; ly: number }>;
  width: number; height: number;
};
function layoutGraph(nodes: FlowItem[], edges: Array<{ id: string; source: string; target: string; label?: string }>): Layout {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 56, ranksep: 46, marginx: 40, marginy: 32, ranker: 'network-simplex' });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((node) => { const s = nodeSize(node); g.setNode(node.id, { width: s.w, height: s.h }); });
  edges.forEach((edge) => {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge({ v: edge.source, w: edge.target, name: edge.id }, { width: edge.label ? 34 : 0, height: edge.label ? 16 : 0, labelpos: 'c' });
    }
  });
  dagre.layout(g);
  const nodeMap: Layout['nodes'] = new Map();
  nodes.forEach((node) => {
    const n = g.node(node.id);
    if (n) nodeMap.set(node.id, { x: n.x, y: n.y, w: n.width, h: n.height });
  });
  const edgeMap: Layout['edges'] = new Map();
  edges.forEach((edge) => {
    if (!g.hasNode(edge.source) || !g.hasNode(edge.target)) return;
    const e = g.edge({ v: edge.source, w: edge.target, name: edge.id });
    if (e) edgeMap.set(edge.id, { points: e.points, lx: e.x ?? e.points[0].x, ly: e.y ?? e.points[0].y });
  });
  const graph = g.graph();
  return { nodes: nodeMap, edges: edgeMap, width: graph.width ?? 400, height: graph.height ?? 300 };
}
function roundedPath(points: Array<{ x: number; y: number }>, radius = 12) {
  if (points.length < 2) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1]; const p1 = points[i]; const p2 = points[i + 1];
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1; const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const a = { x: p1.x - ((p1.x - p0.x) / l1) * r, y: p1.y - ((p1.y - p0.y) / l1) * r };
    const b = { x: p1.x + ((p2.x - p1.x) / l2) * r, y: p1.y + ((p2.y - p1.y) / l2) * r };
    d += ` L ${a.x} ${a.y} Q ${p1.x} ${p1.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}
function escapeXml(text: string) {
  return text.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char] ?? char));
}
function shortLabel(text: string, max = 30) { return text.length > max ? `${text.slice(0, max - 1)}…` : text; }

function TraceFlowNode({ data, selected }: NodeProps<RFNode<NodeData>>) {
  const { w, h, shape } = data;
  const cls = `flow-node-react shape-${shape} ${data.active ? 'active' : ''} ${data.done ? 'done' : ''} ${data.error ? 'error' : ''} ${selected ? 'selected' : ''}`;
  return <div className={cls} style={{ width: w, height: h }} title={data.label}>
    <Handle type="target" position={Position.Top} />
    {shape === 'decision' ? <svg className="node-diamond" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true"><polygon points={`${w / 2},1 ${w - 1},${h / 2} ${w / 2},${h - 1} 1,${h / 2}`} /></svg> : null}
    <span className="node-body">
      <span className="node-kicker">{data.kind}{data.line ? ` · L${data.line}` : ''}</span>
      <span className="node-code">{shortLabel(data.label, shape === 'decision' ? 22 : 28)}</span>
      {data.runtime ? <span className="node-runtime">{data.runtime}</span> : null}
    </span>
    <Handle type="source" position={Position.Bottom} />
  </div>;
}
function TraceFlowEdge({ id, data }: EdgeProps<RFEdge<EdgeData>>) {
  if (!data) return null;
  const cls = `flow-edge ${data.active ? 'active' : ''} ${data.taken ? 'taken' : ''}`;
  return <g>
    <path id={id} className={cls} d={roundedPath(data.points)} markerEnd={data.active ? 'url(#tf-arrow-active)' : 'url(#tf-arrow)'} />
    {data.label ? <g transform={`translate(${data.lx}, ${data.ly})`}><rect className="edge-label-bg" x={-17} y={-9} width={34} height={18} rx={9} /><text className="edge-label" textAnchor="middle" dominantBaseline="central">{data.label}</text></g> : null}
  </g>;
}
const flowNodeTypes = { traceNode: TraceFlowNode };
const flowEdgeTypes = { traceEdge: TraceFlowEdge };

function FlowInner({ nodes, edges, snapshots, activeSnapshot, errorNodeId, onSelect }: {
  nodes: FlowItem[]; edges: Array<{ id: string; source: string; target: string; label?: string }>;
  snapshots: TraceSnapshot[]; activeSnapshot?: TraceSnapshot; errorNodeId?: string; onSelect: (id: string) => void;
}) {
  const { fitView, setCenter, getZoom } = useReactFlow();
  const hostRef = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);
  const activeNodeId = activeSnapshot?.nodeId;
  const activeIndex = activeSnapshot ? snapshots.indexOf(activeSnapshot) : -1;
  const nextId = activeIndex >= 0 ? snapshots[activeIndex + 1]?.nodeId : undefined;
  const visited = useMemo(() => new Set(snapshots.map((snapshot) => snapshot.nodeId)), [snapshots]);
  const takenEdges = useMemo(() => {
    const set = new Set<string>();
    for (let i = 0; i < snapshots.length - 1; i++) set.add(`${snapshots[i].nodeId}>${snapshots[i + 1].nodeId}`);
    return set;
  }, [snapshots, activeIndex]);
  const runtimeByNode = useMemo(() => {
    const latest = new Map<string, { snapshot: TraceSnapshot; nextId?: string }>();
    snapshots.forEach((snapshot, index) => latest.set(snapshot.nodeId, { snapshot, nextId: snapshots[index + 1]?.nodeId }));
    return latest;
  }, [snapshots]);

  const rfNodes: RFNode<NodeData>[] = nodes.map((node) => {
    const p = layout.nodes.get(node.id) ?? { x: 0, y: 0, w: 220, h: 56 };
    const execution = runtimeByNode.get(node.id);
    const runtimeNames = [...new Set([...(execution?.snapshot.reads ?? []), ...(execution?.snapshot.changes ?? [])])];
    const runtimeValues = runtimeNames.flatMap((name) => {
      const entry = Object.entries(execution?.snapshot.variables ?? {}).find(([key]) => key === name || key.endsWith(`.${name}`));
      if (!entry || typeof entry[1] === 'object' && entry[1] !== null) return [];
      return [`${name}=${String(entry[1])}`];
    });
    const branch = execution?.nextId ? edges.find((edge) => edge.source === node.id && edge.target === execution.nextId)?.label : undefined;
    const runtime = [...runtimeValues.slice(0, 3), branch].filter(Boolean).join(' · ');
    return {
      id: node.id, type: 'traceNode', position: { x: p.x - p.w / 2, y: p.y - p.h / 2 }, width: p.w, height: p.h,
      data: { label: node.label || node.code || `Line ${node.line}`, runtime: runtime || undefined, kind: nodeKind(node), shape: node.kind, line: node.line, active: node.id === activeNodeId, done: visited.has(node.id), error: node.id === errorNodeId, w: p.w, h: p.h },
    };
  });
  const rfEdges: RFEdge<EdgeData>[] = edges.filter((e) => layout.edges.has(e.id)).map((edge) => {
    const l = layout.edges.get(edge.id)!;
    return { id: edge.id, source: edge.source, target: edge.target, type: 'traceEdge', data: { points: l.points, label: edge.label, lx: l.lx, ly: l.ly, active: edge.source === activeNodeId && edge.target === nextId, taken: takenEdges.has(`${edge.source}>${edge.target}`) } };
  });

  // Fit whenever the chart or its container size changes.
  useEffect(() => {
    const id = window.requestAnimationFrame(() => fitView({ padding: 0.12, maxZoom: 1.1, duration: 0 }));
    return () => window.cancelAnimationFrame(id);
  }, [layout, fitView]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    let timer = 0;
    const observer = new ResizeObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(() => fitView({ padding: 0.12, maxZoom: 1.1, duration: 0 }), 80); });
    observer.observe(host);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [fitView]);
  // Follow the active node while a trace plays.
  useEffect(() => {
    if (!activeNodeId) return;
    const p = layout.nodes.get(activeNodeId);
    if (p) setCenter(p.x, p.y, { zoom: Math.max(getZoom(), 0.9), duration: 250 });
  }, [activeNodeId, layout, setCenter, getZoom]);

  return <div className="flow-stage" ref={hostRef}>
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <marker id="tf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="arrow-fill" /></marker>
        <marker id="tf-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="arrow-fill-active" /></marker>
      </defs>
    </svg>
    <ReactFlow nodes={rfNodes} edges={rfEdges} nodeTypes={flowNodeTypes} edgeTypes={flowEdgeTypes} onNodeClick={(_event, node) => onSelect(node.id)} fitView fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }} minZoom={0.15} maxZoom={1.6} proOptions={{ hideAttribution: true }} nodesDraggable={false} nodesConnectable={false} elementsSelectable>
      <Background color="var(--grid)" gap={22} size={1} /><Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
function FlowChart(props: Parameters<typeof FlowInner>[0]) {
  return <ReactFlowProvider><FlowInner {...props} /></ReactFlowProvider>;
}

function Inspector({ activeSnapshot, values, prev = {}, arrays, frames, result, nativeRun, selected, onSelect, sheet = false, onClose }: {
  activeSnapshot?: TraceSnapshot; values: Record<string, unknown>; prev?: Record<string, unknown>; arrays: Array<[string, unknown]>;
  frames: unknown[]; result: RunResult | null; nativeRun?: NativeRun | null; selected: InspectorTab; onSelect: (tab: InspectorTab) => void; sheet?: boolean; onClose?: () => void;
}) {
  const tabs: { key: InspectorTab; title: string }[] = [{ key: 'variables', title: 'Variables' }, { key: 'stack', title: 'Call stack' }, { key: 'arrays', title: 'Arrays' }, { key: 'output', title: 'Output' }];
  let content;
  if (selected === 'variables') content = Object.keys(values).length ? <div className="state-grid">{Object.entries(values).map(([name, value]) => <div className={`state-card ${formatValue(prev[name]) !== formatValue(value) && activeSnapshot ? "changed" : ""}`} key={name} data-testid={`value-variable-${name}`}><span className="state-name">{name}</span><span className="state-value">{formatValue(value)}</span></div>)}</div> : <EmptyInspector icon={<Variable size={17} />} text={result ? 'No local variables in this frame.' : 'Run the program to inspect live values.'} />;
  else if (selected === 'stack') content = frames.length ? frames.map((frame, index) => <div className="stack-row" key={index} data-testid={`row-frame-${index}`}><span className="stack-index">{String(index + 1).padStart(2, '0')}</span><span className="stack-name">{String(frame)}</span></div>) : <EmptyInspector icon={<Layers3 size={17} />} text={result ? 'The call stack is empty.' : 'Stack frames appear after execution starts.'} />;
  else if (selected === 'arrays') content = arrays.length ? <div className="array-list">{arrays.map(([name, value]) => { const before = Array.isArray(prev[name]) ? prev[name] as unknown[] : []; return <div className="array-block" key={name} data-testid={`row-array-${name}`}><span className="array-name">{name}<small>[{(value as unknown[]).length}]</small></span><div className="array-cells">{(value as unknown[]).map((item, index) => <div className={`array-cell ${activeSnapshot && String(before[index]) !== String(item) ? 'changed' : ''}`} key={index} data-testid={`cell-${name}-${index}`}><span className="cell-value">{formatValue(item)}</span><span className="cell-index">{index}</span></div>)}</div></div>; })}</div> : <EmptyInspector icon={<Braces size={17} />} text={result ? 'No arrays in this frame.' : 'Arrays show up here as you run the program.'} />;
  else if (nativeRun) content = <>{nativeRun.stdout ? <pre className="output-text" data-testid="text-program-output">{nativeRun.stdout}</pre> : <EmptyInspector icon={<Terminal size={17} />} text={nativeRun.error ? 'Compiler service did not return program output.' : nativeRun.stderr ? 'No standard output. See compiler or runtime diagnostics below.' : 'Native C++ program completed without writing output.'} />}{nativeRun.error || nativeRun.stderr ? <><div className="pane-meta" style={{ marginTop: 12, marginBottom: 6 }}>{nativeRun.error ? 'RUNNER ERROR' : 'COMPILER / STDERR'}</div><pre className="output-text">{nativeRun.error || nativeRun.stderr}</pre></> : null}</>;
  else content = result?.output ? <div className="output-text" data-testid="text-program-output">{result.output}</div> : <EmptyInspector icon={<Terminal size={17} />} text={result ? 'Visualise finished without writing output.' : 'Program output will appear here.'} />;
  return <div className={`surface inspector ${sheet ? 'sheet' : ''}`} aria-label="Execution inspectors">
    <div className="inspector-tabs">{tabs.map((tab) => <button key={tab.key} className={`tab-button ${selected === tab.key ? 'selected' : ''}`} onClick={() => onSelect(tab.key)} data-testid={`tab-inspector-${tab.key}`}>{tab.title}</button>)}{sheet && onClose ? <button className="icon-button" style={{ marginLeft: 'auto' }} aria-label="Close inspector" onClick={onClose} data-testid="button-close-inspector"><X size={14} /></button> : null}</div>
    <div className="inspector-body">{activeSnapshot ? <div className="pane-meta" style={{ marginBottom: 10 }}>{activeSnapshot.line ? `LINE ${activeSnapshot.line}` : 'STEP'}{activeSnapshot.changes?.length ? ` · ${activeSnapshot.changes.slice(0, 3).join(', ')}` : ''}</div> : null}{content}</div>
  </div>;
}
function EmptyInspector({ icon, text }: { icon: ReactNode; text: string }) {
  return <div className="inspector-empty">{icon}<span>{text}</span></div>;
}

export default App;
