/**
 * Shared test fixtures for the client/server suites: a deterministic signer, a fixed
 * clock, ready-made EVM/Tron/Solana corridors + challenges, and credential builders.
 * Not shipped (imported only by `*.test.ts`).
 */

import { expect, vi } from 'vitest';
import { Wallet, sha256, getBytes } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Credential } from 'mppx';
import { createSenderSigner } from '@atum-labs/payment-gateway-client';
import { registerClient, AtumEscrowTrustError } from './client.js';
import { buildChargeRequest } from './server.js';
import { INTENT_ID_META_KEY } from './internal.js';
import type {
  AtumEscrowCorridor,
  AtumEscrowChallenge,
  ChargeRequest,
  PaymentSubmitResult,
} from './index.js';
import type {
  AtumEscrowClientConfig,
  SenderSigner,
  TrustResolver,
  TrustedRoles,
} from './client.js';

/** Deterministic test signer (a well-known dev key) + a fixed clock so deadlines are stable. */
export const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const wallet = new Wallet(PRIVATE_KEY);
export const PAYER = wallet.address;
export const NOW = 1_700_000_000_000;
export const now = () => NOW;

/* ─── EVM fixtures ─── */

export const corridor: AtumEscrowCorridor = {
  destination: {
    network: 'eip155:42161',
    asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
    account: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    symbol: 'USDC',
    decimals: 6,
  },
  fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  markupBps: 300,
  quoteDeadlineSeconds: 20,
  fulfillmentDeadlineSeconds: 300,
  sources: [
    {
      network: 'eip155:8453',
      assets: [
        { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
      ],
      escrow: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
      reserver: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      releaser: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      fulfillmentVerifierEndpoint: 'https://verifier.example.com',
    },
  ],
};

export const EVM_SOURCE = {
  network: 'eip155:8453',
  asset: corridor.sources[0]!.assets[0]!.address,
};
export const request = buildChargeRequest(corridor, EVM_SOURCE, '10000000');

/** The per-purchase identifier the fixture challenges carry. */
export const INTENT_ID = 'order-fixture';
/** Challenge metadata stamped with a per-purchase identifier, as a merchant would. */
export const intentMeta = (intentId = INTENT_ID) => ({ [INTENT_ID_META_KEY]: intentId });

export const challenge = {
  id: 'chg_test',
  realm: 'api.example.com',
  method: 'atum-escrow',
  intent: 'charge',
  request,
  meta: intentMeta(),
} as AtumEscrowChallenge;

/** A completed settlement, as the gateway reports it. */
export const COMPLETED: PaymentSubmitResult = {
  payment_id: 'pay_1',
  status: 'completed',
  transactions: {
    deposit: { transaction_hash: '0xsource', chain_id: 'eip155:8453' },
    fulfillment: { transaction_hash: '0xdestination', chain_id: 'eip155:42161' },
  },
};

/** A submitter that always returns a completed settlement. */
export const okSubmitter = {
  submit: async () => COMPLETED,
};

/**
 * The deserialized-credential shape the tests read. This is mppx's own credential type
 * with the method's payload plugged in — exactly what `Credential.deserialize` returns.
 * A hand-narrowed stand-in would silently drop fields the suites assert on (`challenge`
 * carries the payment identifier in `meta`/`opaque`).
 */
export type TestCredential = Credential.Credential<{ paymentRequest: any }>;

export async function buildCredential(forChallenge = challenge): Promise<TestCredential> {
  const client = registerClient({
    signer: { privateKey: PRIVATE_KEY },
    account: PAYER,
    now,
    trust: fixtureTrust,
  });
  const credStr = await client.createCredential({ challenge: forChallenge });
  return Credential.deserialize<{ paymentRequest: any }>(credStr);
}

/** A credential for a contract-account payer (ERC-1271, such as a Safe) whose owner key signs. */
export const SAFE_PAYER = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe';
export async function buildContractAccountCredential(): Promise<TestCredential> {
  const client = registerClient({
    signer: { privateKey: PRIVATE_KEY },
    account: SAFE_PAYER,
    now,
    trust: fixtureTrust,
  });
  return Credential.deserialize<{ paymentRequest: any }>(
    await client.createCredential({ challenge }),
  );
}

/* ─── Tron fixtures ─── */

/** Derive the base58 (base58check) Tron address for an EVM-form address. */
export function evmToTronAddress(evmAddress: string): string {
  const payload = new Uint8Array([0x41, ...getBytes(evmAddress)]);
  const checksum = getBytes(sha256(sha256(payload))).slice(0, 4);
  return bs58.encode(new Uint8Array([...payload, ...checksum]));
}

export const TRON_PAYER = evmToTronAddress(wallet.address);
export const tronCorridor: AtumEscrowCorridor = {
  ...corridor,
  sources: [
    {
      network: 'tron:mainnet',
      assets: [{ address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', decimals: 6 }],
      escrow: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
      reserver: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
      releaser: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S',
      fulfillmentVerifierEndpoint: 'https://verifier.example.com',
    },
  ],
};
export const tronRequest = buildChargeRequest(
  tronCorridor,
  { network: 'tron:mainnet', asset: tronCorridor.sources[0]!.assets[0]!.address },
  '10000000',
);
export const tronChallenge = { ...challenge, request: tronRequest } as AtumEscrowChallenge;

export async function buildTronCredential(forChallenge = tronChallenge): Promise<TestCredential> {
  const client = registerClient({
    signer: { privateKey: PRIVATE_KEY },
    account: TRON_PAYER,
    now,
    trust: fixtureTrust,
  });
  return Credential.deserialize<{ paymentRequest: any }>(
    await client.createCredential({ challenge: forChallenge }),
  );
}

/* ─── Solana fixtures ─── */

/** Deterministic ed25519 keypair from a fixed seed. */
const seed = new Uint8Array(32).fill(7);
export const keyPair = nacl.sign.keyPair.fromSeed(seed);
export const SOL_PAYER = bs58.encode(keyPair.publicKey);
export const seedHex = Buffer.from(seed).toString('hex');
/** A distinct, non-zero base58 32-byte value. */
export const b58 = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));

export const solanaCorridor: AtumEscrowCorridor = {
  ...corridor,
  // Solana deposits expire within the escrow replay window, so the budget is capped.
  quoteDeadlineSeconds: 20,
  fulfillmentDeadlineSeconds: 100,
  sources: [
    {
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      assets: [
        { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
      ],
      escrow: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      reserver: b58(3),
      releaser: b58(4),
      fulfillmentVerifierEndpoint: 'https://verifier.example.com',
      svmSignatureClusterId: 'mainnet',
      svmSignatureDomainVersion: 5,
    },
  ],
};
export const solanaRequest = buildChargeRequest(
  solanaCorridor,
  {
    network: solanaCorridor.sources[0]!.network,
    asset: solanaCorridor.sources[0]!.assets[0]!.address,
  },
  '10000000',
);
export const solanaChallenge = { ...challenge, request: solanaRequest } as AtumEscrowChallenge;

export async function buildSolanaCredential(
  forChallenge = solanaChallenge,
): Promise<TestCredential> {
  const client = registerClient({
    signer: { privateKey: seedHex },
    account: SOL_PAYER,
    now,
    solanaClockReader: async () => BigInt(Math.floor(NOW / 1000)),
    trust: fixtureTrust,
  });
  return Credential.deserialize<{ paymentRequest: any }>(
    await client.createCredential({ challenge: forChallenge }),
  );
}

/* ─── Trust fixtures ─── */

/**
 * What the payer's trust source vouches for on each fixture chain: exactly the roles and tokens
 * the corridors above name, so every fixture challenge is payable under the client's role and
 * markup checks. Each source chain also runs its own fulfillment proxy, deliberately different
 * from the destination's, so a client that checked the challenge's proxy against the SOURCE chain
 * would refuse every fixture.
 */
export const fixtureTrustTable: Readonly<Record<string, TrustedRoles>> = {
  [corridor.sources[0]!.network]: {
    escrowContract: corridor.sources[0]!.escrow,
    quoteSelector: corridor.sources[0]!.reserver,
    fulfillmentVerifierAccount: corridor.sources[0]!.releaser,
    fulfillmentProxy: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    tokens: [{ symbol: 'USDC', address: corridor.sources[0]!.assets[0]!.address, decimals: 6 }],
  },
  [corridor.destination.network]: {
    escrowContract: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    quoteSelector: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    fulfillmentVerifierAccount: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
    fulfillmentProxy: corridor.fulfillmentProxy,
    tokens: [{ symbol: 'USDC', address: corridor.destination.asset, decimals: 6 }],
  },
  [tronCorridor.sources[0]!.network]: {
    escrowContract: tronCorridor.sources[0]!.escrow,
    quoteSelector: tronCorridor.sources[0]!.reserver,
    fulfillmentVerifierAccount: tronCorridor.sources[0]!.releaser,
    fulfillmentProxy: 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py',
    tokens: [{ symbol: 'USDT', address: tronCorridor.sources[0]!.assets[0]!.address, decimals: 6 }],
  },
  [solanaCorridor.sources[0]!.network]: {
    escrowContract: solanaCorridor.sources[0]!.escrow,
    quoteSelector: solanaCorridor.sources[0]!.reserver,
    fulfillmentVerifierAccount: solanaCorridor.sources[0]!.releaser,
    fulfillmentProxy: b58(9),
    tokens: [
      { symbol: 'USDC', address: solanaCorridor.sources[0]!.assets[0]!.address, decimals: 6 },
    ],
  },
};

/** A trust source answering from {@link fixtureTrustTable}; an unlisted chain is a test bug. */
export const fixtureTrust: TrustResolver = async (network: string) => {
  const roles = fixtureTrustTable[network];
  if (roles === undefined) throw new Error(`fixture trust table has no entry for ${network}`);
  return roles;
};

/* ─── Client signing harness ─── */

/**
 * A trust source answering from a fixed per-network table; an unknown network is a test bug.
 * A fresh spy per call, so call records never carry over between tests.
 */
export function trustTable(table: Readonly<Record<string, TrustedRoles>>) {
  return vi.fn<TrustResolver>(async (network: string) => {
    const roles = table[network];
    if (roles === undefined) throw new Error(`test trust table has no entry for ${network}`);
    return roles;
  });
}

/** The payer key and chain-native account for a challenge's source chain. */
export function payerFor(network: string): { privateKey: string; account: string } {
  if (network.startsWith('tron:')) return { privateKey: PRIVATE_KEY, account: TRON_PAYER };
  if (network.startsWith('solana:')) return { privateKey: seedHex, account: SOL_PAYER };
  return { privateKey: PRIVATE_KEY, account: PAYER };
}

/** The client settings a refusal test varies; everything else is pinned by the harness. */
export type AttemptConfig = Partial<
  Pick<AtumEscrowClientConfig, 'trust' | 'maxMarkupBps' | 'pegGroups'>
>;

/**
 * Make an `attempt(challenge, config?)` that builds a credential with a real signer wrapped in a
 * spy, so a test can assert whether signing — the irreversible step — was ever reached.
 *
 * `table` is the trust source used when `config.trust` is not given. The payer and signer follow
 * the challenge's source chain unless `signAs` pins them to one chain, which lets a test hand the
 * client a challenge on a chain no signer exists for.
 */
export function attemptAgainst(
  table: Readonly<Record<string, TrustedRoles>>,
  { signAs }: { signAs?: string } = {},
) {
  return (chg: AtumEscrowChallenge, config: AttemptConfig = {}) => {
    const network = signAs ?? chg.request.source.network;
    const { privateKey, account } = payerFor(network);
    const real = createSenderSigner(network, { privateKey, pinnedAddress: account });
    const sign = vi.fn<SenderSigner['sign']>((message) => real.sign(message));
    const client = registerClient({
      signer: { sign },
      account,
      now,
      // Pinned cluster clock so a Solana build never depends on the local wall clock.
      solanaClockReader: async () => BigInt(Math.floor(NOW / 1000)),
      trust: trustTable(table),
      ...config,
    });
    return { result: client.createCredential({ challenge: chg }), sign };
  };
}

/** Await a rejection and hand back the error, failing the test if the promise resolved. */
export async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected the payment to be refused, but it was built');
    },
    (e: unknown) => e,
  );
}

/** {@link failure}, additionally asserting the error is a trust refusal. */
export async function trustFailure(p: Promise<unknown>): Promise<AtumEscrowTrustError> {
  const err = await failure(p);
  expect(err).toBeInstanceOf(AtumEscrowTrustError);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).name).toBe('AtumEscrowTrustError');
  return err as AtumEscrowTrustError;
}

/** A copy of a challenge with some `extra` fields overridden. */
export function withExtra(
  base: AtumEscrowChallenge,
  extra: Partial<ChargeRequest['extra']>,
): AtumEscrowChallenge {
  return {
    ...base,
    request: { ...base.request, extra: { ...base.request.extra, ...extra } },
  } as AtumEscrowChallenge;
}

/**
 * A copy of a challenge with its pricing terms (and optionally some `extra` fields) overridden.
 * An omitted `fulfillmentAmount` is the fixture's 10000000; omitted assets keep the challenge's.
 */
export function priced(
  terms: {
    amount: string;
    fulfillmentAmount?: string;
    asset?: string;
    destAsset?: string;
    extra?: Partial<ChargeRequest['extra']>;
  },
  base: AtumEscrowChallenge = challenge,
): AtumEscrowChallenge {
  const { source, extra } = base.request;
  return {
    ...base,
    request: {
      ...base.request,
      source: { ...source, amount: terms.amount, asset: terms.asset ?? source.asset },
      extra: {
        ...extra,
        fulfillmentAmount: terms.fulfillmentAmount ?? '10000000',
        destination: { ...extra.destination, asset: terms.destAsset ?? extra.destination.asset },
        ...terms.extra,
      },
    },
  } as AtumEscrowChallenge;
}
