/**
 * Decodes real Escrow logs from a v4 mainnet deployment with the exported ABI. The expected values
 * were read off the raw log words by hand, not produced by an ABI, so a wrong or partial ABI fails
 * here instead of agreeing with itself.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Interface } from 'ethers';
import { ESCROW_ABI } from './generated/abi';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS = JSON.parse(
  readFileSync(resolve(__dirname, '../testdata/arbitrum-v4-escrow-logs.json'), 'utf8'),
) as Record<string, { topics: string[]; data: string }>;

const escrow = new Interface(ESCROW_ABI);

describe('ESCROW_ABI decodes v4 mainnet logs', () => {
  it('Released carries the fee', () => {
    const parsed = escrow.parseLog(LOGS.Released);
    expect(parsed?.name).toBe('Released');
    expect(parsed?.args.depositId).toBe(
      '0xe5f51974d37af37d9cb83bf8db47d20dcfc8a5c3bf4deac05196ba306d4627dd',
    );
    expect(parsed?.args.settler.toLowerCase()).toBe('0x70c813556fdc483e3a1cdd7355f963170912c224');
    expect(parsed?.args.token.toLowerCase()).toBe('0xaf88d065e77c8cc2239327c5edb3a432268e5831');
    expect(parsed?.args.amount).toBe(100000n);
    expect(parsed?.args.feeAmount).toBe(20n);
  });

  // The batch events carry their payload in dynamic arrays and have no indexed topics, so a decoder
  // that only knows the singular events misses them entirely rather than failing.
  it('DepositedMany carries every deposit id of the batch', () => {
    const parsed = escrow.parseLog(LOGS.DepositedMany);
    expect(parsed?.name).toBe('DepositedMany');
    expect(parsed?.args.depositIds).toHaveLength(5);
    expect(parsed?.args.depositIds[0]).toBe(
      '0xadfc0242463e08ebdc0b4baf7076b8e8076bf3f6bf512240240232383f8ddc2e',
    );
  });

  it('ReleasedMany carries the fee of every release in the batch', () => {
    const parsed = escrow.parseLog(LOGS.ReleasedMany);
    expect(parsed?.name).toBe('ReleasedMany');
    const witnesses = parsed?.args.releaseWitnesses;
    expect(witnesses).toHaveLength(4);
    expect(witnesses[0].depositId).toBe(
      '0x026a34c7235e8e8a32fcc61d43b547f70f8c42ffbf10133583681228e6ada09b',
    );
    expect(witnesses[0].amount).toBe(10000n);
    expect(witnesses[0].feeAmount).toBe(2n);
    expect(witnesses[0].settler.toLowerCase()).toBe('0x70c813556fdc483e3a1cdd7355f963170912c224');
  });
});
