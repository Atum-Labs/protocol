/**
 * The CoW Swap hook rows of the live policy matrix in test-policies.ts, run with the HOOK's API key.
 *
 * Each listed pair on each hook chain gets a buy then a sell ALLOW row: the orders the hook signs on
 * that pair, built the way km-core's Turnkey signer sends them (ethers `TypedDataEncoder.getPayload`),
 * so a mistyped pair fails the matrix rather than a payment. Each EIP-712 single-binding DENY changes
 * exactly one thing from the first chain's first ALLOW (a buy order), so a denial is attributable to
 * that binding. The pair rows (reversed, crossed, another chain's, the last pair
 * with a foreign receiver) are emitted only when the config makes them a real DENY; otherwise they
 * are skipped with a reason, never flipped to ALLOW.
 *
 * A DENY row is evidence for a hook DENY only when a settler ALLOW the hook user inherits would
 * otherwise admit the request; a request nothing allows is refused by default either way. The
 * fence rows are therefore the settler identity typed data, the self-send nonce burn and, with a
 * Solana account, ed25519 raw payloads. Raw hashing and management activities stay as defence in
 * depth.
 */
import { ethers } from 'ethers';

import { SETTLER_IDENTITY_VERIFYING_CONTRACT } from '../src/admin/policies';
import type { TurnkeyClient } from '../src/client';

export interface CowswapHookCase {
  name: string;
  expect: 'DENY' | 'ALLOW' | 'REJECTED' | 'REFUSED';
  run: () => Promise<unknown>;
}

export interface CowswapHookPairInput {
  readonly sell: string;
  readonly buy: string;
}

export interface CowswapHookCaseInput {
  /** Per chain in the settler config's `cowswapHook.chains`: its numeric id and token pairs. */
  hookChains: ReadonlyArray<{ readonly chainId: number; readonly pairs: readonly CowswapHookPairInput[] }>;
  /** An EVM chain id the hook is not configured for. */
  unlistedChainId: number;
  /** The settler wallet the hook signs for. */
  wallet: string;
  /** Read at run time: the client is only built for a live run. */
  client: () => TurnkeyClient;
  /** The settler config's chains. A Solana entry makes the set emit an ed25519 ALLOW. */
  configChains: Readonly<Record<string, { readonly kind: string }>>;
  /** The sub-org's Solana account, when the config lists a Solana chain. */
  solanaAddress?: string;
  /** Told why a pair row the config cannot make a DENY was left out. */
  onSkip?: (reason: string) => void;
}

const GPV2_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
const DECOY = '0x' + 'de'.repeat(20);

const ORDER_FIELDS = [
  { name: 'sellToken', type: 'address' },
  { name: 'buyToken', type: 'address' },
  { name: 'receiver', type: 'address' },
  { name: 'sellAmount', type: 'uint256' },
  { name: 'buyAmount', type: 'uint256' },
  { name: 'validTo', type: 'uint32' },
  { name: 'appData', type: 'bytes32' },
  { name: 'feeAmount', type: 'uint256' },
  { name: 'kind', type: 'string' },
  { name: 'partiallyFillable', type: 'bool' },
  { name: 'sellTokenBalance', type: 'string' },
  { name: 'buyTokenBalance', type: 'string' },
];

interface OrderOverrides {
  primaryType?: string;
  domain?: Partial<ethers.TypedDataDomain>;
  message?: Record<string, unknown>;
}

function orderPayload(
  chainId: number,
  wallet: string,
  pair: CowswapHookPairInput,
  o: OrderOverrides = {},
): string {
  const domain: ethers.TypedDataDomain = {
    name: 'Gnosis Protocol',
    version: 'v2',
    chainId,
    verifyingContract: GPV2_SETTLEMENT,
    ...o.domain,
  };
  const message = {
    // Lower-cased, the form the policy compares and ethers emits (it skips checksum validation).
    sellToken: pair.sell.toLowerCase(),
    buyToken: pair.buy.toLowerCase(),
    receiver: wallet,
    sellAmount: 1_000_000n,
    buyAmount: 990_000n,
    // Long expired: the signed order must be useless if the fence lets it through.
    validTo: 1_000_000_000,
    appData: '0x' + '33'.repeat(32),
    feeAmount: 0n,
    kind: 'buy',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    ...o.message,
  };
  const types = { [o.primaryType ?? 'Order']: ORDER_FIELDS };
  return JSON.stringify(ethers.TypedDataEncoder.getPayload(domain, types, message));
}

function identityPayload(wallet: string): string {
  return JSON.stringify(
    ethers.TypedDataEncoder.getPayload(
      { name: 'Atum Settler Identity', version: '1', verifyingContract: SETTLER_IDENTITY_VERIFYING_CONTRACT },
      { WalletProof: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'bytes32' }] },
      { wallet, nonce: '0x' + '44'.repeat(32) },
    ),
  );
}

/** The listed user `--as <userName>` names. Its id is what the run's whoami must return. */
export function fencedUserFor<U extends { userId: string; userName: string }>(
  users: readonly U[],
  asRole: string,
): U {
  const user = users.find((u) => u.userName === asRole);
  if (!user) {
    throw new Error(`--as ${asRole} names no user in cowswapHook.users (${users.map((u) => u.userName).join(', ')}).`);
  }
  return user;
}

/** Refuse a run whose credentials are not the expected user's, so one key cannot stand in for another. */
export function assertAuthenticatedAs(
  actualUserId: string | undefined,
  expectedUserId: string,
  label: string,
): void {
  if (actualUserId?.toLowerCase() !== expectedUserId.toLowerCase()) {
    throw new Error(
      `These credentials authenticate as ${actualUserId ?? 'an unknown user'}, not the ${label} user ` +
        `${expectedUserId}. Pass that user's key with --api-public-key-env / --api-private-key-env.`,
    );
  }
}

export function cowswapHookCases(input: CowswapHookCaseInput): CowswapHookCase[] {
  const { hookChains, unlistedChainId, wallet, client, configChains, solanaAddress } = input;
  const skip = input.onSkip ?? (() => undefined);
  const solanaConfigured = Object.values(configChains).some((c) => c.kind === 'solana');
  // The ed25519 rows are the only proof that the hook's encoding deny holds against the settler's
  // inherited ed25519 allow, so a run that cannot build them must not pass without them.
  if (solanaConfigured && !solanaAddress) {
    throw new Error(
      'The settler config lists a Solana chain, so the hook matrix needs the Solana account: pass ' +
        '--solana-address (or a --suborg-file naming it).',
    );
  }
  // Turnkey matches signWith by exact case, so it keeps the caller's form. Inside a payload the
  // address is lower-cased, which is how ethers emits it and skips checksum validation.
  const walletInPayload = wallet.toLowerCase();
  const firstChain = hookChains[0];
  if (firstChain === undefined) {
    throw new Error('cowswapHookCases needs at least one hook chain.');
  }
  for (const c of hookChains) {
    if (c.pairs.length === 0) throw new Error(`cowswapHookCases: eip155:${c.chainId} has no token pairs.`);
  }
  const first = firstChain.chainId;
  const firstPair = firstChain.pairs[0]!;
  const lower = (p: CowswapHookPairInput) => ({ sell: p.sell.toLowerCase(), buy: p.buy.toLowerCase() });
  const configured = (pairs: readonly CowswapHookPairInput[], p: CowswapHookPairInput) =>
    pairs.some((q) => lower(q).sell === lower(p).sell && lower(q).buy === lower(p).buy);
  const typed = (payload: string) => () =>
    client().signRawPayload({
      signWith: wallet,
      payload,
      encoding: 'PAYLOAD_ENCODING_EIP712',
      hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
    });
  const rawHex = (hashFunction: string) => () =>
    client().signRawPayload({
      signWith: wallet,
      payload: '0x' + 'aa'.repeat(32),
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction,
    } as Parameters<TurnkeyClient['signRawPayload']>[0]);

  // Buy before sell per pair: the first ALLOW is the buy order every single-binding DENY varies.
  const cases: CowswapHookCase[] = hookChains.flatMap(({ chainId, pairs }) =>
    pairs.flatMap((pair, i) =>
      (['buy', 'sell'] as const).map((kind) => ({
        name: `hook: GPv2 ${kind} order paying the wallet on eip155:${chainId}, pair ${i + 1} ${pair.sell} -> ${pair.buy} (positive control)`,
        expect: 'ALLOW' as const,
        run: typed(orderPayload(chainId, walletInPayload, pair, { message: { kind } })),
      })),
    ),
  );

  const variant = (name: string, o: OrderOverrides): CowswapHookCase => ({
    name: `hook: GPv2 order on eip155:${first} with ${name}`,
    expect: 'DENY',
    run: typed(orderPayload(first, walletInPayload, firstPair, o)),
  });
  cases.push(
    variant('another receiver', { message: { receiver: DECOY } }),
    variant('kind swap', { message: { kind: 'swap' } }),
    // The sell kind must not escape the && chain: every other binding still holds for it.
    variant('kind sell and another receiver', { message: { kind: 'sell', receiver: DECOY } }),
    variant('partiallyFillable true', { message: { partiallyFillable: true } }),
    variant('sellTokenBalance external', { message: { sellTokenBalance: 'external' } }),
    variant('buyTokenBalance internal', { message: { buyTokenBalance: 'internal' } }),
    variant(`an unlisted chain eip155:${unlistedChainId}`, { domain: { chainId: unlistedChainId } }),
    variant('another verifying contract', { domain: { verifyingContract: DECOY } }),
    variant('another domain name', { domain: { name: 'Gnosis Protocol X' } }),
    variant('another domain version', { domain: { version: 'v3' } }),
    variant('another primary type', { primaryType: 'OrderX' }),
    variant('an unlisted sell token', { message: { sellToken: DECOY } }),
    variant('an unlisted buy token', { message: { buyToken: DECOY } }),
    variant('a nonzero feeAmount', { message: { feeAmount: 1n } }),
  );

  // Pair rows. Each is a DENY only if the config does not list that pair on that chain.
  const pairRow = (name: string, chainId: number, pair: CowswapHookPairInput, o: OrderOverrides = {}) =>
    cases.push({
      name: `hook: GPv2 order on eip155:${chainId} with ${name}`,
      expect: 'DENY',
      run: typed(orderPayload(chainId, walletInPayload, pair, o)),
    });
  const reversed = { sell: firstPair.buy, buy: firstPair.sell };
  if (configured(firstChain.pairs, reversed)) {
    skip(`reversed first pair: ${reversed.sell} -> ${reversed.buy} is configured on eip155:${first}`);
  } else {
    pairRow('the first pair reversed', first, reversed);
  }
  const crossed = firstChain.pairs
    .map((p) => ({ sell: firstPair.sell, buy: p.buy }))
    .find((p) => lower(p).sell !== lower(p).buy && !configured(firstChain.pairs, p));
  if (crossed) {
    pairRow("the first pair's sell token with another pair's buy token", first, crossed);
  } else {
    skip(`crossed pair: every sell/buy combination of eip155:${first}'s pairs is configured`);
  }
  // `&&` binds tighter than `||`: a pair group joined without its outer parentheses would let a later
  // pair skip every other binding. Only a pair after the first can show that.
  const lastPair = firstChain.pairs[firstChain.pairs.length - 1]!;
  if (firstChain.pairs.length > 1) {
    pairRow('the last pair and another receiver', first, lastPair, { message: { receiver: DECOY } });
  } else {
    skip(`last pair with another receiver: eip155:${first} has one pair, covered by 'another receiver'`);
  }
  const other = hookChains.find((c) => c.chainId !== first && !configured(c.pairs, firstPair));
  if (other) {
    pairRow(`eip155:${first}'s first pair, which this chain does not list`, other.chainId, firstPair);
  } else {
    skip(`pair on another chain: no other hook chain lacks ${firstPair.sell} -> ${firstPair.buy}`);
  }

  cases.push(
    {
      name: 'hook: settler identity typed data',
      expect: 'DENY',
      run: typed(identityPayload(walletInPayload)),
    },
    { name: 'hook: raw payload KECCAK256', expect: 'DENY', run: rawHex('HASH_FUNCTION_KECCAK256') },
    { name: 'hook: raw payload NO_OP', expect: 'DENY', run: rawHex('HASH_FUNCTION_NO_OP') },
    // Turnkey refuses this pairing on secp256k1 at the API, so either refusal passes.
    { name: 'hook: raw hex payload NOT_APPLICABLE', expect: 'REFUSED', run: rawHex('HASH_FUNCTION_NOT_APPLICABLE') },
    {
      // The settler's allowSelfSendNonceBurn admits exactly this shape, so only the hook's
      // activity deny can refuse it.
      name: `hook: self-send nonce burn on eip155:${first} (inherited settler allow)`,
      expect: 'DENY',
      run: () =>
        client().signTransaction({
          signWith: wallet,
          unsignedTransaction: ethers.Transaction.from({
            type: 2,
            to: walletInPayload,
            value: 0n,
            data: '0x',
            nonce: 0,
            chainId: first,
            gasLimit: 21_000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
          }).unsignedSerialized.slice(2),
          type: 'TRANSACTION_TYPE_ETHEREUM',
        }),
    },
  );

  if (solanaAddress) {
    // The settler's allowEd25519RawPayload admits both; only the hook's encoding deny refuses them.
    cases.push(
      {
        name: 'hook: ed25519 hex payload with the Solana account (inherited settler allow)',
        expect: 'DENY',
        run: () =>
          client().signRawPayload({
            signWith: solanaAddress,
            payload: 'aa'.repeat(32),
            encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
            hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
          }),
      },
      {
        name: 'hook: ed25519 text payload with the Solana account (inherited settler allow)',
        expect: 'DENY',
        run: () =>
          client().signRawPayload({
            signWith: solanaAddress,
            payload: 'cowswap-hook policy probe',
            encoding: 'PAYLOAD_ENCODING_TEXT_UTF8',
            hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
          }),
      },
    );
  }

  const zeroId = '00000000-0000-0000-0000-000000000000';
  // Refused for every non-root user by default; kept as defence in depth. The policy probe is
  // inert, so a misconfigured run that let it through would add nothing.
  const management: Array<[string, string, Record<string, unknown>, CowswapHookCase['expect']]> = [
    ['ACTIVITY_TYPE_CREATE_API_KEYS_V2', 'create_api_keys', { apiKeys: [], userId: zeroId }, 'DENY'],
    [
      'ACTIVITY_TYPE_CREATE_POLICY_V3',
      'create_policy',
      { policyName: 'policy-probe', effect: 'EFFECT_DENY', condition: 'false', consensus: '', notes: '' },
      'DENY',
    ],
    // The fingerprint names no activity, so Turnkey may reject it before policy runs.
    ['ACTIVITY_TYPE_APPROVE_ACTIVITY', 'approve_activity', { fingerprint: 'policy-probe' }, 'REFUSED'],
  ];
  for (const [activityType, endpoint, params, expect] of management) {
    cases.push({
      name: `hook: ${activityType}`,
      expect,
      run: () => client().executeActivity(activityType, endpoint, params),
    });
  }
  return cases;
}
