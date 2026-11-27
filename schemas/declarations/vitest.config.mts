import { defineConfig } from "vitest/config";

// The declaration bindings at `<Declaration>/v1/bindings/typescript` are part of this package
// rather than workspace packages of their own, so their tests are reached only through this
// config, run by the `test:declarations` script. That name, rather than `test`, because these
// suites import sources whose dependencies only this workspace provides: under `test` a
// consumer's `turbo test` or `pnpm -r test` on a vendored schemas/declarations would select
// them and fail on the first import it cannot resolve (CORE-2968).
//
// Each binding keeps its own config and is extended here as a project, so one invocation runs
// every suite and a new declaration adds an entry rather than editing a shared glob. The names
// are set here rather than in the bindings' configs because every one of those directories is
// called `typescript`, which vitest rejects as a duplicate project name.
export default defineConfig({
  test: {
    projects: [
      {
        extends: "FulfillmentAuthorization/v1/bindings/typescript/vitest.config.mts",
        root: "FulfillmentAuthorization/v1/bindings/typescript",
        test: { name: "FulfillmentAuthorization" },
      },
      {
        extends: "PaymentRequest/v1/bindings/typescript/vitest.config.mts",
        root: "PaymentRequest/v1/bindings/typescript",
        test: { name: "PaymentRequest" },
      },
    ],
  },
});
