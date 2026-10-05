declare module 'monaco-editor/esm/vs/editor/edcore.main';
declare module 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
