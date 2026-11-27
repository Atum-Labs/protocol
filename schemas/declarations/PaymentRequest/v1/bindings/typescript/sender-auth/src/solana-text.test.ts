import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  escrowMessage,
  escrowText,
  messageForms,
  witnessLabel,
  MESSAGE_SCHEMES,
  WitnessKind,
  type EscrowMessageForm,
} from '@atum-labs/solana-escrow-encoding';
import {
  getChainAdapter,
  localKeySigner,
  verifyPaymentRequest,
  verifyPaymentRequestJSON,
  verifyRequestCommitment,
  verifyReserveAuth,
  type ReserveAuth,
  type ReserveAuthExpectations,
  type SolanaDomain,
} from './index.js';

const conformance = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../../conformance', name), 'utf8'));
const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const keyOf = (b: number) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(b));

const ALL_FORMS: EscrowMessageForm[] = ['raw', 'bare', 'v1', 'v0'];
const textKey = keyOf(0x42);

function signForm(
  key: nacl.SignKeyPair,
  form: EscrowMessageForm,
  kind: WitnessKind,
  hash: Uint8Array,
): string {
  const msg = escrowMessage(form, witnessLabel(kind), hash, key.publicKey);
  return hex(nacl.sign.detached(msg, key.secretKey));
}

const solana = adapter();

/** The outcome of a commitment check that throws CommitmentError on refusal. */
function outcomeOf(run: () => { outcome: string }): string {
  try {
    return run().outcome;
  } catch (e) {
    const outcome = (e as { result?: { outcome?: string } }).result?.outcome;
    if (outcome === undefined) throw e;
    return outcome;
  }
}
function adapter() {
  return getChainAdapter('solana:devnet');
}

/** The solana-honest commitment vector and its payer's key, a repeated byte seed. */
function solanaHonest() {
  const c = (
    conformance('commitment-vectors.json').requests as {
      name: string;
      request: string;
      solana: SolanaDomain;
    }[]
  ).find((r) => r.name === 'solana-honest')!;
  const req = JSON.parse(c.request);
  const account: string = req.source.account;
  for (let b = 0; b < 256; b++) {
    const key = keyOf(b);
    if (bs58.encode(key.publicKey) === account) {
      return {
        c,
        key,
        deposit: req.sender_auth.signed_messages[0] as { message: string; signature: string },
      };
    }
  }
  throw new Error('solana-honest: payer key is not a repeated byte seed');
}

describe('Solana deposit binding by scheme', () => {
  const { c, key, deposit } = solanaHonest();
  const digest = bytes(deposit.message);
  for (const scheme of MESSAGE_SCHEMES) {
    const accepted = messageForms(scheme);
    for (const form of ALL_FORMS) {
      const ok = accepted.includes(form);
      it(`scheme ${JSON.stringify(scheme)} ${form}: ${ok ? 'verified' : 'signer_mismatch'}`, () => {
        const request = c.request.replace(
          deposit.signature,
          signForm(key, form, WitnessKind.Deposit, digest),
        );
        const got = outcomeOf(() =>
          verifyRequestCommitment(request, { ...c.solana, messageScheme: scheme }),
        );
        expect(got).toBe(ok ? 'verified' : 'signer_mismatch');
      });
    }
  }

  it('a reserve text never binds a deposit', () => {
    const request = c.request.replace(
      deposit.signature,
      signForm(key, 'bare', WitnessKind.Reserve, digest),
    );
    expect(
      outcomeOf(() =>
        verifyRequestCommitment(request, { ...c.solana, messageScheme: 'escrow-text-v1' }),
      ),
    ).toBe('signer_mismatch');
  });

  it.each(['text', ' ', 'ESCROW-TEXT-V1'])('unknown scheme %j is verifier_misconfigured', (s) => {
    expect(
      outcomeOf(() => verifyRequestCommitment(c.request, { ...c.solana, messageScheme: s })),
    ).toBe('verifier_misconfigured');
  });

  it('expectations.svmMessageScheme reaches recoverAndVerify', () => {
    for (const scheme of MESSAGE_SCHEMES) {
      for (const form of ['raw', 'bare'] as const) {
        const signed = { ...deposit, signature: signForm(key, form, WitnessKind.Deposit, digest) };
        const run = () =>
          solana.recoverAndVerify(
            signed,
            { account: bs58.encode(key.publicKey), asset: '', network: 'solana:devnet' },
            { destinations: [], requestId: '' },
            {
              maxSourceAmount: '',
              escrowContract: c.solana.escrowProgramId,
              svmSignatureClusterId: c.solana.clusterId,
              svmSignatureDomainVersion: c.solana.domainVersion,
              svmMessageScheme: scheme,
            },
          );
        let outcome = '';
        try {
          run();
        } catch (e) {
          outcome = (e as { result?: { outcome?: string } }).result?.outcome ?? '';
        }
        expect(outcome === 'signer_mismatch', `${scheme} ${form}`).toBe(
          !messageForms(scheme).includes(form),
        );
      }
    }
  });
});

describe('Solana reserve binding by scheme', () => {
  const v = (
    conformance('reserve-auth-vectors.json').vectors as {
      name: string;
      input: { auth: ReserveAuth; expected: ReserveAuthExpectations };
    }[]
  ).find((x) => x.name === 'solana-verified')!;
  const expected = { ...v.input.expected, reserver: bs58.encode(textKey.publicKey) };
  const digest = bytes(v.input.auth.message);
  for (const scheme of MESSAGE_SCHEMES) {
    for (const form of ALL_FORMS) {
      const ok = messageForms(scheme).includes(form);
      it(`scheme ${JSON.stringify(scheme)} ${form}: ${ok ? 'verified' : 'signer_mismatch'}`, async () => {
        const auth = {
          ...v.input.auth,
          signature: signForm(textKey, form, WitnessKind.Reserve, digest),
        };
        const got = await verifyReserveAuth(auth, { ...expected, svmMessageScheme: scheme });
        expect(got.reason).toBe(ok ? 'verified' : 'signer_mismatch');
      });
    }
  }

  it('a deposit text never authorizes a reserve', async () => {
    const auth = {
      ...v.input.auth,
      signature: signForm(textKey, 'bare', WitnessKind.Deposit, digest),
    };
    const got = await verifyReserveAuth(auth, { ...expected, svmMessageScheme: 'escrow-text-v1' });
    expect(got.reason).toBe('signer_mismatch');
  });

  it('an unknown scheme is verifier_misconfigured', async () => {
    const got = await verifyReserveAuth(v.input.auth, {
      ...v.input.expected,
      svmMessageScheme: 'text',
    });
    expect(got.reason).toBe('verifier_misconfigured');
  });
});

// The forms each scheme accepts, written out rather than read from messageForms: the empty scheme
// accepts the raw hash only, and the text scheme the bare, v1 and v0 text only.
const ACCEPTED: Record<string, Record<EscrowMessageForm, boolean>> = {
  '': { raw: true, bare: false, v1: false, v0: false },
  'escrow-text-v1': { raw: false, bare: true, v1: true, v0: true },
};

describe('Solana bindings by scheme, hard-coded forms', () => {
  const { c, key, deposit } = solanaHonest();
  const v = (
    conformance('reserve-auth-vectors.json').vectors as {
      name: string;
      input: { auth: ReserveAuth; expected: ReserveAuthExpectations };
    }[]
  ).find((x) => x.name === 'solana-verified')!;
  for (const [scheme, forms] of Object.entries(ACCEPTED)) {
    for (const [form, ok] of Object.entries(forms) as [EscrowMessageForm, boolean][]) {
      it(`deposit, scheme ${JSON.stringify(scheme)} ${form}: ${ok ? 'verified' : 'signer_mismatch'}`, () => {
        const request = c.request.replace(
          deposit.signature,
          signForm(key, form, WitnessKind.Deposit, bytes(deposit.message)),
        );
        const got = outcomeOf(() =>
          verifyRequestCommitment(request, { ...c.solana, messageScheme: scheme }),
        );
        expect(got).toBe(ok ? 'verified' : 'signer_mismatch');
      });

      it(`reserve, scheme ${JSON.stringify(scheme)} ${form}: ${ok ? 'verified' : 'signer_mismatch'}`, async () => {
        const auth = {
          ...v.input.auth,
          signature: signForm(textKey, form, WitnessKind.Reserve, bytes(v.input.auth.message)),
        };
        const got = await verifyReserveAuth(auth, {
          ...v.input.expected,
          reserver: bs58.encode(textKey.publicKey),
          svmMessageScheme: scheme,
        });
        expect(got.reason).toBe(ok ? 'verified' : 'signer_mismatch');
      });
    }
  }
});

describe('verifyPaymentRequest carries the scheme', () => {
  const { c, key, deposit } = solanaHonest();
  const text = c.request.replace(
    deposit.signature,
    signForm(key, 'bare', WitnessKind.Deposit, bytes(deposit.message)),
  );
  const expected = (svmMessageScheme: string) => ({
    escrowContract: c.solana.escrowProgramId,
    svmSignatureClusterId: c.solana.clusterId,
    svmSignatureDomainVersion: c.solana.domainVersion,
    svmMessageScheme,
    maxSourceAmount: '1000000',
    nowSec: 1700000001,
  });

  it('a v5 text-signed deposit verifies under escrow-text-v1 and is refused under ""', () => {
    expect(c.solana.domainVersion).toBe(5);
    for (const verify of [
      () => verifyPaymentRequestJSON(text, expected('escrow-text-v1')),
      () => verifyPaymentRequest(JSON.parse(text), expected('escrow-text-v1')),
    ]) {
      expect(verify().results).toHaveLength(1);
    }
    expect(outcomeOf(() => verifyPaymentRequestJSON(text, expected('')) as never)).toBe(
      'signer_mismatch',
    );
    expect(outcomeOf(() => verifyPaymentRequest(JSON.parse(text), expected('')) as never)).toBe(
      'signer_mismatch',
    );
  });
});

describe('Solana recoverSigner', () => {
  const account = bs58.encode(textKey.publicKey);
  const hash = new Uint8Array(32).fill(0xab);
  for (const kind of [WitnessKind.Deposit, WitnessKind.Reserve]) {
    for (const form of ALL_FORMS) {
      it(`accepts kind ${kind} ${form}`, () => {
        const signed = { message: hex(hash), signature: signForm(textKey, form, kind, hash) };
        expect(solana.recoverSigner(signed, { account, asset: '', network: 'solana:devnet' })).toBe(
          account,
        );
      });
    }
  }
  it.each([
    ['another key', signForm(keyOf(0x43), 'bare', WitnessKind.Deposit, hash)],
    ['release text', signForm(textKey, 'bare', WitnessKind.Release, hash)],
    ['another hash', signForm(textKey, 'raw', WitnessKind.Deposit, new Uint8Array(32))],
  ])('refuses %s', (_name, signature) => {
    expect(() =>
      solana.recoverSigner(
        { message: hex(hash), signature },
        { account, asset: '', network: 'solana:devnet' },
      ),
    ).toThrow('ed25519 verification failed');
  });
});

describe('Solana signing by scheme', () => {
  const seed = Buffer.from(textKey.secretKey.subarray(0, 32)).toString('hex');
  const hash = new Uint8Array(32).fill(0xcd);
  const reserve = '{"deposit_hash":"0x11","recipient":"r","quote_hash":"0x33","source_amount":"1"}';
  const deposit = '{"deposit_request_hash":"0x11","depositor":"d","destination":"x"}';
  it.each([
    ['default raw', undefined, undefined, hash],
    ['empty scheme is raw', '', reserve, hash],
    ['text deposit', 'escrow-text-v1', undefined, escrowText('atum deposit v1', hash)],
    ['text deposit record', 'escrow-text-v1', deposit, escrowText('atum deposit v1', hash)],
    ['text reserve record', 'escrow-text-v1', reserve, escrowText('atum reserve v1', hash)],
  ])('%s', async (_name, scheme, prehash, want) => {
    const input = {
      message: hex(hash),
      signature: '',
      message_prehash: prehash,
      svmMessageScheme: scheme,
    };
    const sig = await solana.sign(input, seed);
    expect(nacl.sign.detached.verify(want, bytes(sig), textKey.publicKey)).toBe(true);
    const out = await localKeySigner('solana:devnet', seed).sign(input);
    expect(out).toEqual({ signature: sig, delegateSigner: bs58.encode(textKey.publicKey) });
  });

  it('an unknown scheme throws', async () => {
    await expect(
      solana.sign({ message: hex(hash), signature: '', svmMessageScheme: 'text' }, seed),
    ).rejects.toThrow('unknown message scheme');
    await expect(
      solana.sign({ message: '0x00', signature: '', svmMessageScheme: 'escrow-text-v1' }, seed),
    ).rejects.toThrow('32-byte');
  });
});
