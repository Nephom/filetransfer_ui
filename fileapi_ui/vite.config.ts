import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Never watch the Rust build output. `cargo`/`tauri dev` rewrites
    // thousands of intermediate files (.o/.d/.rlib) under src-tauri/target
    // while compiling; on Windows those files are exclusively locked while
    // being written, so Vite's watcher racing to stat/read them crashes
    // with EBUSY and takes down the whole "beforeDevCommand" process.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_"]
});
