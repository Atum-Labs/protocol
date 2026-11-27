import { defineConfig } from "vitest/config";

// Minimal config: ESM-native, NodeNext-friendly. The package's `.js`
// extension imports resolve through vitest's own resolver without the
// jest+--experimental-vm-modules dance.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
