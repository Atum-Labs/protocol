import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ZeroAddress, ZeroHash, getBytes } from 'ethers';
import { computePaymentIdV2 } from './payment-id';
import {
  DIRECT_DEPOSIT_ABI,
  DIRECT_DEPOSIT_DOMAIN_TAG,
  RESERVE_SELECTOR,
  applyDepositReserved,
  buildDirectDepositFundingBatch,
  computeActiveDepositHash,
  computeDepositWitnessHash,
  computeDirectDepositId,
  decodeDepositReservedLog,
  encodeDirectDepositCalldata,
  encodeReserveCalldata,
  reservedActiveDeposit,
  unreservedActiveDeposit,
} from './direct-deposit-encoder';
import type { DepositWitness, DirectDepositInput, ReserveInput } from './direct-deposit-encoder';

// Cross-language golden: every output equals conformance/direct-deposit-vectors.json, which
// contracts/evm/source/test/Escrow.directDepositVectors.t.sol runs through the real escrow and
// which the Go encoder asserts too (go/encoding/direct_deposit_encoder_test.go).

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(__dirname, '../../../../conformance/direct-deposit-vectors.json');

interface Vectors {
  chainID: number;
  escrow: string;
  owner: string;
  token: string;
  nonce: string;
  amount: string;
  depositWitness: DepositWitness;
  depositWitnessHash: string;
  depositId: string;
  directDepositCalldata: string;
  fundingBatch: { to: string; data: string }[];
  unreservedDepositHash: string;
  reserve: {
    quoteHash: string;
    settler: string;
    sourceAmount: string;
    feeAmount: string;
    reserveSignature: string;
    reserveCalldata: string;
    reservedDepositHash: string;
    depositReservedLog: { topics: string[]; data: string };
  };
}

const v = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vectors;

const directInput = (): DirectDepositInput => ({
  token: v.token,
  amount: v.amount,
  nonce: v.nonce,
  depositWitness: { ...v.depositWitness },
});

const reserveInput = (): ReserveInput => ({
  depositor: v.owner,
  token: v.token,
  amount: v.amount,
  depositWitness: { ...v.depositWitness },
  reserveWitness: {
    depositId: v.depositId,
    quoteHash: v.reserve.quoteHash,
    settler: v.reserve.settler,
    sourceAmount: v.reserve.sourceAmount,
  },
  reserveSignature: v.reserve.reserveSignature,
});

const idParams = () => ({
  chainId: v.chainID,
  escrow: v.escrow,
  owner: v.owner,
  token: v.token,
  nonce: v.nonce,
  depositWitness: { ...v.depositWitness },
  amount: v.amount,
});

const unreserved = () =>
  unreservedActiveDeposit({
    depositor: v.owner,
    token: v.token,
    amount: v.amount,
    depositWitness: v.depositWitness,
  });

const lower = (s: string) => s.toLowerCase();
const OTHER = '0x00000000000000000000000000000000deadbeef';

describe('direct deposit encoders match the contract-bound vectors', () => {
  it('computes the deposit witness hash', () => {
    expect(lower(computeDepositWitnessHash(v.depositWitness))).toBe(lower(v.depositWitnessHash));
  });

  it('derives the deposit id', () => {
    expect(lower(computeDirectDepositId(idParams()))).toBe(lower(v.depositId));
  });

  it('encodes the directDeposit calldata', () => {
    expect(lower(encodeDirectDepositCalldata(directInput()))).toBe(lower(v.directDepositCalldata));
  });

  it('builds the three-call funding batch', () => {
    const batch = buildDirectDepositFundingBatch(v.escrow, directInput());
    expect(batch.map((c) => ({ to: lower(c.to), data: lower(c.data) }))).toEqual(
      v.fundingBatch.map((c) => ({ to: lower(c.to), data: lower(c.data) })),
    );
  });

  it('encodes the reserve calldata under selector 0xb4b6913b', () => {
    const data = encodeReserveCalldata(reserveInput());
    expect(lower(data)).toBe(lower(v.reserve.reserveCalldata));
    expect(data.slice(0, 10)).toBe(RESERVE_SELECTOR);
  });

  it('hashes the unreserved and the reserved active deposit', () => {
    const u = unreserved();
    expect(lower(computeActiveDepositHash(u))).toBe(lower(v.unreservedDepositHash));
    const reserved = reservedActiveDeposit(u, {
      quoteHash: v.reserve.quoteHash,
      settler: v.reserve.settler,
      sourceAmount: v.reserve.sourceAmount,
      feeAmount: v.reserve.feeAmount,
    });
    expect(lower(computeActiveDepositHash(reserved))).toBe(lower(v.reserve.reservedDepositHash));
  });

  it('decodes the DepositReserved log and overlays it on the deposit-time tuple', () => {
    const event = decodeDepositReservedLog(v.reserve.depositReservedLog);
    expect(lower(event.depositId)).toBe(lower(v.depositId));
    expect(lower(event.quoteHash)).toBe(lower(v.reserve.quoteHash));
    expect(lower(event.settler)).toBe(lower(v.reserve.settler));
    expect(event.amount.toString()).toBe(v.reserve.sourceAmount);
    expect(event.feeAmount.toString()).toBe(v.reserve.feeAmount);

    const u = unreserved();
    const overlaid = applyDepositReserved(v.depositId, u, event);
    expect(lower(computeActiveDepositHash(overlaid))).toBe(lower(v.reserve.reservedDepositHash));
    // The overlay does not mutate the deposit-time tuple.
    expect(lower(computeActiveDepositHash(u))).toBe(lower(v.unreservedDepositHash));
  });

  it('accepts bigint inputs where the vectors use decimal strings', () => {
    expect(
      encodeDirectDepositCalldata({
        ...directInput(),
        amount: BigInt(v.amount),
        nonce: BigInt(v.nonce),
      }),
    ).toBe(encodeDirectDepositCalldata(directInput()));
  });
});

describe('deposit id', () => {
  const base = () => computeDirectDepositId(idParams());
  const mutations: Record<string, () => string> = {
    chainId: () => computeDirectDepositId({ ...idParams(), chainId: 1 }),
    escrow: () => computeDirectDepositId({ ...idParams(), escrow: OTHER }),
    owner: () => computeDirectDepositId({ ...idParams(), owner: OTHER }),
    token: () => computeDirectDepositId({ ...idParams(), token: OTHER }),
    nonce: () => computeDirectDepositId({ ...idParams(), nonce: 8n }),
    amount: () => computeDirectDepositId({ ...idParams(), amount: BigInt(v.amount) + 1n }),
    depositRequestHash: () =>
      computeDirectDepositId({
        ...idParams(),
        depositWitness: { ...v.depositWitness, depositRequestHash: `0x${'11'.repeat(32)}` },
      }),
    destination: () =>
      computeDirectDepositId({
        ...idParams(),
        depositWitness: { ...v.depositWitness, destination: `${v.depositWitness.destination}x` },
      }),
    reserver: () =>
      computeDirectDepositId({
        ...idParams(),
        depositWitness: { ...v.depositWitness, reserver: OTHER },
      }),
    releaser: () =>
      computeDirectDepositId({
        ...idParams(),
        depositWitness: { ...v.depositWitness, releaser: OTHER },
      }),
  };

  it.each(Object.keys(mutations))('changing %s changes the id', (member) => {
    expect(mutations[member]()).not.toBe(base());
  });

  it('differs from a Permit2 id over the same depositor and nonce', () => {
    const permit2Id = computePaymentIdV2(v.owner, v.reserve.reserveSignature, v.nonce);
    expect(lower(permit2Id)).not.toBe(lower(v.depositId));
  });

  it('starts with a tag that cannot be read as a left-padded address', () => {
    expect(
      getBytes(DIRECT_DEPOSIT_DOMAIN_TAG)
        .slice(0, 12)
        .some((b) => b !== 0),
    ).toBe(true);
  });
});

describe('inputs the escrow reverts on are rejected', () => {
  const withWitness = (patch: Partial<DepositWitness>): DirectDepositInput => ({
    ...directInput(),
    depositWitness: { ...v.depositWitness, ...patch },
  });

  it.each([
    ['zero amount', { ...directInput(), amount: 0n }],
    ['negative nonce', { ...directInput(), nonce: -1n }],
    ['nonce over uint256', { ...directInput(), nonce: 1n << 256n }],
    ['zero token', { ...directInput(), token: ZeroAddress }],
    ['zero reserver', withWitness({ reserver: ZeroAddress })],
    ['zero releaser', withWitness({ releaser: ZeroAddress })],
    ['empty request hash', withWitness({ depositRequestHash: ZeroHash })],
    ['short request hash', withWitness({ depositRequestHash: '0x1234' })],
    ['empty destination', withWitness({ destination: '' })],
    ['destination over the cap', withWitness({ destination: 'a'.repeat(257) })],
  ])('directDeposit: %s', (_name, input) => {
    expect(() => encodeDirectDepositCalldata(input)).toThrow();
    expect(() => buildDirectDepositFundingBatch(v.escrow, input)).toThrow();
  });

  it.each([
    ['zero token', { ...idParams(), token: ZeroAddress }],
    ['zero amount', { ...idParams(), amount: 0n }],
    ['negative nonce', { ...idParams(), nonce: -1n }],
    [
      'empty destination',
      { ...idParams(), depositWitness: { ...v.depositWitness, destination: '' } },
    ],
    [
      'zero reserver',
      { ...idParams(), depositWitness: { ...v.depositWitness, reserver: ZeroAddress } },
    ],
  ])('the deposit id refuses what the escrow reverts on: %s', (_name, params) => {
    expect(() => computeDirectDepositId(params)).toThrow();
  });

  it('accepts a destination exactly at the cap', () => {
    expect(() =>
      encodeDirectDepositCalldata(withWitness({ destination: 'a'.repeat(256) })),
    ).not.toThrow();
  });

  const reserveWith = (
    patch: Partial<ReserveInput>,
    rw: Partial<ReserveInput['reserveWitness']> = {},
  ) => {
    const input = reserveInput();
    return { ...input, ...patch, reserveWitness: { ...input.reserveWitness, ...rw } };
  };

  it.each([
    ['zero settler', reserveWith({}, { settler: ZeroAddress })],
    ['empty quote', reserveWith({}, { quoteHash: ZeroHash })],
    ['zero charge', reserveWith({}, { sourceAmount: 0n })],
    ['charge above the deposit', reserveWith({}, { sourceAmount: BigInt(v.amount) + 1n })],
    ['zero depositor', reserveWith({ depositor: ZeroAddress })],
    ['zero amount', reserveWith({ amount: 0n })],
    ['invalid witness', reserveWith({ depositWitness: { ...v.depositWitness, destination: '' } })],
    ['non-hex signature', reserveWith({ reserveSignature: 'not-hex' })],
  ])('reserve: %s', (_name, input) => {
    expect(() => encodeReserveCalldata(input)).toThrow();
  });

  it('accepts a charge equal to the deposit', () => {
    expect(() => encodeReserveCalldata(reserveWith({}, { sourceAmount: v.amount }))).not.toThrow();
  });
});

describe('DepositReserved overlay refuses mismatches', () => {
  const log = v.reserve.depositReservedLog;

  it('another deposit id', () => {
    const event = decodeDepositReservedLog(log);
    expect(() => applyDepositReserved(`0x${'01'.repeat(32)}`, unreserved(), event)).toThrow();
  });

  it('a charge above the deposited amount', () => {
    const event = decodeDepositReservedLog(log);
    expect(() =>
      applyDepositReserved(v.depositId, unreserved(), { ...event, amount: BigInt(v.amount) + 1n }),
    ).toThrow();
  });

  it('a log with another topic0, no indexed id, or truncated data', () => {
    expect(() =>
      decodeDepositReservedLog({ ...log, topics: [`0x${'09'.repeat(32)}`, log.topics[1]] }),
    ).toThrow();
    expect(() => decodeDepositReservedLog({ ...log, topics: [log.topics[0]] })).toThrow();
    expect(() => decodeDepositReservedLog({ ...log, data: log.data.slice(0, -2) })).toThrow();
  });
});

describe('active-deposit hash', () => {
  it('binds every field of the tuple', () => {
    const base = reservedActiveDeposit(unreserved(), {
      quoteHash: v.reserve.quoteHash,
      settler: v.reserve.settler,
      sourceAmount: v.reserve.sourceAmount,
      feeAmount: v.reserve.feeAmount,
    });
    const baseHash = computeActiveDepositHash(base);
    const flip = `0x${'22'.repeat(32)}`;
    const patches = {
      depositor: { depositor: OTHER },
      quoteHash: { quoteHash: flip },
      depositRequestHash: { depositRequestHash: flip },
      destinationHash: { destinationHash: flip },
      token: { token: OTHER },
      amount: { amount: 1n },
      feeAmount: { feeAmount: 1n },
      reserver: { reserver: OTHER },
      releaser: { releaser: OTHER },
      settler: { settler: OTHER },
    };
    for (const [field, patch] of Object.entries(patches)) {
      expect(computeActiveDepositHash({ ...base, ...patch }), field).not.toBe(baseHash);
    }
  });
});

// The fragments the module builds its Interface from are tied to the compiler-emitted ABI, so a
// contract change to directDeposit, reserve or DepositReserved fails here instead of at a caller.
describe('DIRECT_DEPOSIT_ABI matches the compiler-emitted Escrow ABI', () => {
  const compilerAbiPath = resolve(__dirname, '../../../../source/generated/abi/Escrow.json');
  // A missing or unreadable ABI throws: the guard fails closed, it never skips.
  const compiler = JSON.parse(readFileSync(compilerAbiPath, 'utf8')) as Record<string, unknown>[];

  // `internalType` is a compiler annotation, ignored here and in escrow-abi.test.ts.
  const strip = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(strip)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.entries(x as Record<string, unknown>)
              .filter(([k]) => k !== 'internalType')
              .map(([k, val]) => [k, strip(val)]),
          )
        : x;

  const declared = DIRECT_DEPOSIT_ABI as unknown as { type: string; name: string }[];

  it('the compiler ABI is loaded and non-trivial', () => {
    expect(compiler.length).toBeGreaterThan(50);
  });

  it('declares exactly directDeposit, reserve and DepositReserved', () => {
    expect(declared.map((f) => `${f.type}:${f.name}`)).toEqual([
      'function:directDeposit',
      'function:reserve',
      'event:DepositReserved',
    ]);
  });

  it.each(declared.map((f) => [f.type, f.name]))(
    '%s %s is structurally identical to source',
    (type, name) => {
      const matches = compiler.filter((e) => e.type === type && e.name === name);
      expect(matches).toHaveLength(1);
      expect(strip(declared.find((f) => f.type === type && f.name === name))).toEqual(
        strip(matches[0]),
      );
    },
  );
});

// The package root re-exports this module, so whatever it imports every root importer inlines. The
// full generated ABI is about 72 KB and parsing it at import is not free: no module reachable from
// the root may import it. Tests may.
describe('the package root does not load the full generated ABI', () => {
  it('no non-test source module imports ./generated/abi', () => {
    const files = readdirSync(__dirname).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((f) =>
      /from\s+['"]\.\/generated\/abi(\.js)?['"]/.test(readFileSync(resolve(__dirname, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
