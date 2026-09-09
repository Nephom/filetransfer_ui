import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

// Run the production TypeScript with explicit native/browser replacements.
// Each load has its own module cache, so tests do not share hook/module state.
export function loadTypeScript(path, { mocks = {}, globals = {} } = {}) {
  const cache = new Map();
  const load = (filename) => {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const nativeRequire = createRequire(filename);
    const require = (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
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
    }).outputText;
    const execute = new Function("require", "module", "exports", ...Object.keys(globals), compiled);
    execute(require, module, module.exports, ...Object.values(globals));
    return module.exports;
  };
  return load(resolve(sourceRoot, path));
}
