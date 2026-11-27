import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Single source of truth for the CLI --version output: read it from the package
// manifest at build time and inject it as a compile-time constant (see
// src/version.ts). Injecting rather than reading the manifest at runtime keeps
// it independent of the built file's location in dist/.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

// The published package must be self-contained: it cannot reference the in-repo
// @atum-labs/* sibling packages (they are not on the registry). tsup inlines
// those first-party siblings into dist and keeps every third-party library
// external, so the shipped package depends only on real npm packages listed in
// dependencies. See package.json for the resolved external set.
export default defineConfig({
  define: { __PGC_VERSION__: JSON.stringify(version) },
  entry: [
    'src/index.ts',
    // Separate entry so the JSON-LD stack is only loaded by a consumer that imports /signing.
    // Bundling it into index would defeat the whole point of the subpath.
    'src/signing.ts',
    'src/cli/send-payment.ts',
    'src/cli/request-quote.ts',
    'src/cli/quote-status.ts',
    'src/cli/payment-status.ts',
    'src/cli/approve-permit2.ts',
    'src/cli/award-quote.ts',
  ],
  outDir: 'dist',
  format: ['cjs'],
  target: 'node18',
  // resolve: true makes the .d.ts bundler follow ALL imports and inline them,
  // including the relative re-exports inside the @atum-labs/* siblings (their
  // barrels do `export {...} from './chain-id'` etc.). Resolving only the
  // @atum-labs specifiers left those relative files dangling in the shipped
  // .d.ts, which breaks consumers on the default skipLibCheck. Third-party types
  // that are declared dependencies (e.g. axios) still resolve for the consumer.
  dts: { resolve: true },
  // No sourcemaps in the published package. tsup sourcemaps embed the original
  // TypeScript source (sourcesContent) of pgc and every bundled sibling, which
  // would ship that source to any consumer. The compiled dist stays readable,
  // but we do not hand over the original sources.
  sourcemap: false,
  clean: true,
  // Bundle the first-party monorepo siblings so no @atum-labs/* import survives
  // in the output. Everything else stays external (declared in dependencies).
  noExternal: [/^@atum-labs\//],
});
