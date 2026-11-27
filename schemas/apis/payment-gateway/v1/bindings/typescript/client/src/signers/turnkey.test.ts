// Mock @solana/web3.js so tests don't load its ESM-only transitive deps (uuid via
// rpc-websockets) under jest's CommonJS runtime. TurnkeySolanaSigner only needs
// PublicKey to be constructible from a base58 string; the actual signature check
// uses tweetnacl. In production the real @solana/web3.js is loaded lazily via
// ./turnkey-impl at runtime (Node handles the ESM deps fine).
jest.mock('@solana/web3.js', () => ({
  PublicKey: class {
    constructor(private readonly value: string) {}
    toBase58(): string {
      return this.value;
    }
    equals(): boolean {
      return false;
    }
  },
  VersionedTransaction: class {},
}));

import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

import { localKeySigner } from '@atum-labs/payment-request-sender-auth';
import { createSenderSigner } from './index';
import { TurnkeySenderSigner } from './turnkey';
import type { TurnkeyImplModule } from './turnkey';
import { getChainAdapter } from '../chain-adapters';
import type { SignedMessage } from '../generated/types.gen';
import { createPermitWitnessTransferFromPrehashWithDestination } from '@atum-labs/evm-escrow-encoding';
import { hashPermitWitnessTransferFrom } from '../sender_auth_schemes/evm_permit2';
import { createTvmPermitWitnessTransferFromPrehashWithDestination } from '@atum-labs/tvm-escrow-encoding';
import { hashTvmPermitWitnessTransferFrom } from '../sender_auth_schemes/tron';
import { signWithTurnkeyClient, turnkeySign } from './turnkey-impl';

// Compile-time guard: the real `turnkeySign` must stay assignable to the interface
// src/signers/turnkey.ts loads it as. If the impl signature drifts (renamed/removed
// field, reordered params), this line fails to compile at test time.
const _implConformance: TurnkeyImplModule['turnkeySign'] = turnkeySign;
void _implConformance;

// ── Wiring: TurnkeySenderSigner forwards to the (lazily-loaded) impl ──────────

describe('TurnkeySenderSigner wiring', () => {
  it('forwards chain, config and message to the impl and returns its result', async () => {
    const calls: unknown[] = [];
    const fakeImpl: TurnkeyImplModule = {
      turnkeySign: async (chainPrefix, cfg, message, messagePrehash) => {
        calls.push({ chainPrefix, cfg, message, messagePrehash });
        return { signature: '0xdeadbeef', delegateSigner: 'SoLDelegate' };
      },
    };
    const signer = new TurnkeySenderSigner(
      'solana',
      {
        organizationId: 'org',
        walletId: 'w',
        apiPublicKey: 'pub',
        apiPrivateKey: 'priv',
        pinnedAddress: 'Depositor',
      },
      async () => fakeImpl,
    );

    const result = await signer.sign({ message: '0xabcd', signature: '' } as SignedMessage);

    expect(result).toEqual({ signature: '0xdeadbeef', delegateSigner: 'SoLDelegate' });
    expect(calls).toEqual([
      {
        chainPrefix: 'solana',
        cfg: {
          organizationId: 'org',
          walletId: 'w',
          apiPublicKey: 'pub',
          apiPrivateKey: 'priv',
          pinnedAddress: 'Depositor',
        },
        message: '0xabcd',
        messagePrehash: undefined,
      },
    ]);
  });

  it('forwards logger and meter to the impl when provided', async () => {
    let forwarded: any;
    const fakeImpl: TurnkeyImplModule = {
      turnkeySign: async (_chainPrefix, cfg) => {
        forwarded = cfg;
        return { signature: '0x00' };
      },
    };
    const logger: any = { tag: 'logger' };
    const meter: any = { tag: 'meter' };
    const signer = new TurnkeySenderSigner(
      'eip155',
      {
        organizationId: 'org',
        walletId: 'w',
        apiPublicKey: 'pub',
        apiPrivateKey: 'priv',
        logger,
        meter,
      },
      async () => fakeImpl,
    );

    await signer.sign({ message: '0xabcd', signature: '' } as SignedMessage);

    expect(forwarded.logger).toBe(logger);
    expect(forwarded.meter).toBe(meter);
  });

  it('omits logger and meter from the forwarded config when not provided', async () => {
    let forwarded: any;
    const fakeImpl: TurnkeyImplModule = {
      turnkeySign: async (_chainPrefix, cfg) => {
        forwarded = cfg;
        return { signature: '0x00' };
      },
    };
    const signer = new TurnkeySenderSigner(
      'eip155',
      { organizationId: 'org', walletId: 'w', apiPublicKey: 'pub', apiPrivateKey: 'priv' },
      async () => fakeImpl,
    );

    await signer.sign({ message: '0xabcd', signature: '' } as SignedMessage);

    expect('logger' in forwarded).toBe(false);
    expect('meter' in forwarded).toBe(false);
  });
});

// ── Parity: Turnkey signatures byte-match the private-key path ────────────────
//
// A fake TurnkeyClient signs with a known local key (the same key the raw adapter
// uses), so we can assert the two paths produce identical wire output.

const EVM_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function permitPrehash() {
  return createPermitWitnessTransferFromPrehashWithDestination({
    chainId: 42161,
    verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    amount: '100000',
    spender: '0x1111111111111111111111111111111111111111',
    nonce: 1n,
    deadline: 1924991999n,
    depositRequestHash: '0x' + '11'.repeat(32),
    destination:
      'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831@0x4444444444444444444444444444444444444444',
    reserver: '0x2222222222222222222222222222222222222222',
    releaser: '0x3333333333333333333333333333333333333333',
  });
}

// secp256k1 fake modeling BOTH Turnkey server-side digest derivations:
//   PAYLOAD_ENCODING_EIP712       → parse the typed-data JSON and hash per EIP-712
//   PAYLOAD_ENCODING_HEXADECIMAL  → keccak256 the raw preimage (EIP-191/TIP-191/W3C proofs)
// signTypedData now takes the EIP712 branch so Turnkey can read the struct for policy
// evaluation; signMessage/signPreimage still take the HEXADECIMAL branch.
// `v` is the recovery id (0/1) as Turnkey returns it; secp256k1-helpers.ts normalizes it
// via ethers' Signature.from.
function secp256k1Client(wallet: ethers.Wallet, addressFormat: string, address: string) {
  return {
    listWalletAccounts: async () => [{ addressFormat, address }],
    signRawPayload: async ({ payload, encoding }: { payload: string; encoding?: string }) => {
      let digest: string;
      if (encoding === 'PAYLOAD_ENCODING_EIP712') {
        const td = JSON.parse(payload) as {
          domain: Record<string, unknown>;
          types: Record<string, { name: string; type: string }[]>;
          message: Record<string, unknown>;
        };
        // ethers infers EIP712Domain from the domain object, so strip it before re-hashing.
        const { EIP712Domain: _omit, ...structTypes } = td.types;
        digest = ethers.TypedDataEncoder.hash(td.domain, structTypes, td.message);
      } else {
        digest = ethers.keccak256('0x' + payload);
      }
      const sig = wallet.signingKey.sign(digest);
      return { r: sig.r, s: sig.s, v: sig.yParity.toString(16) };
    },
  };
}

// EVM base58check helper for Tron: 0x41 ‖ 20-byte addr ‖ sha256d checksum.
function evmToTronBase58(evmAddress: string): string {
  const raw = '41' + evmAddress.slice(2);
  const checksum = ethers.sha256(ethers.sha256('0x' + raw)).slice(2, 10);
  return bs58.encode(Buffer.from(raw + checksum, 'hex'));
}

const CFG = {
  organizationId: 'org',
  walletId: 'wallet',
  apiPublicKey: 'pub',
  apiPrivateKey: 'priv',
  discoveryTimeoutMs: 1000,
};

describe('Turnkey prehash binding', () => {
  it('signs a Go built prehash that carries an explicit EIP712Domain entry', async () => {
    // Go marshals apitypes.TypedData with EIP712Domain in Types. ethers derives that entry itself
    // and throws on an explicit one, so it must be stripped before it reaches signTypedData, not
    // only before the digest check.
    const wallet = new ethers.Wallet(EVM_PK);
    const permit = permitPrehash();
    const goShaped = {
      ...permit,
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        ...permit.types,
      },
    };
    const client = secp256k1Client(wallet, 'ADDRESS_FORMAT_ETHEREUM', wallet.address);

    const result = await signWithTurnkeyClient(
      client as never,
      'eip155',
      CFG,
      hashPermitWitnessTransferFrom(permit),
      JSON.stringify(goShaped),
    );

    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('refuses to sign when message_prehash disagrees with the advertised digest', async () => {
    // Both fields are caller-supplied. Signing the prehash while advertising a different digest
    // would have Turnkey authorize one permit and every verifier read another.
    const wallet = new ethers.Wallet(EVM_PK);
    const permitA = permitPrehash();
    const permitB = { ...permitA, message: { ...permitA.message, nonce: '999' } };
    const digestA = hashPermitWitnessTransferFrom(permitA);
    const digestB = hashPermitWitnessTransferFrom(permitB);
    expect(digestA).not.toBe(digestB);

    const client = secp256k1Client(wallet, 'ADDRESS_FORMAT_ETHEREUM', wallet.address);
    await expect(
      signWithTurnkeyClient(client as never, 'eip155', CFG, digestA, JSON.stringify(permitB)),
    ).rejects.toThrow(/implies digest/);
  });
});

describe('Turnkey signature parity with the private-key path', () => {
  it('EVM: signTypedData output equals the adapter (recoverable secp256k1)', async () => {
    const wallet = new ethers.Wallet(EVM_PK);
    const prehash = permitPrehash();
    const sm = {
      message: hashPermitWitnessTransferFrom(prehash),
      message_prehash: JSON.stringify(prehash),
      signature: '',
    } as SignedMessage;

    // Reference: the raw private-key path, which now signs through the shared SDK.
    const adapter = getChainAdapter('eip155:42161');
    const expected = (
      await localKeySigner('eip155:42161', adapter.formatPrivateKey(EVM_PK)).sign(sm)
    ).signature;

    const client = secp256k1Client(wallet, 'ADDRESS_FORMAT_ETHEREUM', wallet.address);
    const result = await signWithTurnkeyClient(
      client as never,
      'eip155',
      CFG,
      sm.message,
      sm.message_prehash,
    );

    expect(result.signature).toBe(expected);
    expect(result.delegateSigner).toBeUndefined();
  });

  it('Tron: signTypedData output equals the adapter raw-hash signature', async () => {
    const wallet = new ethers.Wallet(EVM_PK);
    // Use the real TVM prehash builder (address normalization, 0x41 strip, chain-ID
    // mask) so the test exercises the Tron-specific path, not the EVM one.
    const prehash = createTvmPermitWitnessTransferFromPrehashWithDestination({
      chainId: 728126428,
      permit2Address: '0x1111111111111111111111111111111111111111',
      tokenAddress: '0x2222222222222222222222222222222222222222',
      amount: '100000',
      spenderAddress: '0x3333333333333333333333333333333333333333',
      nonce: 1n,
      deadline: 1924991999n,
      depositRequestHash: '0x' + '11'.repeat(32),
      destination:
        'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t@TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB',
      reserverAddress: '0x4444444444444444444444444444444444444444',
      releaserAddress: '0x5555555555555555555555555555555555555555',
    });
    const sm = {
      message: hashTvmPermitWitnessTransferFrom(prehash),
      message_prehash: JSON.stringify(prehash),
      signature: '',
    } as SignedMessage;

    // The raw Tron adapter signs the precomputed message hash directly.
    const expected = wallet.signingKey.sign(sm.message!).serialized;

    const tronAddress = evmToTronBase58(wallet.address);
    const client = secp256k1Client(wallet, 'ADDRESS_FORMAT_TRON', tronAddress);
    const result = await signWithTurnkeyClient(
      client as never,
      'tron',
      CFG,
      sm.message,
      sm.message_prehash,
    );

    expect(result.signature).toBe(expected);
    expect(result.delegateSigner).toBeUndefined();
  });

  it('Solana: signMessage output + delegateSigner equal the adapter', async () => {
    const seed = new Uint8Array(32).fill(7);
    const keypair = nacl.sign.keyPair.fromSeed(seed);
    const base58Pub = bs58.encode(keypair.publicKey);
    const seedHex = Buffer.from(seed).toString('hex');

    const message = '0x' + 'ab'.repeat(32);
    const sm = { message, signature: '' } as SignedMessage;

    // Reference: the raw private-key path, which now signs through the shared SDK.
    const adapter = getChainAdapter('solana:mainnet');
    const key = adapter.formatPrivateKey(seedHex);
    const { signature: expectedSig, delegateSigner: expectedDelegate } = await localKeySigner(
      'solana:mainnet',
      key,
    ).sign(sm);

    const client = {
      listWalletAccounts: async () => [
        { addressFormat: 'ADDRESS_FORMAT_SOLANA', address: base58Pub },
      ],
      signRawPayload: async ({ payload }: { payload: string }) => {
        const sig = nacl.sign.detached(
          Uint8Array.from(Buffer.from(payload, 'hex')),
          keypair.secretKey,
        );
        return {
          r: Buffer.from(sig.slice(0, 32)).toString('hex'),
          s: Buffer.from(sig.slice(32)).toString('hex'),
          v: '00',
        };
      },
    };

    const result = await signWithTurnkeyClient(
      client as never,
      'solana',
      CFG,
      sm.message,
      undefined,
    );

    expect(result.signature).toBe(expectedSig);
    expect(result.delegateSigner).toBe(expectedDelegate);
  });

  it('rejects an unsupported chain', async () => {
    const client = { listWalletAccounts: async () => [], signRawPayload: async () => ({}) };
    await expect(
      signWithTurnkeyClient(client as never, 'bitcoin', CFG, '0x00', undefined),
    ).rejects.toThrow(/Unsupported source chain/);
  });
});

// ── Input validation: malformed inputs reject clearly, never sign wrong bytes ──
// Validation runs before initialize(), so a stub client is never reached.
describe('Turnkey input validation', () => {
  const stub = {} as never;

  it('rejects malformed Solana message hex instead of silently signing', async () => {
    for (const bad of ['0xzz', '0xabc', '0x', '', undefined as unknown as string]) {
      await expect(signWithTurnkeyClient(stub, 'solana', CFG, bad, undefined)).rejects.toThrow(
        /non-empty 0x-prefixed hex string/,
      );
    }
  });

  it('rejects invalid-JSON message_prehash for EVM/Tron', async () => {
    await expect(signWithTurnkeyClient(stub, 'eip155', CFG, '0x00', 'not json')).rejects.toThrow(
      /is not valid JSON/,
    );
    await expect(signWithTurnkeyClient(stub, 'tron', CFG, '0x00', '{"domain":{')).rejects.toThrow(
      /is not valid JSON/,
    );
  });

  it('rejects message_prehash missing or wrong-typed domain/types/message', async () => {
    for (const bad of ['{}', '{"domain":1,"types":{},"message":{}}', 'null', '[]']) {
      await expect(signWithTurnkeyClient(stub, 'eip155', CFG, '0x00', bad)).rejects.toThrow(
        /must be a JSON object with domain, types and message/,
      );
    }
  });
});

// ── Pinned sender ─────────────────────────────────────────────────────────────
// An empty <sender> used to count as "no pin" and skip the wallet comparison entirely.
// Whitespace was forwarded and failed as an address mismatch, which named a padded value
// rather than the real problem. Both are now refused before anything is signed.
describe('Turnkey pinned sender', () => {
  const BLANK = /must be a non-empty address/;
  const SOLANA_MESSAGE = '0x' + 'ab'.repeat(32);
  const solanaAddress = (fill: number) =>
    bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(fill)).publicKey);
  // Answers discovery with a real wallet account and treats signing as a failure, so a guard
  // that did not fire surfaces as a signature attempt instead of a passing test.
  const walletClient = (address: string) => ({
    listWalletAccounts: async () => [{ addressFormat: 'ADDRESS_FORMAT_SOLANA', address }],
    signRawPayload: async () => {
      throw new Error('signed without checking the sender');
    },
  });

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['tab', '\t'],
    ['newline', '\n'],
  ])('refuses an %s pinned sender instead of signing', async (_label, pinnedAddress) => {
    await expect(
      signWithTurnkeyClient(
        walletClient(solanaAddress(3)) as never,
        'solana',
        { ...CFG, pinnedAddress },
        SOLANA_MESSAGE,
        undefined,
      ),
    ).rejects.toThrow(BLANK);
  });

  // These three pin the forwarding rather than the empty-sender bug: a non-blank pin was
  // always forwarded, and this is what stops a refactor from dropping it again.
  it('Solana: a pinned sender that is not the wallet address fails before signing', async () => {
    await expect(
      signWithTurnkeyClient(
        walletClient(solanaAddress(3)) as never,
        'solana',
        { ...CFG, pinnedAddress: solanaAddress(4) },
        SOLANA_MESSAGE,
        undefined,
      ),
    ).rejects.toThrow(/does not match Turnkey's/);
  });

  it('EVM: a pinned sender that is not the wallet address fails before signing', async () => {
    const wallet = new ethers.Wallet(EVM_PK);
    const prehash = permitPrehash();
    await expect(
      signWithTurnkeyClient(
        secp256k1Client(wallet, 'ADDRESS_FORMAT_ETHEREUM', wallet.address) as never,
        'eip155',
        { ...CFG, pinnedAddress: '0x0000000000000000000000000000000000000001' },
        hashPermitWitnessTransferFrom(prehash),
        JSON.stringify(prehash),
      ),
    ).rejects.toThrow(/does not match Turnkey's/);
  });

  it('Tron: a pinned sender that is not the wallet address fails before signing', async () => {
    const wallet = new ethers.Wallet(EVM_PK);
    const prehash = createTvmPermitWitnessTransferFromPrehashWithDestination({
      chainId: 728126428,
      permit2Address: '0x1111111111111111111111111111111111111111',
      tokenAddress: '0x2222222222222222222222222222222222222222',
      amount: '100000',
      spenderAddress: '0x3333333333333333333333333333333333333333',
      nonce: 1n,
      deadline: 1924991999n,
      depositRequestHash: '0x' + '11'.repeat(32),
      destination:
        'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t@TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB',
      reserverAddress: '0x4444444444444444444444444444444444444444',
      releaserAddress: '0x5555555555555555555555555555555555555555',
    });
    await expect(
      signWithTurnkeyClient(
        secp256k1Client(wallet, 'ADDRESS_FORMAT_TRON', evmToTronBase58(wallet.address)) as never,
        'tron',
        { ...CFG, pinnedAddress: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N' },
        hashTvmPermitWitnessTransferFrom(prehash),
        JSON.stringify(prehash),
      ),
    ).rejects.toThrow(/does not match Turnkey's/);
  });

  it('EVM: accepts the wallet address in another case, since checksum case carries no meaning', async () => {
    const wallet = new ethers.Wallet(EVM_PK);
    const prehash = permitPrehash();
    const result = await signWithTurnkeyClient(
      secp256k1Client(wallet, 'ADDRESS_FORMAT_ETHEREUM', wallet.address) as never,
      'eip155',
      { ...CFG, pinnedAddress: wallet.address.toLowerCase() },
      hashPermitWitnessTransferFrom(prehash),
      JSON.stringify(prehash),
    );

    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('Solana: with the pin set, the signature still byte-matches the private-key path', async () => {
    const seed = new Uint8Array(32).fill(3);
    const keypair = nacl.sign.keyPair.fromSeed(seed);
    const address = bs58.encode(keypair.publicKey);
    const sm = { message: SOLANA_MESSAGE, signature: '' } as SignedMessage;
    const adapter = getChainAdapter('solana:mainnet');
    const expected = await localKeySigner(
      'solana:mainnet',
      adapter.formatPrivateKey(Buffer.from(seed).toString('hex')),
    ).sign(sm);
    const client = {
      listWalletAccounts: async () => [{ addressFormat: 'ADDRESS_FORMAT_SOLANA', address }],
      signRawPayload: async ({ payload }: { payload: string }) => {
        const sig = nacl.sign.detached(
          Uint8Array.from(Buffer.from(payload, 'hex')),
          keypair.secretKey,
        );
        return {
          r: Buffer.from(sig.slice(0, 32)).toString('hex'),
          s: Buffer.from(sig.slice(32)).toString('hex'),
          v: '00',
        };
      },
    };

    const result = await signWithTurnkeyClient(
      client as never,
      'solana',
      { ...CFG, pinnedAddress: address },
      SOLANA_MESSAGE,
      undefined,
    );

    expect(result.signature).toBe(expected.signature);
    expect(result.delegateSigner).toBe(expected.delegateSigner);
  });

  it.each(['', '   ', '\t'])(
    'TurnkeySenderSigner refuses a blank pinned sender (%j) at construction',
    (pinnedAddress) => {
      expect(
        () =>
          new TurnkeySenderSigner('solana', {
            organizationId: 'org',
            walletId: 'w',
            apiPublicKey: 'pub',
            apiPrivateKey: 'priv',
            pinnedAddress,
          }),
      ).toThrow(BLANK);
    },
  );

  it('keeps the pin it validated when the caller blanks the config afterwards', async () => {
    // The config object belongs to the caller, so re-reading it at sign() time would let a
    // later blank erase the pin after it had been accepted.
    let forwarded: any;
    const fakeImpl: TurnkeyImplModule = {
      turnkeySign: async (_chainPrefix, cfg) => {
        forwarded = cfg;
        return { signature: '0x00' };
      },
    };
    const cfg = {
      organizationId: 'org',
      walletId: 'w',
      apiPublicKey: 'pub',
      apiPrivateKey: 'priv',
      pinnedAddress: 'Depositor',
    };
    const signer = new TurnkeySenderSigner('solana', cfg, async () => fakeImpl);

    cfg.pinnedAddress = '';
    await signer.sign({ message: '0xabcd', signature: '' } as SignedMessage);

    expect(forwarded.pinnedAddress).toBe('Depositor');
  });

  it.each(['', '  '])(
    'createSenderSigner refuses a blank pinned sender (%j) for the turnkey provider',
    (pinnedAddress) => {
      expect(() =>
        createSenderSigner('solana:mainnet', {
          provider: 'turnkey',
          organizationId: 'org',
          walletId: 'w',
          apiPublicKey: 'pub',
          apiPrivateKey: 'priv',
          pinnedAddress,
        }),
      ).toThrow(BLANK);
    },
  );
});
