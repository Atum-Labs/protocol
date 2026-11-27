import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { computeActiveDepositHash } from './active-deposit';
import { Address } from './address';
import { computeDepositHash, type EscrowDepositParams } from './deposit-encoder';
import { escrowDomainPrefixBytes, newEscrowDomain, PASSPHRASE_TESTNET, type EscrowDomain } from './escrow-domain';
import * as errors from './errors';
import { Pubkey } from './pubkey';
import { computeRefundHash } from './refund-encoder';
import { computeReleaseHash, type EscrowSettlementParams } from './release-encoder';
import { checkSourceAmount, computeReserveHash, type EscrowReserveParams } from './reserve-encoder';

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
const rejected: Record<string, string> = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', '..', 'conformance', 'vectors.json'), 'utf8'),
).rejectedAddresses;

const key = (seed: number): Uint8Array => {
  const b = new Uint8Array(32);
  b[0] = seed;
  return b;
};
const pk = (seed: number) => Pubkey.fromBytes(key(seed));
const contract = (seed: number) => Address.contract(new Uint8Array(32).fill(seed));
const TWO_127 = 1n << 127n;

const domain = (): EscrowDomain => newEscrowDomain(PASSPHRASE_TESTNET, contract(0xc0));

const validDeposit = (): EscrowDepositParams => ({
  depositRequestHash: new Uint8Array(32).fill(1),
  destination: 'dest',
  depositor: Address.account(key(2)),
  token: contract(3),
  epoch: 1n,
  amount: 10n,
  reserver: pk(4),
  releaser: pk(5),
  nonce: 1n,
  issuedAt: 1n,
  deadline: 2n,
});

const validReserve = (): EscrowReserveParams => ({
  depositId: new Uint8Array(32).fill(7),
  quoteHash: new Uint8Array(32).fill(8),
  settler: Address.account(key(6)),
  sourceAmount: 5n,
});

const validSettlement = (): EscrowSettlementParams => ({
  depositId: new Uint8Array(32).fill(7),
  quoteHash: new Uint8Array(32).fill(8),
  depositRequestHash: new Uint8Array(32).fill(1),
  destinationHash: new Uint8Array(32).fill(9),
  depositor: Address.account(key(2)),
  token: contract(3),
  amount: 5n,
  feeAmount: 1n,
  reserver: pk(4),
  releaser: pk(5),
  settler: Address.account(key(6)),
});

const depositWith = (mutate: (p: EscrowDepositParams) => void) => () => {
  const p = validDeposit();
  mutate(p);
  computeDepositHash(p, domain());
};
const reserveWith = (mutate: (p: EscrowReserveParams) => void) => () => {
  const p = validReserve();
  mutate(p);
  computeReserveHash(p, domain());
};
const settleWith =
  (compute: typeof computeReleaseHash, mutate: (p: EscrowSettlementParams) => void) => () => {
    const p = validSettlement();
    mutate(p);
    compute(p, domain());
  };

const activeWith = (mutate: (p: EscrowSettlementParams) => void) => () => {
  const p = validSettlement();
  mutate(p);
  computeActiveDepositHash(p);
};

const settlementWidthTriggers = (
  fn: string,
  compute: typeof computeReleaseHash,
): Record<string, () => void> => ({
  [`${fn}/depositId/wrongLength`]: settleWith(compute, (p) => {
    p.depositId = new Uint8Array(33);
  }),
  [`${fn}/quoteHash/wrongLength`]: settleWith(compute, (p) => {
    p.quoteHash = new Uint8Array(31);
  }),
  [`${fn}/depositRequestHash/wrongLength`]: settleWith(compute, (p) => {
    // 31 + 33 against the neighbouring destinationHash keeps the total preimage length unchanged
    p.depositRequestHash = new Uint8Array(31);
    p.destinationHash = new Uint8Array(33);
  }),
  [`${fn}/destinationHash/wrongLength`]: settleWith(compute, (p) => {
    p.destinationHash = new Uint8Array(33);
    p.depositRequestHash = new Uint8Array(31).fill(1);
  }),
  [`${fn}/destinationHash/empty`]: settleWith(compute, (p) => {
    p.destinationHash = new Uint8Array(0);
  }),
});

const validStrkey = contract(0xe1).toString();

// One entry per fixture case. A case with no entry here fails the coverage check below, which is what
// makes a guard added on the Go side turn this suite red until it is mirrored.
const triggers: Record<string, () => void> = {
  'escrowDomainPrefixBytes/networkId/wrongLength': () =>
    escrowDomainPrefixBytes({ ...domain(), networkId: new Uint8Array(31) }),
  'escrowDomainPrefixBytes/networkId/zero': () =>
    escrowDomainPrefixBytes({ ...domain(), networkId: new Uint8Array(32) }),
  'escrowDomainPrefixBytes/contractId/wrongLength': () =>
    escrowDomainPrefixBytes({ ...domain(), contractId: new Uint8Array(31) }),
  'escrowDomainPrefixBytes/contractId/zero': () =>
    escrowDomainPrefixBytes({ ...domain(), contractId: new Uint8Array(32) }),
  'newEscrowDomain/networkPassphrase/empty': () => newEscrowDomain('', contract(0xc0)),
  'newEscrowDomain/escrow/notContract': () => newEscrowDomain(PASSPHRASE_TESTNET, Address.account(key(0xc0))),
  'newEscrowDomain/escrow/zero': () => newEscrowDomain(PASSPHRASE_TESTNET, Address.contract(new Uint8Array(32))),
  'computeDepositHash/reserver/zero': depositWith((p) => {
    p.reserver = Pubkey.fromBytes(new Uint8Array(32));
  }),
  'computeDepositHash/releaser/zero': depositWith((p) => {
    p.releaser = Pubkey.fromBytes(new Uint8Array(32));
  }),
  'computeDepositHash/depositRequestHash/zero': depositWith((p) => {
    p.depositRequestHash = new Uint8Array(32);
  }),
  'computeDepositHash/destination/empty': depositWith((p) => {
    p.destination = '';
  }),
  'computeDepositHash/destination/tooLong': depositWith((p) => {
    p.destination = 'd'.repeat(257);
  }),
  // 129 two-byte characters: 129 UTF-16 units but 258 bytes, so only a byte count rejects it
  'computeDepositHash/destination/tooLongMultibyte': depositWith((p) => {
    p.destination = 'é'.repeat(129);
  }),
  'computeDepositHash/amount/zero': depositWith((p) => {
    p.amount = 0n;
  }),
  'computeDepositHash/amount/negative': depositWith((p) => {
    p.amount = -1n;
  }),
  'computeDepositHash/amount/overI128': depositWith((p) => {
    p.amount = TWO_127;
  }),
  'computeDepositHash/issuedAt/afterDeadline': depositWith((p) => {
    p.issuedAt = 11n;
    p.deadline = 10n;
  }),
  'computeDepositHash/deadline/windowTooLong': depositWith((p) => {
    p.issuedAt = 10n;
    p.deadline = 10n + 86400n + 1n;
  }),
  'computeReserveHash/depositId/zero': reserveWith((p) => {
    p.depositId = new Uint8Array(32);
  }),
  'computeReserveHash/quoteHash/zero': reserveWith((p) => {
    p.quoteHash = new Uint8Array(32);
  }),
  'computeReserveHash/sourceAmount/zero': reserveWith((p) => {
    p.sourceAmount = 0n;
  }),
  'computeReserveHash/sourceAmount/negative': reserveWith((p) => {
    p.sourceAmount = -1n;
  }),
  'computeReserveHash/sourceAmount/overI128': reserveWith((p) => {
    p.sourceAmount = TWO_127;
  }),
  'checkSourceAmount/sourceAmount/aboveCeiling': () => checkSourceAmount(10n, 11n),
  'checkSourceAmount/sourceAmount/zero': () => checkSourceAmount(10n, 0n),
  'computeReleaseHash/quoteHash/zero': settleWith(computeReleaseHash, (p) => {
    p.quoteHash = new Uint8Array(32);
  }),
  'computeReleaseHash/depositId/zero': settleWith(computeReleaseHash, (p) => {
    p.depositId = new Uint8Array(32);
  }),
  'computeReleaseHash/amount/negative': settleWith(computeReleaseHash, (p) => {
    p.amount = -1n;
  }),
  'computeReleaseHash/feeAmount/overI128': settleWith(computeReleaseHash, (p) => {
    p.feeAmount = TWO_127;
  }),
  'computeRefundHash/quoteHash/zero': settleWith(computeRefundHash, (p) => {
    p.quoteHash = new Uint8Array(32);
  }),
  'computeRefundHash/depositId/zero': settleWith(computeRefundHash, (p) => {
    p.depositId = new Uint8Array(32);
  }),
  'parseAddress/strkey/muxed': () => Address.fromStrkey(rejected.muxed),
  'parseAddress/strkey/claimableBalance': () => Address.fromStrkey(rejected.claimableBalance),
  'parseAddress/strkey/secretSeed': () => Address.fromStrkey(rejected.secretSeed),
  'parseAddress/strkey/badChecksum': () => Address.fromStrkey(`${validStrkey.slice(0, -1)}A`),
  'parseAddress/strkey/lowercase': () => Address.fromStrkey(validStrkey.toLowerCase()),
  'parseAddress/strkey/truncated': () => Address.fromStrkey(validStrkey.slice(0, -2)),
  'computeDepositHash/depositRequestHash/wrongLength': depositWith((p) => {
    p.depositRequestHash = new Uint8Array(31);
  }),
  // A lone surrogate: TextEncoder would turn it into U+FFFD and hash bytes the caller never wrote
  'computeDepositHash/destination/invalidUtf8': depositWith((p) => {
    p.destination = 'ab\ud800cd';
  }),
  'computeReserveHash/depositId/wrongLength': reserveWith((p) => {
    p.depositId = new Uint8Array(33);
  }),
  'computeReserveHash/quoteHash/wrongLength': reserveWith((p) => {
    p.quoteHash = new Uint8Array(31);
  }),
  ...settlementWidthTriggers('computeReleaseHash', computeReleaseHash),
  ...settlementWidthTriggers('computeRefundHash', computeRefundHash),
  'computeActiveDepositHash/quoteHash/wrongLength': activeWith((p) => {
    p.quoteHash = new Uint8Array(31);
  }),
  'computeActiveDepositHash/depositRequestHash/wrongLength': activeWith((p) => {
    p.depositRequestHash = new Uint8Array(31);
  }),
  'computeActiveDepositHash/destinationHash/wrongLength': activeWith((p) => {
    p.destinationHash = new Uint8Array(33);
  }),
  'computeActiveDepositHash/destinationHash/empty': activeWith((p) => {
    p.destinationHash = new Uint8Array(0);
  }),
  'parseAddress/strkey/embeddedNewline': () =>
    Address.fromStrkey(`${validStrkey.slice(0, 10)}\n${validStrkey.slice(10)}`),
  'parseAddress/strkey/embeddedCarriageReturn': () =>
    Address.fromStrkey(`${validStrkey.slice(0, 10)}\r${validStrkey.slice(10)}`),
  'parseAddress/strkey/trailingNewline': () => Address.fromStrkey(`${validStrkey}\n`),
  'parseAddress/strkey/empty': () => Address.fromStrkey(''),
  'pubkeyFromStrkey/strkey/contract': () => Pubkey.fromStrkey(validStrkey),
  'pubkeyFromHex/hex/oddLength': () => Pubkey.fromHex('abc'),
  'pubkeyFromHex/hex/wrongLength': () => Pubkey.fromHex('abcd'),
};

describe('guard parity with the shared fixture', () => {
  it('exercises every case the fixture lists', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    const missing = fixture.cases
      .map((c) => `${c.fn}/${c.field}/${c.input}`)
      .filter((k) => !(k in triggers));
    expect(missing, 'guard-vectors.json lists cases this suite does not exercise').toEqual([]);
  });

  it('lists every case this suite exercises, so a TypeScript-only guard is not invisible to Go', () => {
    const listed = new Set(fixture.cases.map((c) => `${c.fn}/${c.field}/${c.input}`));
    expect(Object.keys(triggers).filter((k) => !listed.has(k))).toEqual([]);
  });

  for (const c of fixture.cases) {
    const k = `${c.fn}/${c.field}/${c.input}`;
    it(`${k} throws ${c.error}`, () => {
      const trigger = triggers[k];
      expect(trigger, `no trigger for ${k}`).toBeDefined();
      const ctor = (errors as unknown as Record<string, new (...a: never[]) => Error>)[c.error];
      expect(ctor, `fixture names unknown error class ${c.error}`).toBeDefined();
      expect(trigger).toThrow(ctor);
    });
  }
});
