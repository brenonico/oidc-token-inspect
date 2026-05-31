// Post-build Subresource Integrity (SRI) generator — spec §7 supply-chain
// hardening. Runs after `vite build` and emits `dist/integrity.json` mapping
// each emitted bundle to its `sha384-<base64>` integrity digest.
//
// A host page can then pin the script it loads, so a tampered/MITM'd bundle is
// rejected by the browser:
//
//   <script
//     src="https://cdn.example.com/token-inspect.umd.cjs"
//     integrity="sha384-<value-from-integrity.json>"
//     crossorigin="anonymous"></script>
//
// The `crossorigin="anonymous"` attribute is REQUIRED for the browser to
// enforce integrity on a cross-origin script.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");

// The two library artefacts Vite emits (see vite.config.ts `fileName`).
const TARGETS = ["token-inspect.umd.cjs", "token-inspect.es.js"];

/** Compute the `sha384-<base64>` SRI digest for a file's bytes. */
async function sriFor(file) {
  const bytes = await readFile(join(distDir, file));
  const digest = createHash("sha384").update(bytes).digest("base64");
  return `sha384-${digest}`;
}

async function main() {
  const integrity = {};
  for (const file of TARGETS) {
    try {
      integrity[file] = await sriFor(file);
    } catch (err) {
      // A missing target means the build did not emit it — fail loudly so the
      // build step (which chains this script) surfaces the problem.
      console.error(`[postbuild-sri] failed to hash ${file}:`, err.message);
      process.exitCode = 1;
      return;
    }
  }

  const outPath = join(distDir, "integrity.json");
  await writeFile(outPath, JSON.stringify(integrity, null, 2) + "\n", "utf8");

  console.log("[postbuild-sri] wrote dist/integrity.json:");
  for (const [file, hash] of Object.entries(integrity)) {
    console.log(`  ${file}  ${hash}`);
  }
}

main().catch((err) => {
  console.error("[postbuild-sri] unexpected error:", err);
  process.exitCode = 1;
});
