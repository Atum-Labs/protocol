#!/usr/bin/env node
// Writes src/generated/abi.ts from the compiler-emitted ABIs in contracts/evm/source/generated/abi.
//
// The DEPLOYED contracts' ABIs (Escrow, FulfillmentProxy), not the interfaces: a log is emitted by
// the deployed address, and the concrete ABI carries every event it can emit, including the ones
// inherited from ITokenConfig and AccessControl that IEscrow does not declare.
//
// Deliberately NOT re-exported from src/index.ts. This package is CommonJS and is bundled into the
// payment-gateway client, mppx and x402 packages, where an index export ships the ~250 KB ABI in every
// one of their dist files whether or not they use it. Event decoders import it by path instead:
//
//   import { ESCROW_ABI } from '@atum-labs/evm-escrow-encoding/dist/generated/abi';
//
// A plain path rather than an `exports` subpath because consumers here resolve with node10, Bundler
// and NodeNext, and node10 ignores `exports`.
//
// generated-abi.test.ts compares the committed file byte for byte against render(), so a contract
// change that regenerates source/generated/abi without rerunning this fails the TypeScript lane.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ABI_DIR = resolve(scriptDir, '../../../../source/generated/abi');
export const OUT = resolve(scriptDir, '../src/generated/abi.ts');

const CONTRACTS = [
  ['ESCROW_ABI', 'Escrow'],
  ['FULFILLMENT_PROXY_ABI', 'FulfillmentProxy'],
];

export function render() {
  const lines = [
    '// GENERATED FILE -- DO NOT EDIT.',
    '//',
    '// Written by scripts/generate-abi.mjs from contracts/evm/source/generated/abi. Run',
    '// `pnpm run generate:abi` to regenerate; generated-abi.test.ts fails if it has drifted.',
    '',
  ];
  for (const [constName, contract] of CONTRACTS) {
    const abi = JSON.parse(readFileSync(resolve(ABI_DIR, `${contract}.json`), 'utf8'));
    lines.push(
      `/**`,
      ` * Full ABI of the deployed EVM ${contract} contract: functions, events, errors. TVM emits a`,
      ` * subset of these events with identical shapes, so it decodes Tron logs too; TVM-only`,
      ` * functions and errors are not in it.`,
      ` */`,
      `export const ${constName} = ${JSON.stringify(abi, null, 2)} as const;`,
      '',
    );
  }
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, render());
}
