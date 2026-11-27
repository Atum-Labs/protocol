// Thin shim over the shared guard (@atum-labs/publish-guard). The invariants and
// their tests live in tooling/publish-guard; this package's inputs live in
// ../publish-guard.config.mjs.
//
// The file stays at this path because CI invokes it directly
// (`node schemas/apis/x402/v1/bindings/x402-atum-escrow/scripts/check-publishable.mjs`).
import { fileURLToPath, URL } from 'node:url';
import { checkPublishable, loadConfig } from '@atum-labs/publish-guard';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const cfg = await loadConfig(pkgRoot);
const ok = checkPublishable({ pkgRoot, consumer: cfg.consumer, requiredFiles: cfg.requiredFiles });
process.exit(ok ? 0 : 1);
