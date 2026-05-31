import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Drop-in browser distribution: bundles the existing token-inspect panel plus
// its own React/ReactDOM into a single UMD + ES library, so a host page only
// needs a `<script>` tag and a `TokenInspect.init(...)` call.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // ORDER matters: core must resolve before react, because the react
      // package's source imports `@token-inspect/core`.
      "@token-inspect/core": fileURLToPath(new URL("../core/src", import.meta.url)),
      "@token-inspect/react": fileURLToPath(new URL("../react/src", import.meta.url)),
    },
  },
  build: {
    lib: {
      entry: "src/index.ts",
      name: "TokenInspect",
      fileName: (f) => `token-inspect.${f === "umd" ? "umd.cjs" : "es.js"}`,
      formats: ["umd", "es"],
    },
    rollupOptions: {
      // React + ReactDOM are intentionally BUNDLED (no externals) so the script
      // is a true zero-dependency drop-in.
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
