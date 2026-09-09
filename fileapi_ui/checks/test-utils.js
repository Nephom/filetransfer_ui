import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

// Run the production TypeScript with explicit native/browser replacements.
// Each load has its own module cache, so tests do not share hook/module state.
export function loadTypeScript(path, { mocks = {}, globals = {}, importMeta } = {}) {
  const cache = new Map();
  const load = (filename) => {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const nativeRequire = createRequire(filename);
    const require = (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id.startsWith("@tauri-apps/") || id.startsWith("@crabnebula/")) throw new Error(`Native module must be explicitly mocked: ${id}`);
      if (id.endsWith(".css")) return {};
      if (id.startsWith(".")) {
        const base = resolve(dirname(filename), id);
        const dependency = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")]
          .find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate));
        if (dependency) return load(dependency);
      }
      return nativeRequire(id);
    };
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: filename,
      transformers: importMeta === undefined ? undefined : {
        before: [(context) => (source) => {
          const visit = (node) => ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword
            ? context.factory.createIdentifier("__testImportMeta")
            : ts.visitEachChild(node, visit, context);
          return ts.visitNode(source, visit);
        }],
      },
    }).outputText;
    const execute = new Function("require", "module", "exports", "__testImportMeta", ...Object.keys(globals), compiled);
    execute(require, module, module.exports, importMeta, ...Object.values(globals));
    return module.exports;
  };
  return load(resolve(sourceRoot, path));
}

export function hookDriver({ effects = true } = {}) {
  const slots = [], pending = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const i = cursor++;
      slots[i] ||= { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, (update) => { slots[i].value = typeof update === "function" ? update(slots[i].value) : update; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useEffect(effect, deps) {
      const i = cursor++, old = slots[i];
      if (!old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]))) {
        slots[i] = { deps, cleanup: old?.cleanup };
        if (effects) pending.push(() => { slots[i].cleanup?.(); slots[i].cleanup = effect(); });
      }
    },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    lazy: () => "lazy",
    Suspense: "suspense",
  };
  return {
    react,
    render(fn) { cursor = 0; const result = fn(); pending.splice(0).forEach((effect) => effect()); return result; },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export const nativeJson = (data, status = 200) => ({ status, body: Array.from(new TextEncoder().encode(JSON.stringify(data))) });
