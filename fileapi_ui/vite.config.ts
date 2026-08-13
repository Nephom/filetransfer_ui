import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";

const rootDir = path.resolve(__dirname, "..");
const readRootValue = (name: string) => fs.readFileSync(path.join(rootDir, name), "utf8").trim();
const gitCommit = process.env.GIT_COMMIT || childProcess.execFileSync("git", ["-C", rootDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const baseVersion = readRootValue("VERSION");
const releaseDate = readRootValue("RELEASE_DATE");
const resolvedVersion = `${baseVersion}-${gitCommit} (${releaseDate})`;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Never watch the Rust build output. `cargo`/`tauri dev` rewrites
    // thousands of intermediate files (.o/.d/.rlib) under src-tauri/target
    // while compiling; on Windows those files are exclusively locked while
    // being written, so Vite's watcher racing to stat/read them crashes
    // with EBUSY and takes down the whole "beforeDevCommand" process.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_"],
  define: {
    "import.meta.env.VITE_APP_VERSION_DISPLAY": JSON.stringify(resolvedVersion),
  }
});
