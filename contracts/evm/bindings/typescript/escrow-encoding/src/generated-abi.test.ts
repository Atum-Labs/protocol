/**
 * Drift guards for src/generated/abi.ts.
 *
 * 1. The committed file is exactly what scripts/generate-abi.mjs renders from
 *    contracts/evm/source/generated/abi, so a contract change cannot merge with stale TypeScript.
 * 2. Every event topic0 agrees with the Go golden the Go bindings are pinned to, so the two languages
 *    cannot decode the same log differently.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Interface } from 'ethers';
import { OUT, render } from '../scripts/generate-abi.mjs';
import { ESCROW_ABI, FULFILLMENT_PROXY_ABI } from './generated/abi';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GO_TOPIC0_GOLDEN = resolve(
  __dirname,
  '../../../go/escrow-encoding/encoding/testdata/event_topic0_golden.json',
);

describe('src/generated/abi.ts', () => {
  it('is what generate-abi.mjs renders from source/generated/abi', () => {
    expect(
      readFileSync(OUT, 'utf8'),
      'stale: run `pnpm run generate:abi` in contracts/evm/bindings/typescript/escrow-encoding',
    ).toBe(render());
  });

  it('agrees with the Go topic0 golden for every event it pins', () => {
    const golden = JSON.parse(readFileSync(GO_TOPIC0_GOLDEN, 'utf8')) as Record<
      string,
      Record<string, string>
    >;
    const byContract: Record<string, Interface> = {
      IEscrow: new Interface(ESCROW_ABI),
      IFulfillmentProxy: new Interface(FULFILLMENT_PROXY_ABI),
    };
    expect(Object.keys(golden).sort()).toEqual(Object.keys(byContract).sort());
    for (const [contract, events] of Object.entries(golden)) {
      for (const [name, topic0] of Object.entries(events)) {
        const event = byContract[contract].getEvent(name);
        expect(event, `${contract}.${name} missing from the generated ABI`).not.toBeNull();
        expect(event?.topicHash, `${contract}.${name}`).toBe(topic0);
      }
    }
  });
});
