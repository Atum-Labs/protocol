// Verifier sub-org Turnkey policy emitter.
//
// What the verifier sub-org signs:
//   - secp256k1 accounts (EVM and Tron) sign two things: the escrow's V3 `ReleaseWitness` and
//     `RefundWitness`, each sent as `PAYLOAD_ENCODING_EIP712` so the allow can bind the primary
//     type, the escrow domain and the releaser. Tron's TIP-712 shares the EIP-712 wire format, so
//     one condition shape covers both.
//   - EVM accounts also sign veri-fill's `FulfillmentVerdict` and `DepositVerdict`, EIP-712 under
//     the `Atum Verdict` domain, a name no witness or Permit2 shares so it cannot pass for either.
//   - The Solana account signs a raw ed25519 digest (the release or refund hash) and nothing else.
//   - Nothing on the sub-org signs a transaction. The verifier never broadcasts.
//
// What it does NOT bind:
//   - Release and refund witnesses are field identical under the same domain, so
//     `eth.eip_712.primary_type` is the only thing that separates the two rules.
//   - The deposit a witness names, its amount and its settler are unbound: a stolen credential can
//     still sign a release for any deposit on an allowlisted escrow. The escrow's own checks and
//     the on-chain deposit state are what bound those.
//   - A verdict's payment, outcome and block are unbound: a stolen credential can sign a verdict
//     for any payment on a listed EVM chain. Its consumers check the signer, so it claims no more
//     than the raw key could, and nothing on chain trusts this domain.
//   - The Solana digest is opaque. The policy language exposes no payload field, so a stolen
//     credential can sign any bytes with the Solana key, a serialized transaction message
//     included. Keeping the key in Turnkey stops it being copied out; it does not bound signing.

import { buildAllowStellarRawPayloadPolicy, type PolicyDefinition } from './policies';
import type { ChainEntry } from './sender-policies';
import {
  assertEvmAddress,
  evmNumericChainId,
  toTronEvmHex,
  tronTip712ChainId,
  typedDataOnlyRawSigningDenies,
} from './sender-policies';

/** The escrow's EIP-712 domain for every V3 witness, on EVM and Tron alike. */
export const ESCROW_DOMAIN_NAME = 'Escrow';
export const ESCROW_DOMAIN_VERSION = '3';

/** The two structs the verifier signs, one allow each. */
export const VERIFIER_WITNESSES = ['ReleaseWitness', 'RefundWitness'] as const;

/** veri-fill's EIP-712 verdict domain, which carries no verifyingContract. */
export const VERDICT_DOMAIN_NAME = 'Atum Verdict';
export const VERDICT_DOMAIN_VERSION = '1';

/** The verdicts the verifier signs on EVM chains, one allow each. Tron verdicts are not typed data. */
export const VERIFIER_VERDICTS = ['FulfillmentVerdict', 'DepositVerdict'] as const;

export interface VerifierExtras {
  /**
   * Escrow contracts per chain key, bound as the domain's `verifyingContract`. REQUIRED for every
   * EVM and Tron chain. EVM is 0x hex; Tron may be base58 or the 0x hex the TIP-712 domain carries.
   */
  readonly escrows: Readonly<Record<string, readonly string[]>>;
  /**
   * The verifier's own signing address per chain key, bound as the witness `releaser`. REQUIRED for
   * every EVM and Tron chain. It is the `fulfillment_verifier.account` the gateway publishes.
   */
  readonly releasers: Readonly<Record<string, readonly string[]>>;
  /**
   * The verifier's Solana account address per Solana chain key, base58. REQUIRED when a Solana
   * chain is listed: the ed25519 raw allow is scoped to it, so no other account can use it.
   */
  readonly solanaSigners?: Readonly<Record<string, readonly string[]>>;
  /**
   * The verifier's Stellar account address per Stellar chain key, `G...` strkey. REQUIRED when a
   * Stellar chain is listed: the Stellar raw allow is scoped to it.
   */
  readonly stellarSigners?: Readonly<Record<string, readonly string[]>>;
}

const LABEL = 'Verifier extras';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The all-zero Solana key, used as the example config's placeholder. */
const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** The form an address member takes in the witness: lowercase 0x hex on both EVM and Tron. */
function memberAddress(address: string, chain: ChainEntry): string {
  const hex =
    chain.kind === 'tron'
      ? toTronEvmHex(address, LABEL)
      : assertEvmAddress(address, chain.key, LABEL);
  return hex.toLowerCase();
}

function required(
  map: Readonly<Record<string, readonly string[]>> | undefined,
  field: string,
  chain: ChainEntry,
): string[] {
  const vals = map?.[chain.key] ?? [];
  if (vals.length === 0) {
    throw new Error(
      `${LABEL}: chain "${chain.key}" has no ${field}. Every EVM and Tron chain binds the ` +
        `escrow as verifyingContract and the verifier's own address as releaser.`,
    );
  }
  const out = vals.map((v) => memberAddress(v, chain));
  if (out.includes(ZERO_ADDRESS)) {
    throw new Error(
      `${LABEL}: chain "${chain.key}" lists the zero address in ${field}. It is the ` +
        `example config's placeholder and can never sign, so replace it with the real address.`,
    );
  }
  return out;
}

/** Solana base58 account addresses, refusing placeholders and anything a condition literal cannot hold. */
function solanaSigners(extras: VerifierExtras, chain: ChainEntry): string[] {
  const vals = extras.solanaSigners?.[chain.key] ?? [];
  if (vals.length === 0) {
    throw new Error(
      `${LABEL}: Solana chain "${chain.key}" has no solanaSigners. The ed25519 raw allow is scoped ` +
        `to the verifier's Solana account, so its address is required.`,
    );
  }
  for (const v of vals) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) || v === SOLANA_SYSTEM_PROGRAM) {
      throw new Error(
        `${LABEL}: ${JSON.stringify(v)} on chain "${chain.key}" is not a usable Solana account address.`,
      );
    }
  }
  return [...vals];
}

/**
 * Emit Turnkey policy definitions for a verifier sub-org. Pure function; no Turnkey calls.
 */
export function buildVerifierPolicies(
  extras: VerifierExtras,
  chains: readonly ChainEntry[],
): PolicyDefinition[] {
  const policies: PolicyDefinition[] = [];

  for (const chain of chains) {
    if (chain.kind !== 'evm' && chain.kind !== 'tron') continue;
    const escrows = required(extras.escrows, 'escrows', chain);
    const releasers = required(extras.releasers, 'releasers', chain);
    const chainIdValue =
      chain.kind === 'tron'
        ? tronTip712ChainId(chain.chainId, LABEL)
        : evmNumericChainId(chain.chainId, LABEL);
    const quoted = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

    for (const primaryType of VERIFIER_WITNESSES) {
      policies.push({
        policyName: `allow${primaryType} (${chain.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition:
          `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && ` +
          `activity.params.encoding == 'PAYLOAD_ENCODING_EIP712' && ` +
          `activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE' && ` +
          `eth.eip_712.primary_type == '${primaryType}' && ` +
          `eth.eip_712.domain.name == '${ESCROW_DOMAIN_NAME}' && ` +
          `eth.eip_712.domain.version == '${ESCROW_DOMAIN_VERSION}' && ` +
          `eth.eip_712.domain.chain_id == ${chainIdValue} && ` +
          `eth.eip_712.domain.verifying_contract in [${quoted(escrows)}] && ` +
          `eth.eip_712.message['releaser'] in [${quoted(releasers)}]`,
        notes:
          `An escrow ${primaryType} on an allowlisted escrow naming the verifier as releaser. ` +
          'Release and refund are field identical, so primary_type is what separates them.',
      });
    }

    if (chain.kind !== 'evm') continue;
    for (const primaryType of VERIFIER_VERDICTS) {
      policies.push({
        policyName: `allow${primaryType} (${chain.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition:
          `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && ` +
          `activity.params.encoding == 'PAYLOAD_ENCODING_EIP712' && ` +
          `activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE' && ` +
          `eth.eip_712.primary_type == '${primaryType}' && ` +
          `eth.eip_712.domain.name == '${VERDICT_DOMAIN_NAME}' && ` +
          `eth.eip_712.domain.version == '${VERDICT_DOMAIN_VERSION}' && ` +
          `eth.eip_712.domain.chain_id == ${chainIdValue}`,
        notes: `veri-fill's ${primaryType} for this chain, under the Atum Verdict domain.`,
      });
    }
  }

  // The Solana release and refund signatures are raw ed25519 over a 32-byte digest, which the
  // backend always sends as HEXADECIMAL. The allow names the verifier's Solana account, so it
  // cannot reach the EVM or Tron keys whatever Turnkey accepts for them.
  const solanaChains = chains.filter((c) => c.kind === 'solana');
  if (solanaChains.length > 0) {
    const signers = [...new Set(solanaChains.flatMap((c) => solanaSigners(extras, c)))];
    policies.push({
      policyName: 'allowEd25519RawPayload',
      effect: 'EFFECT_ALLOW',
      condition:
        `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && ` +
        `activity.params.encoding == 'PAYLOAD_ENCODING_HEXADECIMAL' && ` +
        `activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE' && ` +
        `wallet_account.address in [${signers.map((a) => `'${a}'`).join(', ')}]`,
      notes:
        'Solana release and refund signatures (ed25519 over the escrow hash), from the verifier Solana account only.',
    });
  }

  // The Stellar release and refund signatures are raw ed25519 over the witness digest, sent as
  // HEXADECIMAL like Solana's. Unlike Solana there is no unscoped fallback: the allow names the
  // verifier's Stellar account(s). Turnkey cannot parse Stellar transactions, so this binds the
  // account and encoding only, and `denySignTransaction` below is what keeps a transaction off it.
  const stellarChains = chains.filter((c) => c.kind === 'stellar');
  if (stellarChains.length > 0) {
    for (const c of stellarChains) {
      if ((extras.stellarSigners?.[c.key] ?? []).length === 0) {
        throw new Error(
          `${LABEL}: Stellar chain "${c.key}" has no stellarSigners. The Stellar raw allow is ` +
            `scoped to the verifier's Stellar account, so its address is required.`,
        );
      }
    }
    policies.push(
      buildAllowStellarRawPayloadPolicy({
        role: LABEL,
        signers: stellarChains.flatMap((c) => extras.stellarSigners?.[c.key] ?? []),
        encodings: ['PAYLOAD_ENCODING_HEXADECIMAL'],
      }),
    );
  }

  // Denies are evaluated ahead of allows, so these hold even if an allow above is widened.
  policies.push(...typedDataOnlyRawSigningDenies('verifier'));
  // Every user may manage its own credentials unless a policy says otherwise, so without this a
  // stolen verifier credential could add its own API key and survive revocation. Root bypasses it.
  policies.push({
    policyName: 'denyCredentialChanges',
    effect: 'EFFECT_DENY',
    condition: `activity.resource == 'CREDENTIAL'`,
    notes: 'The verifier user cannot create or delete credentials. Rotation runs as root.',
  });
  policies.push({
    policyName: 'denySignTransaction',
    effect: 'EFFECT_DENY',
    condition: `activity.type in ['ACTIVITY_TYPE_SIGN_TRANSACTION', 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2']`,
    notes:
      'The verifier signs witnesses only and never broadcasts, so no transaction is signed here.',
  });

  return policies;
}
