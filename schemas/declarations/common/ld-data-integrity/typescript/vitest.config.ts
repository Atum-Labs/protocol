import { defineConfig } from "vitest/config";

// ESM-native; vitest resolves .js imports without the
// jest+--experimental-vm-modules dance. Pretest hook (npm script)
// snapshots contexts into src/contexts/ so canonicalize.ts can
// load them at test time without needing the dist/ build.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
