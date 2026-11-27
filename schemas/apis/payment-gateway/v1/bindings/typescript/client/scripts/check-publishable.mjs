// Thin shim over the shared guard (@atum-labs/publish-guard). The invariants and
// their tests live in tooling/publish-guard; this package's inputs live in
// ../publish-guard.config.mjs.
//
// The file stays at this path because CI and the publish workflow invoke it
// directly (`node schemas/apis/payment-gateway/v1/bindings/typescript/client/scripts/check-publishable.mjs`).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { checkPublishable, loadConfig } from '@atum-labs/publish-guard';
import { loadHosts } from '../../../../../../../scripts/hosts.mjs';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

/** The packed defaultGateway / OpenAPI.BASE must be hosts.yaml payment-gateway testnet. */
export function assertPackedDefaultMatchesSsot(root, { load } = {}) {
  const hosts = loadHosts();
  const expected = hosts.apis['payment-gateway'].envs.testnet.url;
  const dist = resolve(root, 'dist/index.js');
  if (!existsSync(dist) && !load) {
    console.error('packed defaultGateway: dist/index.js missing; build first');
    return false;
  }
  let pkg;
  try {
    pkg = load ? load(dist) : createRequire(import.meta.url)(dist);
  } catch (err) {
    console.error(`packed defaultGateway: failed to load dist/index.js: ${err.message}`);
    return false;
  }
  if (pkg.defaultGateway !== expected) {
    console.error(`packed defaultGateway: expected ${expected}, got ${pkg.defaultGateway}`);
    return false;
  }
  if (pkg.OpenAPI?.BASE !== expected) {
    console.error(`packed OpenAPI.BASE: expected ${expected}, got ${pkg.OpenAPI?.BASE}`);
    return false;
  }
  return true;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cfg = await loadConfig(pkgRoot);
  const ok = checkPublishable({
    pkgRoot,
    consumer: cfg.consumer,
    requiredFiles: cfg.requiredFiles,
  });
  const hostOk = assertPackedDefaultMatchesSsot(pkgRoot);
  process.exit(ok && hostOk ? 0 : 1);
}
