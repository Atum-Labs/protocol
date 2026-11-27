import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    // Root-level only, not recursive: the sub-packages below this directory (signing,
    // sender-auth, token-approval) are workspace packages that run their own tests, and a
    // recursive glob would run them a second time.
    include: ["*.test.ts"],
    environment: "node",
  },
});
