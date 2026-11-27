import { defineConfig } from "vitest/config";

// Minimal config: ESM-native, NodeNext-friendly. The package's `.js`
// extension imports work as-is — vitest resolves them through its own
// resolver without needing the jest+--experimental-vm-modules dance.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
