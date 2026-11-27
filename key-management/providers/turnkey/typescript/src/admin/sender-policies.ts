// Sender sub-org Turnkey policy emitter.
//
// What the sender sub-org signs:
//   - secp256k1 accounts sign one thing: a Permit2 `PermitWitnessTransferFrom` EIP-712 / TIP-712
//     struct authorizing a deposit into the escrow, sent as `PAYLOAD_ENCODING_EIP712` so the allow
//     can bind the domain, the verifying contract and the message members. `spender` is bound
//     because Permit2 leaves the transfer recipient unsigned; `witness.destination` binds the payee.
//   - The only transaction the EVM/Tron wallet signs is `approve(Permit2, ...)`; token movement
//     goes through Permit2 under the signed authorization.
//   - On Solana the sender signs a raw ed25519 digest for the deposit's inner signature and
//     broadcasts only the escrow delegate create/revoke transactions. The settler assembles and
//     signs the deposit transaction.
//
// What it does NOT bound (see "What the sender set does NOT bind" in scripts/PROVISIONING.md):
//   - `permitted.amount`, `nonce`, `deadline` and `witness.depositRequestHash` are unbound, so a
//     stolen key can authorize deposits for the wallet's full balance into an allowlisted escrow.
//   - The Solana account is not bounded against a stolen key. A Solana transaction signature is
//     raw ed25519 over the serialized message, so anyone holding the API key can produce one
//     through the raw-payload allow without calling signTransaction, which is where the
//     solana.tx.* policies below apply. They constrain honest software; bounding the balance on
//     this account, or moving it to its own sub-org, is the control that applies.
//   - The Solana deposit signature is raw ed25519 over a digest that already has the destination
//     hashed into it, so no field-level policy can reach the payee there.

import { createHash } from 'node:crypto';

import {
  EIP712_RAW_PAYLOAD_CONDITION,
  buildAllowSignRawPayloadPolicy,
  buildAllowStellarRawPayloadPolicy,
  type PolicyDefinition,
} from './policies';

/** Canonical Uniswap Permit2, identical across every EVM chain (CREATE2 deterministic deploy). */
export const EVM_PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

/** Tron Permit2 deployment addresses (per-network). */
export const TRON_PERMIT2 = {
  mainnet: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
  shasta: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
} as const;

/** ERC-20 / TRC-20 transfer/approve selectors (4-byte function signatures). */
const APPROVE_SELECTOR = '0x095ea7b3';

/** The struct the sender signs. Anything else is a different authorization. */
const PERMIT2_PRIMARY_TYPE = 'PermitWitnessTransferFrom';

/** Permit2's EIP-712 domain carries no `version`, so a policy must not assert one. */
const PERMIT2_DOMAIN_NAME = 'Permit2';

/**
 * Tron's TIP-712 domain chain id, masked to 32 bits the way the TVM deposit encoder masks it, so
 * the policy always matches the domain the encoder signs.
 */
const TRON_TIP712_CHAIN_IDS: Record<string, number> = {
  mainnet: 728126428,
  shasta: 2494104990,
};

export function tronTip712ChainId(caip2: string, label = 'Sender extras'): number {
  const cluster = caip2.split(':')[1] ?? '';
  const id = Object.hasOwn(TRON_TIP712_CHAIN_IDS, cluster)
    ? TRON_TIP712_CHAIN_IDS[cluster]
    : undefined;
  if (id === undefined) {
    throw new Error(
      `${label}: unsupported Tron network "${caip2}". Known clusters: ` +
        `${Object.keys(TRON_TIP712_CHAIN_IDS).join(', ')}.`,
    );
  }
  return (id & 0xffffffff) >>> 0;
}

/**
 * Parse an `eip155:<id>` CAIP-2 into the integer form the policy engine compares against. Turnkey
 * re-parses the domain chainId, so a hex literal is refused at policy-create time with
 * `invalid comparison operation: 0 == 0x14a34`.
 */
export function evmNumericChainId(caip2: string, label = 'Sender extras'): number {
  const id = Number.parseInt(caip2.split(':')[1] ?? '', 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${label}: chain id "${caip2}" is not a usable eip155 CAIP-2 identifier.`);
  }
  return id;
}

const lower = (a: string): string => a.toLowerCase();

/**
 * Reject an EVM address that is not 20 bytes of hex. A malformed literal still produces a valid
 * condition that matches nothing, denying every payment on that chain. The Tron path fails the
 * same way through decoding and checksum verification.
 */
export function assertEvmAddress(
  address: string,
  chainKey: string,
  label = 'Sender extras',
): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(
      `${label}: ${JSON.stringify(address)} on chain "${chainKey}" is not a 20-byte 0x hex ` +
        `address. A malformed literal matches nothing, which denies every payment on this chain.`,
    );
  }
  return address;
}

/**
 * The form a Tron address takes inside a TIP-712 message: 20-byte hex, 0x-prefixed, 0x41 network
 * byte stripped — what the TVM deposit encoder's `normalizeAddress` puts on the wire. Accepts
 * either spelling so one config list can serve both this and the base58 calldata policy, and so a
 * config that already holds the hex form is not silently re-encoded.
 */
export function toTronEvmHex(address: string, label = 'Sender extras'): string {
  if (address.startsWith('T')) return `0x${tronBase58ToEvmHex(address)}`;
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return lower(address);
  throw new Error(
    `${label}: Tron address ${JSON.stringify(address)} is neither a base58 (T…) address nor ` +
      `a 20-byte 0x hex address, so its TIP-712 message form cannot be derived.`,
  );
}

/** Addresses only. Every address-typed EIP-712 member reaches Turnkey already lowercased by the
 * encoder, so folding the literal to match is safe here. */
const quotedLower = (xs: readonly string[]): string => xs.map((x) => `'${lower(x)}'`).join(', ');

/**
 * Destination strings, byte-for-byte. NEVER fold these: the casing rule is per-segment, and on a
 * Solana destination the CAIP-2 reference, the SPL mint and the account are all base58, so one
 * blanket toLowerCase corrupts three segments at once into a value that matches nothing.
 *
 * A quote in the value would break out of the condition literal, so reject rather than escape —
 * no legitimate destination contains one, and the grammar has no escaping rules to get right.
 */
function quotedExact(xs: readonly string[], chainKey: string): string {
  for (const x of xs) {
    if (x.includes("'") || x.includes('\\')) {
      throw new Error(
        `Sender extras: destination ${JSON.stringify(x)} on chain "${chainKey}" contains a quote ` +
          `or backslash, which cannot appear in a policy condition literal.`,
      );
    }
    if (x.length === 0 || !x.includes('@')) {
      throw new Error(
        `Sender extras: destination ${JSON.stringify(x)} on chain "${chainKey}" is not a composed ` +
          `destination (<caip19-asset>@<account>). Build it with buildEscrowDestination.`,
      );
    }
    if (Buffer.byteLength(x, 'utf8') > MAX_DESTINATION_BYTES) {
      throw new Error(
        `Sender extras: destination ${JSON.stringify(x)} on chain "${chainKey}" is longer than ` +
          `${MAX_DESTINATION_BYTES} bytes, which the escrow rejects as DestinationTooLong, so no ` +
          `deposit could ever carry it.`,
      );
    }
  }
  return xs.map((x) => `'${x}'`).join(', ');
}

/** Mirrors MAX_DESTINATION_BYTES in Escrow.sol and the sender-auth bindings. */
const MAX_DESTINATION_BYTES = 256;

/**
 * Solana programs the sender's deposit tx legitimately touches. Atum's escrow program ID is
 * read from the operator's extras file (per-deployment); the rest are network constants.
 */
const SOLANA_STANDARD_PROGRAMS = [
  '11111111111111111111111111111111', // System
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
  'ComputeBudget111111111111111111111111111111', // Compute Budget
  'Ed25519SigVerify111111111111111111111111111', // Ed25519 (inner signature verification)
];

/** Accept one program ID or several, and drop blanks and duplicates so the emitted allowlist has
 * each program exactly once in the order given. */
function solanaEscrowPrograms(value: string | readonly string[] | undefined): string[] {
  const raw = value === undefined ? [] : typeof value === 'string' ? [value] : value;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface SenderExtras {
  /** "mainnet" or "testnet" — selects Tron Permit2 deployment. */
  readonly network: 'mainnet' | 'testnet';
  /** Per-chain ERC-20 token contracts the sender may approve. Lowercased before policy emit. */
  readonly allowedTokens: Readonly<Record<string, readonly string[]>>;
  /**
   * Escrow contracts the sender may name as Permit2 `spender`, per chain key. REQUIRED for every
   * EVM and Tron chain.
   *
   * Permit2 leaves the transfer recipient out of the signed struct, so `spender` IS the funds
   * destination: whoever is named here is who may pull the approved allowance. A sender that
   * binds nothing else must still bind this, which is why it throws rather than defaulting.
   */
  readonly escrows: Readonly<Record<string, readonly string[]>>;
  /**
   * Witness roles the sender may sign, per chain key: `quote_selector` and
   * `fulfillment_verifier.account` from `GET /v1/defaults`. Required for every EVM and Tron chain,
   * since either role controls funds at settlement.
   */
  readonly reservers?: Readonly<Record<string, readonly string[]>>;
  readonly releasers?: Readonly<Record<string, readonly string[]>>;
  /**
   * Payment destinations the sender may commit to, per chain key, as the composed plaintext
   * strings the deposit witness carries. Compose them with `buildEscrowDestination`, never by
   * hand: the escrow stores only `keccak256(bytes(destination))`, and casing is per-segment
   * (eip155 hex folds to lowercase, base58 segments keep their exact case), so a hand-typed entry
   * can match nothing and deny every payment on that chain.
   *
   * Required for every EVM and Tron chain. A chain the sender never pays on belongs out of
   * `chains:`, not here with an empty list.
   */
  readonly allowedDestinations: Readonly<Record<string, readonly string[]>>;
  /** Permit2 address, if an EVM deployment ever diverges from the canonical CREATE2 one. */
  readonly permit2?: string;
  /** Atum's Solana escrow program ID, or several of them. Required if Solana is in the chain map.
   * A list allows more than one escrow deployment at once, for example while the SPL delegate
   * (one slot per wallet and mint) is moved from one program to another mint by mint. */
  readonly solanaEscrowProgramId?: string | readonly string[];
  /**
   * The sender's Stellar account(s) per Stellar chain key, `G...` strkeys. REQUIRED when a Stellar
   * chain is listed: the Stellar ed25519 raw allow is scoped to them. Turnkey cannot parse a
   * Stellar transaction, so this scoping is all the server-side fence there is.
   */
  readonly stellarSigners?: Readonly<Record<string, readonly string[]>>;
  /** Lamports cap on native SOL moves. Defaults to 10,000,000 (0.01 SOL) ATA-rent headroom. */
  readonly solanaMaxNativeValue?: string;
  /** Per-EVM-chain gas/fee caps. */
  readonly evmCaps?: Readonly<
    Record<string, { readonly maxGasLimit?: number; readonly maxFeePerGasWei?: string }>
  >;
  /** Per-Tron-chain fee_limit cap (SUN). */
  readonly tronCaps?: Readonly<Record<string, { readonly maxFeeLimitSun?: string }>>;
}

export interface ChainEntry {
  readonly key: string; // matches profile YAML's `chains:` keys (Ethereum, Arbitrum, ...)
  readonly kind: 'evm' | 'tron' | 'solana' | 'stellar';
  readonly chainId: string; // CAIP-2 — eip155:1, tron:mainnet, solana:..., stellar:testnet
}

/**
 * Emit Turnkey policy definitions for a sender sub-org given operator extras + the chain
 * registry. Pure function; no Turnkey calls.
 */
export function buildSenderPolicies(
  extras: SenderExtras,
  chains: readonly ChainEntry[],
): PolicyDefinition[] {
  const policies: PolicyDefinition[] = [];
  const permit2Evm = lower(extras.permit2 ?? EVM_PERMIT2);

  // The Permit2 authorization, bound field by field: the only raw-payload signature the sender's
  // secp256k1 accounts produce. PAYLOAD_ENCODING_EIP712 lets Turnkey parse the struct and expose
  // its domain and message members to the policy engine.
  for (const chain of chains) {
    if (chain.kind !== 'evm' && chain.kind !== 'tron') continue;
    policies.push(permit2TypedDataAllow(chain, extras, permit2Evm));
  }

  // Solana's deposit signature is raw ed25519 over a 32-byte digest, which needs NOT_APPLICABLE.
  if (chains.some((c) => c.kind === 'solana')) {
    policies.push(buildAllowSignRawPayloadPolicy());
  }

  // Stellar: raw ed25519 over a transaction hash or a message, scoped to the sender's own account.
  const stellarChains = chains.filter((c) => c.kind === 'stellar');
  if (stellarChains.length > 0) {
    policies.push(
      buildAllowStellarRawPayloadPolicy({
        role: 'Sender extras',
        signers: stellarChains.flatMap((c) => extras.stellarSigners?.[c.key] ?? []),
        encodings: ['PAYLOAD_ENCODING_HEXADECIMAL', 'PAYLOAD_ENCODING_TEXT_UTF8'],
      }),
    );
    for (const c of stellarChains) {
      if ((extras.stellarSigners?.[c.key] ?? []).length === 0) {
        throw new Error(`Sender extras: Stellar chain "${c.key}" has no stellarSigners.`);
      }
    }
  }

  for (const chain of chains) {
    if (chain.kind === 'evm') {
      const evmChainId = parseInt(chain.chainId.split(':')[1]!, 10);
      const tokens = extras.allowedTokens[chain.key]?.map((t) => t.toLowerCase()) ?? [];
      if (tokens.length === 0) {
        throw new Error(
          `Sender extras: chain "${chain.key}" has no allowedTokens. Add at least one ERC-20 ` +
            `contract address the sender's wallet is permitted to approve, or remove this chain.`,
        );
      }
      const tokenList = tokens.map((t) => `'${t}'`).join(', ');
      // Decode the `spender` argument of approve(address,uint256) from calldata. Selector lives
      // at data[0..10]; the address arg is 32-byte left-padded at data[10..74], with the actual
      // 20-byte address occupying data[34..74], compared to Permit2 (lowercased, no 0x prefix).
      // Uses the same Permit2 address, including any override, as the typed-data allow.
      const permit2Lower = permit2Evm.replace(/^0x/, '');
      policies.push({
        policyName: `allowApproveToPermit2 (${chain.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition:
          `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
          `eth.tx.chain_id == ${evmChainId} && ` +
          `eth.tx.to in [${tokenList}] && ` +
          `eth.tx.data[0..10] == '${APPROVE_SELECTOR}' && ` +
          `eth.tx.data[34..74] == '${permit2Lower}'`,
        notes:
          'Allows ERC-20 approve(Permit2, amount) on allowlisted token contracts. Permit2 is ' +
          'the only legitimate approve spender for the sender flow.',
      });

      // Native value defense: sender never sends ETH. Default cap = 0 (deny any non-zero).
      policies.push({
        policyName: `denyNonZeroValue (${chain.chainId})`,
        effect: 'EFFECT_DENY',
        condition:
          `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
          `eth.tx.chain_id == ${evmChainId} && eth.tx.value > 0`,
        notes: 'Sender flow never moves native ETH; deny any non-zero value.',
      });

      const caps = extras.evmCaps?.[chain.key];
      if (caps?.maxGasLimit != null) {
        policies.push({
          policyName: `maxGasLimit (${chain.chainId})`,
          effect: 'EFFECT_DENY',
          condition:
            `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
            `eth.tx.chain_id == ${evmChainId} && eth.tx.gas > ${caps.maxGasLimit}`,
          notes: 'Gas DoS defense.',
        });
      }
      if (caps?.maxFeePerGasWei != null) {
        policies.push({
          policyName: `maxFeePerGasWei (${chain.chainId})`,
          effect: 'EFFECT_DENY',
          condition:
            `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
            `eth.tx.chain_id == ${evmChainId} && ` +
            `(eth.tx.max_fee_per_gas > ${caps.maxFeePerGasWei} || eth.tx.gas_price > ${caps.maxFeePerGasWei})`,
          notes: 'Fee DoS defense (covers EIP-1559 and legacy).',
        });
      }
    }

    if (chain.kind === 'tron') {
      const permit2 = TRON_PERMIT2[extras.network === 'mainnet' ? 'mainnet' : 'shasta'];
      const tokens = extras.allowedTokens[chain.key]?.map((t) => t) ?? [];
      if (tokens.length === 0) {
        throw new Error(
          `Sender extras: Tron chain "${chain.key}" has no allowedTokens. Add at least one ` +
            `TRC-20 contract base58 address the sender may approve, or remove this chain.`,
        );
      }
      const tokenList = tokens.map((t) => `'${t}'`).join(', ');
      // Tron's `data` field is hex without 0x prefix. selector = data[0..8]; approve spender
      // address sits at data[32..72] as a 20-byte hex segment (no 0x41 prefix — Permit2's TVM
      // address normalized to EVM-hex form). The protocol's sender-auth check normalizes the
      // spender the same way, so we compare against the same normalization.
      const permit2Hex = tronBase58ToEvmHex(permit2);
      policies.push({
        policyName: `allowApproveToPermit2 (${chain.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition:
          `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
          `tron.tx.contract.all(c, c.contract_address in [${tokenList}] && ` +
          `c.data[0..8] == '${APPROVE_SELECTOR.replace(/^0x/, '')}' && ` +
          `c.data[32..72] == '${permit2Hex}')`,
        notes: 'Allows TRC-20 approve(Permit2, amount) on allowlisted token contracts.',
      });

      // Native value defense for Tron contracts: sender never sends TRX.
      policies.push({
        policyName: `denyNonZeroAmount (${chain.chainId})`,
        effect: 'EFFECT_DENY',
        condition:
          `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
          `tron.tx.contract.any(c, c.amount > 0)`,
        notes: 'Sender flow never moves native TRX; deny any non-zero amount.',
      });

      const caps = extras.tronCaps?.[chain.key];
      if (caps?.maxFeeLimitSun != null) {
        policies.push({
          policyName: `maxFeeLimitSun (${chain.chainId})`,
          effect: 'EFFECT_DENY',
          condition:
            `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
            `tron.tx.fee_limit > ${caps.maxFeeLimitSun}`,
          notes: 'Tron bandwidth/energy DoS defense.',
        });
      }
    }

    if (chain.kind === 'solana') {
      const escrowPrograms = solanaEscrowPrograms(extras.solanaEscrowProgramId);
      if (escrowPrograms.length === 0) {
        throw new Error(
          `Sender extras includes Solana chain but no solanaEscrowProgramId. Set it to Atum's ` +
            `escrow program ID for this deployment, or to a list of them.`,
        );
      }
      const allowed = [...SOLANA_STANDARD_PROGRAMS, ...escrowPrograms];
      const list = allowed.map((p) => `'${p}'`).join(', ');
      policies.push({
        policyName: `allowedPrograms (${chain.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition:
          `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
          `solana.tx.instructions.all(i, i.program_key in [${list}])`,
        notes:
          'Sender Solana deposit txs invoke ComputeBudget + Ed25519Program + Atum escrow only.',
      });

      // allowedPrograms alone does not bound WHAT the allowlisted programs do. Since System and
      // SPL Token are allowlisted, a top-level System.transfer (SOL drain) or SPL transfer (token
      // drain) would otherwise pass. A sender's deposit moves tokens only via escrow CPI and needs
      // just ATA-rent lamports, so cap native SOL and deny every top-level SPL transfer.
      const solCap = extras.solanaMaxNativeValue ?? '10000000';
      policies.push({
        policyName: `maxNativeValue (${chain.chainId})`,
        effect: 'EFFECT_DENY',
        condition:
          `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
          `solana.tx.transfers.any(t, t.amount > ${solCap})`,
        notes: 'Caps native SOL (lamports); default 10,000,000 (0.01 SOL) ATA-rent headroom.',
      });
      policies.push({
        policyName: `denySplTransfers (${chain.chainId})`,
        effect: 'EFFECT_DENY',
        condition:
          `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
          `solana.tx.spl_transfers.any(t, !(t.to in []))`,
        notes: 'Denies all top-level SPL transfers; the sender moves tokens only via escrow CPI.',
      });
    }
  }

  // Every raw-signing mode the sender does not use. Denies are evaluated ahead of allows, so
  // these hold even if an allow above is widened.
  policies.push(...typedDataOnlyRawSigningDenies('sender'));

  return policies;
}

/**
 * The per-chain Permit2 typed-data ALLOW: the sender's single fund-moving signature, with the
 * domain, `spender`, token, witness roles and destination pinned to the deployment's values.
 */
function permit2TypedDataAllow(
  chain: ChainEntry,
  extras: SenderExtras,
  permit2Evm: string,
): PolicyDefinition {
  const escrowsRaw = extras.escrows?.[chain.key] ?? [];
  if (escrowsRaw.length === 0) {
    throw new Error(
      `Sender extras: chain "${chain.key}" has no escrows. Permit2 leaves the transfer recipient ` +
        `out of the signed struct, so the escrow named as \`spender\` is the funds destination and ` +
        `must be bound. Read it from the gateway's GET ` +
        `/v1/defaults?chain_id=${chain.chainId} (escrow_contract).`,
    );
  }

  // Tron's TIP-712 shares the EIP-712 wire format, so one condition shape covers both. What
  // differs is the domain: Tron masks its chain id to 32 bits and carries Permit2 as the
  // EVM-hex form of its base58 address, matching what the deposit encoder puts on the wire.
  const isTron = chain.kind === 'tron';
  // Both Tron domain values must come from the same cluster: `extras.network` selects the Permit2
  // deployment and the CAIP-2 selects the chain id. A mismatched pairing would match no signature
  // the runtime produces, so it is refused.
  const tronCluster = isTron ? (chain.chainId.split(':')[1] ?? '') : '';
  if (isTron) {
    const expected = extras.network === 'mainnet' ? 'mainnet' : 'shasta';
    if (tronCluster !== expected) {
      throw new Error(
        `Sender extras: network "${extras.network}" selects the ${expected} Permit2 deployment, ` +
          `but chain "${chain.key}" is "${chain.chainId}". The domain would carry one cluster's ` +
          `Permit2 with another's chain id, which matches no signature the runtime produces.`,
      );
    }
  }
  const permit2 = isTron
    ? `0x${tronBase58ToEvmHex(TRON_PERMIT2[tronCluster as keyof typeof TRON_PERMIT2])}`
    : permit2Evm;
  const chainIdValue = isTron ? tronTip712ChainId(chain.chainId) : evmNumericChainId(chain.chainId);

  // Address MEMBERS of the struct are hex on both chains. Tron carries base58 on-chain but the
  // TIP-712 message is built with the 0x41 prefix stripped, so a base58 literal here would match
  // nothing — the same list feeds the calldata policy below, where base58 IS what appears.
  const addr = (xs: readonly string[]): string =>
    quotedLower(xs.map((x) => (isTron ? toTronEvmHex(x) : assertEvmAddress(x, chain.key))));

  // Asserted here as well as in the approve policy, so the token clause can never be dropped.
  const tokens = extras.allowedTokens[chain.key] ?? [];
  if (tokens.length === 0) {
    throw new Error(
      `Sender extras: chain "${chain.key}" has no allowedTokens, so the typed-data allow would ` +
        `not bind which token the permit moves.`,
    );
  }
  const tokenClause = ` && eth.eip_712.message['permitted']['token'] in [${addr(tokens)}]`;

  // Both roles control funds at settlement. An empty list throws rather than dropping the clause.
  const reservers = extras.reservers?.[chain.key] ?? [];
  const releasers = extras.releasers?.[chain.key] ?? [];
  for (const [role, vals, field] of [
    ['reservers', reservers, 'quote_selector'],
    ['releasers', releasers, 'fulfillment_verifier.account'],
  ] as const) {
    if (vals.length === 0) {
      throw new Error(
        `Sender extras: chain "${chain.key}" has no ${role}. Both witness roles act at settlement, ` +
          `so this policy set binds them. Read it from the gateway's GET ` +
          `/v1/defaults?chain_id=${chain.chainId} (${field}).`,
      );
    }
  }
  const reserverClause = ` && eth.eip_712.message['witness']['reserver'] in [${addr(reservers)}]`;
  const releaserClause = ` && eth.eip_712.message['witness']['releaser'] in [${addr(releasers)}]`;

  // The payee, carried in plaintext in the deposit witness.
  const destinations = extras.allowedDestinations?.[chain.key] ?? [];
  if (destinations.length === 0) {
    throw new Error(
      `Sender extras: chain "${chain.key}" has no allowedDestinations. They bind the payee a ` +
        `deposit may name. Compose each entry with buildEscrowDestination, or remove the chain.`,
    );
  }
  const destinationClause = ` && eth.eip_712.message['witness']['destination'] in [${quotedExact(destinations, chain.key)}]`;

  return {
    policyName: `allowPermit2DepositTypedData (${chain.chainId})`,
    effect: 'EFFECT_ALLOW',
    condition:
      `${EIP712_RAW_PAYLOAD_CONDITION} && ` +
      `eth.eip_712.primary_type == '${PERMIT2_PRIMARY_TYPE}' && ` +
      `eth.eip_712.domain.name == '${PERMIT2_DOMAIN_NAME}' && ` +
      `eth.eip_712.domain.verifying_contract == '${permit2}' && ` +
      `eth.eip_712.domain.chain_id == ${chainIdValue} && ` +
      `eth.eip_712.message['spender'] in [${addr(escrowsRaw)}]` +
      tokenClause +
      reserverClause +
      releaserClause +
      destinationClause,
    notes:
      "The sender's only fund-moving signature: a Permit2 deposit authorization into an " +
      'allowlisted escrow, for an allowlisted token, committing to an allowlisted destination.',
  };
}

/**
 * Convert a Tron base58check address to its EVM-hex form (20 bytes, no 0x prefix, no 0x41
 * network byte). Mirrors the protocol's Tron-to-EVM address normalization so the policy
 * condition compares against the same form the calldata carries.
 *
 * Tron base58check encodes: [0x41 (1B)] || [20B address] || [4B checksum]. The middle 20 bytes
 * are the EVM-equivalent address. We decode inline (no `tronweb` dep) and verify the 4-byte
 * checksum, throwing on a mismatch so a mistyped address cannot silently map to a different one.
 */
export function tronBase58ToEvmHex(b58: string): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let bn = 0n;
  for (const c of b58) {
    const idx = ALPHABET.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base58 character in Tron address: ${c}`);
    bn = bn * 58n + BigInt(idx);
  }
  // Convert bigint -> bytes (big-endian), pad to 25 bytes (1 prefix + 20 addr + 4 checksum).
  const bytes: number[] = [];
  while (bn > 0n) {
    bytes.unshift(Number(bn & 0xffn));
    bn >>= 8n;
  }
  // Handle leading '1' chars in base58 -> leading zero bytes.
  for (const c of b58) {
    if (c === '1') bytes.unshift(0);
    else break;
  }
  while (bytes.length < 25) bytes.unshift(0);
  if (bytes.length !== 25) {
    throw new Error(`Tron address ${b58} decoded to ${bytes.length} bytes; expected 25.`);
  }
  // Verify the trailing 4-byte base58check checksum (double-SHA256 over the 21-byte
  // prefix+address). Without this a mistyped address that still decodes to 25 bytes with a
  // 0x41 prefix would silently yield a different, unintended recipient hex.
  const checksum = createHash('sha256')
    .update(
      createHash('sha256')
        .update(Buffer.from(bytes.slice(0, 21)))
        .digest(),
    )
    .digest()
    .subarray(0, 4);
  if (!checksum.equals(Buffer.from(bytes.slice(21, 25)))) {
    throw new Error(`Tron address ${b58} failed base58check checksum verification.`);
  }
  if (bytes[0] !== 0x41) {
    throw new Error(
      `Tron address ${b58} has prefix byte 0x${bytes[0]!.toString(16)}; expected 0x41.`,
    );
  }
  return bytes
    .slice(1, 21)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The raw-signing denies for a role whose secp256k1 accounts sign typed data only (sender,
 * verifier and settler). Shared so a hardening lands on every such role at once. `role` only fills the notes,
 * which apply-policies does not compare, so the conditions stay byte-identical across roles.
 *
 * KECCAK256 signs a caller-supplied preimage, and `0x1901 || domainSeparator || hashStruct` is one,
 * so allowing it would produce typed-data signatures without evaluating any `eth.eip_712.*`
 * condition. NO_OP signs a caller-chosen digest as-is. No role uses SHA256.
 */
export function typedDataOnlyRawSigningDenies(role: string): PolicyDefinition[] {
  return [
    {
      policyName: 'denyNonTypedDataHashFunctions',
      effect: 'EFFECT_DENY',
      condition:
        `activity.type in ['ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2', 'ACTIVITY_TYPE_SIGN_RAW_PAYLOADS'] && ` +
        `activity.params.hash_function in ['HASH_FUNCTION_NO_OP', 'HASH_FUNCTION_SHA256', 'HASH_FUNCTION_KECCAK256']`,
      notes:
        'NO_OP signs a caller-chosen digest as-is; KECCAK256 signs a caller-chosen preimage, which ' +
        'reproduces any EIP-712 digest and bypasses every typed-data condition.',
    },
    {
      // A 7702 authorization delegates the EOA's execution to a contract, after which no
      // typed-data or eth.tx.* policy applies.
      policyName: 'denyAccountDelegationEncoding',
      effect: 'EFFECT_DENY',
      condition:
        `activity.type in ['ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2', 'ACTIVITY_TYPE_SIGN_RAW_PAYLOADS'] && ` +
        `activity.params.encoding == 'PAYLOAD_ENCODING_EIP7702_AUTHORIZATION'`,
      notes: `One signature would delegate the ${role} EOA to an attacker contract.`,
    },
    {
      // The batch form sets `encoding` once but carries an ARRAY of payloads, and the
      // `eth.eip_712.message[...]` conditions bind only one of them.
      policyName: 'denyBatchRawPayloads',
      effect: 'EFFECT_DENY',
      condition: `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOADS'`,
      notes:
        'Message conditions bind one payload of a batch, so a second could ride along unbound.',
    },
  ];
}
