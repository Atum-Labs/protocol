import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeAddress } from '@atum-labs/tvm-escrow-encoding';
// From the package entry point, so these tests also hold the export in place.
import {
  getChainAdapter,
  recoverPermit2EOA,
  RecoveryFailedError,
  verifyDepositorSignature,
} from './index.js';
import type { DepositorSignature, DepositorSignatureResult } from './index.js';
import { fakeChecker } from './test-helpers.js';
import type { CheckerCall, FakeChain } from './test-helpers.js';

// The shared vectors both languages assert. They are written by hand, not recorded from this
// function, so they are the oracle for both implementations.
const VECTORS = resolve(__dirname, '../../../../conformance/depositor-signature-vectors.json');

interface Vector {
  name: string;
  input: DepositorSignature;
  offline?: boolean;
  chain?: FakeChain;
  result: DepositorSignatureResult;
  calls: CheckerCall[];
}

const fixture = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
  signatureMaxLength: number;
  vectors: Vector[];
};
const vectors = fixture.vectors;

// Mirrors the Go TestDepositorSignatureVectors.
describe('depositor-signature vectors', () => {
  let ran = 0;

  it('carries vectors with unique names', () => {
    expect(vectors.length).toBeGreaterThan(0);
    expect(new Set(vectors.map((v) => v.name)).size).toBe(vectors.length);
  });

  for (const v of vectors) {
    it(v.name, async () => {
      ran++;
      const fake = fakeChecker(v.chain);
      const got = await verifyDepositorSignature(v.input, v.offline === true ? undefined : fake);
      // Go and TypeScript must return the same result.
      expect(got).toEqual(v.result);
      expect(fake.calls).toEqual(v.calls);
    });
  }

  it('ran every vector', () => {
    expect(ran).toBe(vectors.length);
  });
});

// Every EOA-path vector's signature, recovered alone: recoverPermit2EOA returns the signer the
// vector's verdict implies, or throws RecoveryFailedError with the reason its detail names.
// Mirrors the Go TestRecoverPermit2EOAAgreesWithTheVectors.
describe('recoverPermit2EOA', () => {
  const eoa = vectors.filter((v) => v.result.path === 'eoa');

  it('covers the EOA-path vectors', () => {
    expect(eoa.length).toBeGreaterThan(10);
  });

  for (const v of eoa) {
    it(v.name, () => {
      const { digest, signature, network, account } = v.input;
      const unrecoverable =
        /^no signer recovers from the signature \((.*)\), and the account has no code$/.exec(
          v.result.detail,
        );
      if (unrecoverable) {
        let thrown: unknown;
        try {
          recoverPermit2EOA(digest, signature);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(RecoveryFailedError);
        expect((thrown as Error).message).toBe(
          `sender_auth: could not recover a signer from the signed message: ${unrecoverable[1]}`,
        );
        return;
      }
      const signer = recoverPermit2EOA(digest, signature);
      if (v.result.valid) {
        const want = network.startsWith('tron:') ? normalizeAddress(account) : account;
        expect(signer.toLowerCase()).toBe(want.toLowerCase());
        return;
      }
      const other =
        /^the signature recovers to (0x[0-9a-fA-F]{40}), and the account has no code$/.exec(
          v.result.detail,
        );
      expect(other).not.toBeNull();
      expect(signer).toBe(other![1]);
    });
  }
});

// The two length cases the fixture leaves to the suites, on contract-magic-verified's account and
// chain: a signature exactly signatureMaxLength characters long is passed through whole, and one a
// byte longer is refused before any chain read. Mirrors the Go TestDepositorSignatureLengthBound.
describe('the signature length bound', () => {
  const base = vectors.find((v) => v.name === 'contract-magic-verified')!;
  const atBound = '0x' + 'ab'.repeat((fixture.signatureMaxLength - 2) / 2);

  it("is the veri-fill route's maxLength", () => {
    expect(fixture.signatureMaxLength).toBe(65536);
    expect(base).toBeDefined();
  });

  it('passes a signature at the bound through whole', async () => {
    const fake = fakeChecker(base.chain);
    const got = await verifyDepositorSignature({ ...base.input, signature: atBound }, fake);
    expect(got).toEqual({
      valid: true,
      path: 'contract',
      reason: 'verified',
      detail: 'isValidSignature returned the ERC-1271 magic value',
    });
    expect(fake.calls).toEqual([
      {
        method: 'hasCode',
        network: 'eip155:42161',
        account: '0x5afe00000000000000000000000000000000c0de',
      },
      {
        method: 'isValidSignatureFrom',
        network: 'eip155:42161',
        account: '0x5afe00000000000000000000000000000000c0de',
        digest: '0x143abd003825e8e8af0671290b4aba3461a06de60edf06c4a9e8371fcaa84e3a',
        signature: atBound,
        caller: '0x000000000022d473030f116ddee9f6b43ac78ba3',
      },
    ]);
  });

  it('refuses a signature a byte over the bound as malformed', async () => {
    const fake = fakeChecker(base.chain);
    const got = await verifyDepositorSignature({ ...base.input, signature: atBound + 'ab' }, fake);
    expect(got).toEqual({
      valid: false,
      path: 'none',
      reason: 'malformed',
      detail: 'the signature is longer than 65536 characters',
    });
    expect(fake.calls).toEqual([]);
  });
});

// recoverSigner is untouched: the spellings Permit2 accepts and it refuses stay refused, and the
// v 0 spelling Permit2 refuses stays accepted. Mirrors the Go TestRecoverSignerKeepsItsOwnSpelling.
describe('recoverSigner keeps its own spelling', () => {
  const byName = new Map(vectors.map((v) => [v.name, v.input]));
  const recover = (name: string) => {
    const input = byName.get(name)!;
    return () =>
      getChainAdapter(input.network).recoverSigner(
        { message: input.digest, signature: input.signature },
        { network: input.network, asset: '', account: input.account },
      );
  };

  it('accepts v 27 and v 0, and refuses high-s and the 64-byte form', () => {
    expect(recover('eoa-65-byte-v27-recovers')).not.toThrow();
    expect(recover('eoa-v0-refused')).not.toThrow();
    expect(recover('eoa-high-s-recovers')).toThrow(RecoveryFailedError);
    expect(recover('eoa-64-byte-compact-recovers')).toThrow(RecoveryFailedError);
  });
});

// TypeScript only: Go's types rule these answers out. A checker that answers outside its contract
// has not read the chain, so its answer must never become a refusal.
describe('a checker answering outside its contract', () => {
  const byName = new Map(vectors.map((v) => [v.name, v.input]));

  it('is not read as "no code" when hasCode resolves to something other than a boolean', async () => {
    const checker = {
      ...fakeChecker(),
      hasCode: () => Promise.resolve(undefined as unknown as boolean),
    };
    const got = await verifyDepositorSignature(byName.get('eoa-other-signer-refused')!, checker);
    expect(got.reason).toBe('signature_unverifiable');
    expect(got.valid).toBe(false);
  });

  it('is not read as a rejection when the return data is not 0x-hex', async () => {
    const input = byName.get('contract-magic-verified')!;
    const checker = fakeChecker({ code: '0x6080' });
    checker.isValidSignatureFrom = () => Promise.resolve({ reverted: false, returnData: 'magic' });
    const got = await verifyDepositorSignature(input, checker);
    expect(got.reason).toBe('signature_unverifiable');
    expect(got.path).toBe('contract');
  });
});
