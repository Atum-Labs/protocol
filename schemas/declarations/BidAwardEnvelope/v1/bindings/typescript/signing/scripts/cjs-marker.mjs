#!/usr/bin/env node
// Writes a marker package.json into dist-cjs/ so Node treats the CJS
// output as CommonJS even though the root package.json declares
// "type": "module" for the ESM build. award-hash has no JSON-LD contexts
// (it is a pure keccak256 over ethers primitives), so this is the whole
// CJS step — no esbuild/contexts machinery.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
writeFileSync(
  resolve(__dirname, "../dist-cjs/package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
);
console.log("✅ dist-cjs/ marker written");
