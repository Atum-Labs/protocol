import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  computeDepositHash,
  computeDepositHashV2,
  type EscrowDepositParams,
} from './deposit-encoder';
import { escrowDomainPrefixBytes, newEscrowDomain, type EscrowDomain } from './escrow-domain';
import { Pubkey } from './pubkey';
import {
  computeReserveHash,
  computeReserveHashV2,
  computeReserveHashV3,
  type EscrowReserveParams,
} from './reserve-encoder';

interface GuardCase {
  fn: string;
  field: string;
  input: string;
  error: string;
  goError?: string;
}

const fixture: { cases: GuardCase[] } = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', '..', 'conformance', 'guard-vectors.json'), 'utf8'),
);

const pk = (seed: number): Pubkey => {
  const b = new Uint8Array(32);
  b[0] = seed;
  return Pubkey.fromBytes(b);
};

const validDomain = (): EscrowDomain => newEscrowDomain('localnet', 3, pk(1));

const validDepositParams = (): EscrowDepositParams => ({
  depositRequestHash: new Uint8Array(32).fill(1),
  depositor: pk(2),
  mint: pk(3),
  amount: 1n,
  reserver: pk(4),
  releaser: pk(5),
  nonce: 1n,
  issuedAt: 1n,
  deadline: 2n,
});

const validReserveParams = (): EscrowReserveParams => ({
  depositHash: new Uint8Array(32).fill(7),
  recipient: pk(6),
});

const depositWith = (mutate: (p: EscrowDepositParams) => void) => () => {
  const p = validDepositParams();
  mutate(p);
  computeDepositHash(p, validDomain());
};

// One entry per fixture case. A case with no entry here fails the coverage check below, which is
// what makes a guard added on the Go side turn this suite red until it is mirrored.
const triggers: Record<string, () => void> = {
  'escrowDomainPrefixBytes/clusterId/wrongLength': () =>
    escrowDomainPrefixBytes({ ...validDomain(), clusterId: new Uint8Array(31) }),
  'escrowDomainPrefixBytes/signatureDomainVersion/zero': () =>
    escrowDomainPrefixBytes({ ...validDomain(), signatureDomainVersion: 0 }),
  'escrowDomainPrefixBytes/programId/zero': () =>
    escrowDomainPrefixBytes({ ...validDomain(), programId: Pubkey.fromBytes(new Uint8Array(32)) }),
  'newEscrowDomain/clusterName/empty': () => newEscrowDomain('  ', 3, pk(1)),
  'newEscrowDomain/clusterName/tooLong': () => newEscrowDomain('x'.repeat(33), 3, pk(1)),
  'newEscrowDomain/signatureDomainVersion/zero': () => newEscrowDomain('localnet', 0, pk(1)),
  'newEscrowDomain/programId/zero': () =>
    newEscrowDomain('localnet', 3, Pubkey.fromBytes(new Uint8Array(32))),
  'computeDepositHash/depositRequestHash/zero': depositWith((p) => {
    p.depositRequestHash = new Uint8Array(32);
  }),
  'computeDepositHash/depositor/zero': depositWith((p) => {
    p.depositor = Pubkey.fromBytes(new Uint8Array(32));
  }),
  'computeDepositHash/mint/zero': depositWith((p) => {
    p.mint = Pubkey.fromBytes(new Uint8Array(32));
  }),
  'computeDepositHash/amount/zero': depositWith((p) => {
    p.amount = 0n;
  }),
  'computeDepositHash/reserver/zero': depositWith((p) => {
    p.reserver = Pubkey.fromBytes(new Uint8Array(32));
  }),
  'computeDepositHash/releaser/zero': depositWith((p) => {
    p.releaser = Pubkey.fromBytes(new Uint8Array(32));
  }),
  'computeDepositHash/destination/empty': () =>
    computeDepositHashV2(validDepositParams(), '', validDomain()),
  'computeDepositHash/destination/tooLong': () =>
    computeDepositHashV2(validDepositParams(), 'd'.repeat(257), validDomain()),
  'computeReserveHash/depositHash/zero': () =>
    computeReserveHash({ ...validReserveParams(), depositHash: new Uint8Array(32) }, validDomain()),
  'computeReserveHash/recipient/zero': () =>
    computeReserveHash(
      { ...validReserveParams(), recipient: Pubkey.fromBytes(new Uint8Array(32)) },
      validDomain(),
    ),
  'computeReserveHash/quoteHash/zero': () =>
    computeReserveHashV2(validReserveParams(), new Uint8Array(32), validDomain()),
  'computeReserveHash/sourceAmount/zero': () =>
    computeReserveHashV3(validReserveParams(), new Uint8Array(32).fill(9), 0n, validDomain()),
  'pubkeyFromHex/hex/oddLength': () => {
    Pubkey.fromHex('abc');
  },
};

describe('guard parity with the shared fixture', () => {
  it('exercises every case the fixture lists', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    const missing = fixture.cases
      .map((c) => `${c.fn}/${c.field}/${c.input}`)
      .filter((key) => !(key in triggers));
    expect(missing, 'guard-vectors.json lists cases this suite does not exercise').toEqual([]);
  });

  for (const c of fixture.cases) {
    const key = `${c.fn}/${c.field}/${c.input}`;
    it(`rejects ${key} with ${c.error}`, () => {
      const trigger = triggers[key];
      expect(trigger, `no trigger registered for ${key}`).toBeDefined();
      expect(trigger).toThrowError(
        expect.objectContaining({ name: c.error }) as unknown as Error,
      );
    });
  }
});
