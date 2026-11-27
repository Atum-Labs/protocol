// Thin shim over the shared notices generator (@atum-labs/publish-guard). The
// generation logic and its tests live in tooling/publish-guard; this package's
// header text lives in ../publish-guard.config.mjs.
//
// Run after `pnpm build`:  pnpm gen:notices
// Do NOT hand-edit THIRD-PARTY-NOTICES.txt — edit the generator or the config.
import { fileURLToPath, URL } from 'node:url';
import { generateNotices, loadConfig } from '@atum-labs/publish-guard';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const cfg = await loadConfig(pkgRoot);
generateNotices({ pkgRoot, displayName: cfg.displayName, externalDepsNote: cfg.externalDepsNote });
