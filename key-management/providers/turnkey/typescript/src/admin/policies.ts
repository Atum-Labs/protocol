// Turnkey-side policy authoring. Mirrors the same `SigningPolicy` source the client-side
// `PolicyCheckedSigner` consumes — denied client-side = denied server-side, and vice versa.
//
// CPI caveat: Turnkey only inspects top-level tx instructions. Transfers happening via CPI
// from inside Anchor programs aren't visible in `solana.tx.spl_transfers` / `instructions`,
// so policies that target SPL transfer fields only fire on top-level transfer instructions.
// This is fine for the settlement flow (fulfill goes through FulfillmentProxy, no top-level
// SPL transfer), but operators emitting top-level SPL transfers should know.

import type { SigningPolicy } from '@atum-labs/km-core';

import type { TurnkeyClient } from '../client';
import { isStellarAccountId } from './stellar-address';

export interface PolicyDefinition {
  readonly policyName: string;
  readonly effect: 'EFFECT_ALLOW' | 'EFFECT_DENY';
  /** Turnkey policy DSL condition string. Single-quoted string literals. */
  readonly condition: string;
  /** Optional consensus (e.g., `approvers.any(u, u.id == '<uuid>')`). Omitted = unscoped. */
  readonly consensus?: string;
  /** Human-readable note shown in the Turnkey console. */
  readonly notes?: string;
}

/**
 * Per-contract selector binding, Turnkey side only. Keys are `allowedTo` entries, values the 4-byte
 * selectors that address may be called with, or `'any'`. Once set, every `allowedTo` entry needs a
 * key, so no allowlisted contract is reachable with an arbitrary selector by omission.
 */
export type AllowedSelectorsByTo = Readonly<Record<string, readonly string[] | 'any'>>;

/** `SigningPolicy` plus the Turnkey-only fields `derivePoliciesFromAllowlist` reads. */
export type TurnkeyAllowlistPolicy = SigningPolicy & {
  readonly allowedSelectorsByTo?: AllowedSelectorsByTo;
};

/**
 * ERC-20/TRC-20 calls that grant a spender an allowance with the spender as argument 1: approve,
 * increaseAllowance, increaseApproval (pre-2018 OpenZeppelin) and approveAndCall (ERC-677/1363).
 */
export const ALLOWANCE_GRANT_SELECTORS = ['0x095ea7b3', '0x39509351', '0xd73dd623', '0xcae9ca51'] as const;

interface AllowedCall {
  /** In the form the condition compares: EVM lowercase hex, Tron base58 as configured. */
  readonly to: string;
  /** EVM `0x` + lowercase hex, Tron lowercase hex without `0x`; or `'any'`. */
  readonly selectors: readonly string[] | 'any';
}

/**
 * Validate `allowedSelectorsByTo` against `allowedTo` and normalise both, or return undefined when
 * the map is unset. Throws on anything that would silently widen the ALLOW or emit a selector form
 * Turnkey never matches.
 */
function resolveAllowedCalls(
  policy: TurnkeyAllowlistPolicy,
  chain: 'evm' | 'tron',
): AllowedCall[] | undefined {
  const map: unknown = policy.allowedSelectorsByTo;
  if (map === undefined) return undefined;
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('allowedSelectorsByTo must be a map from allowedTo address to selector list.');
  }
  if (!Array.isArray(policy.allowedTo) || policy.allowedTo.length === 0) {
    throw new Error('allowedSelectorsByTo needs a non-empty allowedTo list to bind.');
  }
  // A separate allowedSelectors ALLOW would admit its selectors on any address, reopening the gap.
  if (Array.isArray(policy.allowedSelectors)) {
    throw new Error('Set either allowedSelectors or allowedSelectorsByTo on a chain, not both.');
  }
  const addr = (a: string) => (chain === 'evm' ? a.toLowerCase() : a);
  const byTo = new Map<string, readonly string[] | 'any'>();
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    const to = addr(key);
    if (byTo.has(to)) throw new Error(`allowedSelectorsByTo lists ${to} more than once.`);
    byTo.set(to, normaliseSelectors(key, value, chain));
  }
  const listed = new Set(policy.allowedTo.map(addr));
  for (const to of byTo.keys()) {
    if (!listed.has(to)) {
      throw new Error(
        `allowedSelectorsByTo key ${to} is not in allowedTo. Quote addresses in YAML, or an ` +
          `unquoted 0x key is read as a number.`,
      );
    }
  }
  return policy.allowedTo.map((a) => {
    const to = addr(a);
    const selectors = byTo.get(to);
    if (selectors === undefined) {
      throw new Error(
        `allowedTo entry ${a} has no allowedSelectorsByTo entry. List its selectors, or 'any' to ` +
          `allow every selector on it.`,
      );
    }
    return { to, selectors };
  });
}

function normaliseSelectors(
  to: string,
  value: unknown,
  chain: 'evm' | 'tron',
): readonly string[] | 'any' {
  if (value === 'any') return 'any';
  if (Array.isArray(value) && value.length === 0) {
    throw new Error(
      `allowedSelectorsByTo.${to} is empty, which allows nothing. Remove the address from allowedTo instead.`,
    );
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `allowedSelectorsByTo.${to} must be a non-empty list of selectors or 'any'; got ${JSON.stringify(value)}.`,
    );
  }
  for (const s of value) {
    if (typeof s !== 'string' || !/^0x[0-9a-f]{8}$/i.test(s)) {
      throw new Error(
        `allowedSelectorsByTo.${to}: ${JSON.stringify(s)} is not a quoted 0x-prefixed 4-byte selector.`,
      );
    }
  }
  const norm = (value as string[]).map((s) =>
    chain === 'evm' ? s.toLowerCase() : s.slice(2).toLowerCase(),
  );
  return [...new Set(norm)];
}

/** One `allowedTo` clause: the address alone, or the address AND one of its selectors. */
function allowedCallClause(call: AllowedCall, chain: 'evm' | 'tron'): string {
  const target = chain === 'evm' ? `eth.tx.to == '${call.to}'` : `c.contract_address == '${call.to}'`;
  if (call.selectors === 'any') return target;
  // Raw calldata slices, not `function_signature`, which Turnkey documents as needing an uploaded ABI.
  // `==` ORed rather than `in`, the form proven live (sender allowApproveToPermit2).
  const field = chain === 'evm' ? 'eth.tx.data[0..10]' : 'c.data[0..8]';
  return `(${target} && (${call.selectors.map((s) => `${field} == '${s}'`).join(' || ')}))`;
}

/**
 * Whether the set `derivePoliciesFromAllowlist` emits for this allowlist admits a call to `to` with
 * `selector` (undefined = empty calldata). Covers the allowedTo and allowedSelectors ALLOWs only.
 * Live probes use it to pick controls the policy set is meant to allow.
 */
export function selectorAllowedFor(
  policy: TurnkeyAllowlistPolicy,
  chain: 'evm' | 'tron',
  to: string,
  selector: string | undefined,
): boolean {
  const target = chain === 'evm' ? to.toLowerCase() : to;
  const sel =
    selector === undefined
      ? undefined
      : chain === 'evm'
        ? selector.toLowerCase()
        : selector.replace(/^0x/i, '').toLowerCase();
  const calls = resolveAllowedCalls(policy, chain);
  if (calls) {
    return calls.some(
      (c) =>
        c.to === target &&
        (c.selectors === 'any' || (sel !== undefined && c.selectors.includes(sel))),
    );
  }
  const toListed =
    Array.isArray(policy.allowedTo) &&
    policy.allowedTo.some((a) => (chain === 'evm' ? a.toLowerCase() : a) === target);
  const selListed =
    sel !== undefined &&
    Array.isArray(policy.allowedSelectors) &&
    policy.allowedSelectors.some(
      (s) => (chain === 'evm' ? s.toLowerCase() : s.replace(/^0x/i, '').toLowerCase()) === sel,
    );
  return toListed || selListed;
}

/**
 * Translate a `SigningPolicy` into Turnkey policy definitions for one chain.
 * Per chain, emits narrow ALLOWs for the allowlist + targeted DENYs for known attacks.
 */
export function derivePoliciesFromAllowlist(
  policy: TurnkeyAllowlistPolicy,
  chain: 'evm' | 'tron' | 'solana' | 'stellar',
  context: { chainId: string; selfAddress?: string },
): PolicyDefinition[] {
  const policies: PolicyDefinition[] = [];

  // Universal-oracle defense on secp256k1: deny `sign_raw_payload(s)` with `HASH_FUNCTION_NO_OP`.
  // NO_OP signs an arbitrary 32-byte digest as-is, so any caller who can present such a digest
  // (e.g., a transaction hash) gets a usable signature.
  if (chain === 'evm' || chain === 'tron') {
    policies.push({
      policyName: `denyNoOpHash (${context.chainId})`,
      effect: 'EFFECT_DENY',
      condition:
        "activity.type in ['ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2', 'ACTIVITY_TYPE_SIGN_RAW_PAYLOADS'] && activity.params.hash_function == 'HASH_FUNCTION_NO_OP'",
      notes: 'Blocks universal-oracle signing on secp256k1.',
    });
  }

  if (chain === 'evm') {
    const calls = resolveAllowedCalls(policy, 'evm');
    if (calls) {
      policies.push({
        policyName: `allowedTo (${context.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == ${chainIdFromCaip2Evm(context.chainId)} && (${calls.map((c) => allowedCallClause(c, 'evm')).join(' || ')})`,
        notes: 'Mirrors SigningPolicy.allowedTo for this chain, each contract bound to its allowedSelectorsByTo selectors.',
      });
    } else if (Array.isArray(policy.allowedTo) && policy.allowedTo.length > 0) {
      const list = policy.allowedTo.map((a) => `eth.tx.to == '${a.toLowerCase()}'`).join(' || ');
      policies.push({
        policyName: `allowedTo (${context.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == ${chainIdFromCaip2Evm(context.chainId)} && (${list})`,
        notes: 'Mirrors SigningPolicy.allowedTo for this chain.',
      });
    }
    // Allow the cancel/RBF nonce-burn: a 0-value, calldata-free self-send to the agent's own EOA
    // (mirrors the runtime PolicyCheckedSigner carve-out). `gas == 21000` is the load-bearing
    // no-calldata guarantee — any calldata or EIP-7702 authorization raises the intrinsic-gas
    // floor above 21000, so this shape can only ever be a bare nonce-consuming self-transfer.
    if (context.selfAddress) {
      policies.push({
        policyName: `allowSelfSendNonceBurn (${context.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == ${chainIdFromCaip2Evm(context.chainId)} && eth.tx.type == 'TYPE_2' && eth.tx.to == '${context.selfAddress.toLowerCase()}' && eth.tx.value == 0 && eth.tx.gas == 21000`,
        notes:
          'Allows the 0-value, calldata-free self-send the agent signs to burn a stuck nonce ' +
          '(cancel / replace-by-fee). to==self, value==0 and gas==21000 mean it cannot move ' +
          'funds, call a contract, or carry an EIP-7702 authorization.',
      });
    }
    if (Array.isArray(policy.allowedSelectors) && policy.allowedSelectors.length > 0) {
      const list = policy.allowedSelectors
        .map((s) => `eth.tx.function_signature == '${s.toLowerCase()}'`)
        .join(' || ');
      policies.push({
        policyName: `allowedSelectors (${context.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == ${chainIdFromCaip2Evm(context.chainId)} && (${list})`,
        notes: 'Mirrors SigningPolicy.allowedSelectors for this chain.',
      });
    }
    if (policy.maxNativeValue != null) {
      policies.push({
        policyName: `maxNativeValue (${context.chainId})`,
        effect: 'EFFECT_DENY',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == ${chainIdFromCaip2Evm(context.chainId)} && eth.tx.value > ${policy.maxNativeValue}`,
        notes: 'Caps native wei. Schema default "0" denies any non-zero native value.',
      });
    }
    // Caps `gas` and the per-gas fee on allowlisted contract calls, so no signature can spend
    // native balance on runaway fees.
    if (policy.maxGasLimit != null) {
      policies.push({
        policyName: `maxGasLimit (${context.chainId})`,
        effect: 'EFFECT_DENY',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == ${chainIdFromCaip2Evm(context.chainId)} && eth.tx.gas > ${policy.maxGasLimit}`,
        notes: 'Caps eth.tx.gas.',
      });
    }
    if (policy.maxFeePerGasWei != null) {
      // Covers both EIP-1559 (max_fee_per_gas) and legacy (gas_price).
      policies.push({
        policyName: `maxFeePerGasWei (${context.chainId})`,
        effect: 'EFFECT_DENY',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == ${chainIdFromCaip2Evm(context.chainId)} && (eth.tx.max_fee_per_gas > ${policy.maxFeePerGasWei} || eth.tx.gas_price > ${policy.maxFeePerGasWei})`,
        notes: 'Caps per-gas fee on EIP-1559 and legacy tx types.',
      });
    }
  }

  if (chain === 'tron') {
    // Tron protobuf allows multi-contract txs. We iterate every contract in the tx
    // (`contract.all` / `contract.any`) rather than only checking `contract[0]`.
    const calls = resolveAllowedCalls(policy, 'tron');
    if (calls) {
      policies.push({
        policyName: `allowedTo (${context.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && tron.tx.contract.all(c, ${calls.map((c) => allowedCallClause(c, 'tron')).join(' || ')})`,
        notes: 'Tron allowedTo — every contract in the tx must be allowlisted and called with one of its allowedSelectorsByTo selectors.',
      });
    } else if (Array.isArray(policy.allowedTo) && policy.allowedTo.length > 0) {
      const list = policy.allowedTo.map((a) => `'${a}'`).join(', ');
      policies.push({
        policyName: `allowedTo (${context.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && tron.tx.contract.all(c, c.contract_address in [${list}])`,
        notes: 'Tron allowedTo — every contract in the tx must be in the allowlist.',
      });
    }
    if (Array.isArray(policy.allowedSelectors) && policy.allowedSelectors.length > 0) {
      const list = policy.allowedSelectors
        .map((s) => `'${s.replace(/^0x/, '').toLowerCase()}'`)
        .join(', ');
      policies.push({
        policyName: `allowedSelectors (${context.chainId})`,
        effect: 'EFFECT_ALLOW',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && tron.tx.contract.all(c, c.data[0..8] in [${list}])`,
        notes: 'Tron allowedSelectors — every contract call uses an allowlisted selector.',
      });
    }
    if (policy.maxNativeValue != null) {
      policies.push({
        policyName: `maxNativeValue (${context.chainId})`,
        effect: 'EFFECT_DENY',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && tron.tx.contract.any(c, c.amount > ${policy.maxNativeValue})`,
        notes:
          'Caps TRX native amount in SUN across all contracts. Default "0" denies any non-zero.',
      });
    }
    if (policy.maxFeeLimitSun != null) {
      policies.push({
        policyName: `maxFeeLimitSun (${context.chainId})`,
        effect: 'EFFECT_DENY',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && tron.tx.fee_limit > ${policy.maxFeeLimitSun}`,
        notes: 'Caps tron.tx.fee_limit (SUN) — bandwidth/energy DoS defense.',
      });
    }
  }

  if (chain === 'solana') {
    if (policy.allowedSelectorsByTo !== undefined) {
      throw new Error(
        `Solana chain "${context.chainId}": allowedSelectorsByTo is EVM and Tron only. Bind ` +
          `program instructions with allowedAnchorDiscriminators.`,
      );
    }
    if (Array.isArray(policy.allowedPrograms) && policy.allowedPrograms.length > 0) {
      const list = policy.allowedPrograms.map((p) => `'${p}'`).join(', ');
      policies.push({
        policyName: `allowedPrograms (${context.chainId})`,
        effect: 'EFFECT_ALLOW',
        // Iterate instructions, NOT `solana.tx.program_keys`. The latter includes every
        // account in a readonly-program slot (PDAs, mints, sysvars), not only invoked
        // programs — and would fail any non-trivial Anchor call.
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && solana.tx.instructions.all(i, i.program_key in [${list}])`,
        notes: 'Solana allowedPrograms — every invoked program must be in the allowlist.',
      });
    }
    if (policy.maxNativeValue != null) {
      policies.push({
        policyName: `maxNativeValue (${context.chainId})`,
        effect: 'EFFECT_DENY',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && solana.tx.transfers.any(t, t.amount > ${policy.maxNativeValue})`,
        notes:
          'Caps SOL transfers in lamports. Plugin overrides default to 10,000,000 (0.01 SOL) for ATA-rent headroom.',
      });
    }
    // Per-program Anchor discriminator allowlist. Blocks calls to admin methods (`set_pauser`
    // etc.) on our own programs from a compromised process that bypasses client-side checks.
    if (
      policy.allowedAnchorDiscriminators &&
      typeof policy.allowedAnchorDiscriminators === 'object'
    ) {
      for (const [programId, discs] of Object.entries(policy.allowedAnchorDiscriminators)) {
        if (discs === 'any') continue;
        if (!Array.isArray(discs) || discs.length === 0) continue;
        const list = discs.map((d) => `'${d.toLowerCase()}'`).join(', ');
        policies.push({
          policyName: `allowedAnchorDiscriminators (${context.chainId} / ${programId.slice(0, 8)}…)`,
          effect: 'EFFECT_DENY',
          // Guard parsed_instruction_data with == null first: Turnkey treats field-access errors
          // as "not deny", so an instruction Turnkey can't parse (non-Anchor, malformed, future
          // program variant) would silently slip past the deny. Treat unparseable instructions
          // on a guarded program as deny — if the operator allowlists discriminators on this
          // program, every instruction to it must be parseable AND in the allowlist.
          condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && solana.tx.instructions.any(i, i.program_key == '${programId}' && (i.parsed_instruction_data == null || !(i.parsed_instruction_data.discriminator in [${list}])))`,
          notes: `Denies instructions on ${programId} whose Anchor discriminator isn't allowlisted (or that Turnkey can't parse).`,
        });
      }
    }
  }

  if (chain === 'stellar') {
    // Turnkey documents no Stellar transaction parsing: its policy language has no `stellar.tx`
    // namespace (docs.turnkey.com policy language, checked 2026-11-10), and a raw payload signature
    // exposes only the activity type, encoding, hash function and wallet account. So nothing in a
    // SigningPolicy can be enforced server-side for Stellar. Refuse such a field rather than emit
    // nothing and let an operator believe `allowedTo` is a server-side fence: the settler's
    // client-side PolicyCheckedSigner is the only thing that enforces it. The raw-signing allow
    // itself is emitted by buildAllowStellarRawPayloadPolicy, which is not derived from the allowlist.
    const unenforceable = (
      [
        'allowedTo',
        'allowedSelectors',
        'allowedSelectorsByTo',
        'allowedPrograms',
        'allowedAnchorDiscriminators',
      ] as const
    ).filter((k) => policy[k] !== undefined);
    if (unenforceable.length > 0) {
      throw new Error(
        `Stellar chain "${context.chainId}": ${unenforceable.join(', ')} cannot be enforced by ` +
          `Turnkey, which cannot parse Stellar transactions. Remove ${unenforceable.length === 1 ? 'it' : 'them'} ` +
          `from the allowlists entry; the settler's own signing policy enforces them client-side.`,
      );
    }
  }

  return policies;
}

/** Typed-data prefix shared by every EIP-712 allow: the singular activity, EIP712 encoding. */
export const EIP712_RAW_PAYLOAD_CONDITION =
  `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && ` +
  `activity.params.encoding == 'PAYLOAD_ENCODING_EIP712' && ` +
  `activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE'`;

/**
 * Settler identity EIP-712 domain sentinel (lowercase): the last 20 bytes of
 * keccak256("atum.settler.identity.v1"). No code exists there. The domain carries no chainId.
 */
export const SETTLER_IDENTITY_VERIFYING_CONTRACT = '0x1238944d14f50709cc27101b2746fdefce08b37e';

/**
 * Allow ed25519 raw signing (Solana): HEXADECIMAL or TEXT_UTF8 with NOT_APPLICABLE. Turnkey rejects
 * that pairing on secp256k1 at the API, so it is not a secp256k1 digest-signing path.
 */
export function buildAllowSignRawPayloadPolicy(): PolicyDefinition {
  return {
    policyName: 'allowEd25519RawPayload',
    effect: 'EFFECT_ALLOW',
    condition:
      `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && ` +
      `activity.params.encoding in ['PAYLOAD_ENCODING_HEXADECIMAL', 'PAYLOAD_ENCODING_TEXT_UTF8'] && ` +
      `activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE'`,
    notes:
      'Solana ed25519 raw signing. Legal on secp256k1 only with EIP712, which the API ' +
      'enforces, so this stays an ed25519-only path.',
  };
}

/**
 * Allow ed25519 raw signing for specific Stellar accounts. Turnkey documents the Stellar account
 * format (`ADDRESS_FORMAT_XLM`, `CURVE_ED25519`) but no Stellar transaction parsing, so a Stellar
 * transaction hash is signed as an opaque raw payload (`HASH_FUNCTION_NOT_APPLICABLE`) and this
 * allow can bind only the encoding, the hash function and the account.
 *
 * That is weaker than every EVM and Solana allow: a credential that can sign through this policy
 * can sign ANY Stellar transaction for the listed accounts. The account list is therefore
 * required and validated (a `G...` strkey with a valid checksum), and the key must hold only what
 * the role needs. `wallet_account.address` scoping is the form the verifier's Solana allow
 * already uses; whether it matches a Stellar account is probed by `turnkey:test-policies`.
 *
 * An unscoped `allowEd25519RawPayload` in the same sub-org (the Solana allow) would also cover
 * these accounts, so a sub-org that must fence Stellar tightly should not carry one.
 */
export function buildAllowStellarRawPayloadPolicy(args: {
  readonly signers: readonly string[];
  /** HEXADECIMAL for binary digests; add TEXT_UTF8 where the role signs the gateway handshake. */
  readonly encodings: readonly ('PAYLOAD_ENCODING_HEXADECIMAL' | 'PAYLOAD_ENCODING_TEXT_UTF8')[];
  readonly role: string;
}): PolicyDefinition {
  if (args.signers.length === 0) {
    throw new Error(`${args.role}: a Stellar chain needs its signing account(s) in stellarSigners.`);
  }
  for (const a of args.signers) {
    if (!isStellarAccountId(a)) {
      throw new Error(
        `${args.role}: ${JSON.stringify(a)} is not a usable Stellar account id ` +
          `(a G... strkey with a valid checksum, and not the all-zero placeholder).`,
      );
    }
  }
  const signers = [...new Set(args.signers)].sort();
  const encodings = [...new Set(args.encodings)].sort();
  const encCond =
    encodings.length === 1
      ? `activity.params.encoding == '${encodings[0]}'`
      : `activity.params.encoding in [${encodings.map((e) => `'${e}'`).join(', ')}]`;
  return {
    policyName: 'allowStellarEd25519RawPayload',
    effect: 'EFFECT_ALLOW',
    condition:
      `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && ` +
      `${encCond} && ` +
      `activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE' && ` +
      `wallet_account.address in [${signers.map((a) => `'${a}'`).join(', ')}]`,
    notes:
      `${args.role}: Stellar ed25519 raw signing (transaction hashes and messages) from the listed ` +
      `account(s) only. Turnkey cannot parse Stellar transactions, so the payload is not bound.`,
  };
}

/**
 * Allow EIP-712 typed data under the settler identity domain: the SettlerProof (W3C proofs) and
 * WalletProof (gateway handshake) structs. Bound by the sentinel verifying contract, which no
 * token or protocol contract can have, so no fund-moving authorization matches it.
 */
export function buildAllowSettlerIdentityTypedDataPolicy(): PolicyDefinition {
  return {
    policyName: 'allowSettlerIdentityTypedData',
    effect: 'EFFECT_ALLOW',
    condition:
      `${EIP712_RAW_PAYLOAD_CONDITION} && ` +
      `eth.eip_712.domain.verifying_contract == '${SETTLER_IDENTITY_VERIFYING_CONTRACT}'`,
    notes:
      'Settler W3C proofs and gateway wallet proofs, signed as EIP-712 under the chainless ' +
      '"Atum Settler Identity" domain whose verifying contract is a codeless sentinel.',
  };
}

/**
 * Deny the ERC-20 allowance grants in `ALLOWANCE_GRANT_SELECTORS` (approve, increaseAllowance,
 * increaseApproval, approveAndCall) to any spender outside the allowlist. Closes the USDC-drain vector where a leaked Turnkey credential
 * could grant `attacker` an allowance and the attacker would then `transferFrom` the agent's
 * inventory out-of-band — bypassing the recipient-allowlist policies which only fire on
 * `transfer` / `transferFrom`. Each takes the spender as argument 1, so it sits at the same
 * calldata offset.
 *
 * The agent's `ensureTokenApprovals()` legitimately calls `approve(fulfillmentProxy, MAX)` once
 * per (chain, token, trusted fulfillment proxy) at boot, so every proxy the agent trusts must be in
 * the allowlist. The escrow is not a spender.
 *
 * Address inputs must be lowercase 40-char hex WITHOUT the `0x` prefix.
 */
export function buildDenyApproveToNonAllowedSpenderEvm(args: {
  readonly chainId: string; // e.g. 'eip155:11155111'
  readonly tokenContractsHex: readonly string[]; // 40-char lowercase hex, no 0x prefix
  readonly allowedSpendersHex: readonly string[]; // same shape
}): PolicyDefinition {
  if (args.tokenContractsHex.length === 0 || args.allowedSpendersHex.length === 0) {
    throw new Error(
      'buildDenyApproveToNonAllowedSpenderEvm: tokens and spenders must be non-empty',
    );
  }
  const numericChainId = args.chainId.split(':')[1] ?? args.chainId;
  const tokens = args.tokenContractsHex.map((t) => `'0x${t}'`).join(', ');
  const spenders = args.allowedSpendersHex.map((s) => `'${s}'`).join(', ');
  return {
    policyName: `denyApproveToNonAllowedSpender (${args.chainId})`,
    effect: 'EFFECT_DENY',
    condition:
      `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
      `eth.tx.chain_id == ${numericChainId} && ` +
      // Raw slice: a selector the token's ABI lacks may leave function_signature unset, and a DENY
      // that errors does not deny.
      `(${ALLOWANCE_GRANT_SELECTORS.map((s) => `eth.tx.data[0..10] == '${s}'`).join(' || ')}) && ` +
      `eth.tx.to in [${tokens}] && ` +
      `!(eth.tx.data[34..74] in [${spenders}])`,
    notes:
      'Denies ERC-20 approve(), increaseAllowance(), increaseApproval() and approveAndCall() on ' +
      'allowlisted token contracts when the spender argument ' +
      "(data[34..74]) isn't in the allowlist. Closes the approve-then-drain attack.",
  };
}

/**
 * Tron sibling of `buildDenyApproveToNonAllowedSpenderEvm`. Token contracts are passed in their
 * native Tron base58 form (matching `c.contract_address`); spender hex is the 40-char EVM-style
 * form (Tron strips the `0x41` network byte from ABI-encoded addresses in calldata).
 */
export function buildDenyApproveToNonAllowedSpenderTron(args: {
  readonly chainId: string; // e.g. 'tron:shasta'
  readonly tokenContractsBase58: readonly string[];
  readonly allowedSpendersHex: readonly string[];
}): PolicyDefinition {
  if (args.tokenContractsBase58.length === 0 || args.allowedSpendersHex.length === 0) {
    throw new Error(
      'buildDenyApproveToNonAllowedSpenderTron: tokens and spenders must be non-empty',
    );
  }
  const tokens = args.tokenContractsBase58.map((t) => `'${t}'`).join(', ');
  const spenders = args.allowedSpendersHex.map((s) => `'${s}'`).join(', ');
  return {
    policyName: `denyApproveToNonAllowedSpender (${args.chainId})`,
    effect: 'EFFECT_DENY',
    condition:
      `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
      `tron.tx.contract.any(c, c.type == 'TriggerSmartContract' && ` +
      `c.contract_address in [${tokens}] && ` +
      `(${ALLOWANCE_GRANT_SELECTORS.map((s) => `c.data[0..8] == '${s.slice(2)}'`).join(' || ')}) && ` +
      `!(c.data[32..72] in [${spenders}]))`,
    notes:
      'Denies TRC-20 approve(), increaseAllowance(), increaseApproval() and approveAndCall() on ' +
      'allowlisted token contracts when the spender argument ' +
      "(c.data[32..72]) isn't in the allowlist. Multi-contract resilient via .any().",
  };
}

/** Subset of Turnkey's `list_policies` response we read. Includes condition/effect/consensus
 * so callers can detect content drift on re-runs. */
export interface TurnkeyPolicySummary {
  readonly policyId: string;
  readonly policyName: string;
  readonly effect: 'EFFECT_ALLOW' | 'EFFECT_DENY';
  readonly condition: string;
  readonly consensus?: string;
  readonly notes?: string;
}

/**
 * List policies on a sub-org. `organizationId` is required because Turnkey's query endpoint
 * needs it in the body — the client doesn't auto-inject it for query endpoints.
 */
export async function listPolicies(
  client: TurnkeyClient,
  organizationId: string,
): Promise<TurnkeyPolicySummary[]> {
  const r = await client.query<{ policies: TurnkeyPolicySummary[] }>(
    '/public/v1/query/list_policies',
    { organizationId },
  );
  return r.policies ?? [];
}

/** Delete a policy by ID. Caller verifies the ID is on the right sub-org. */
export async function deletePolicy(client: TurnkeyClient, policyId: string): Promise<void> {
  await client.executeActivity<unknown>('ACTIVITY_TYPE_DELETE_POLICY', 'delete_policy', {
    policyId,
  });
}

/**
 * What an apply would change, decided without contacting Turnkey beyond the read that produced
 * `existing`. Split out so `applyPolicies` can refuse before it writes anything, and so a dry run
 * can show the same answer without being a write.
 */
export interface PolicyPlan {
  /** Live policies whose name matches but whose content differs. Needs `update`. */
  readonly drifted: ReadonlyArray<{ name: string; diff: string }>;
  /** Live policies absent from the emitted set. Needs `prune`. */
  readonly stale: readonly TurnkeyPolicySummary[];
  /**
   * `<name> [replacing]` copies an interrupted replacement left, for an emitted policy `<name>`.
   * Not stale: apply deletes them itself once the real copy is live, with no flag needed.
   */
  readonly leftovers: readonly TurnkeyPolicySummary[];
  /**
   * Names held by more than one live policy. Turnkey refuses to create a second policy under a
   * name, so this only guards against a live set that holds one anyway. Reconciliation keys
   * everything by name, so a duplicate would be compared against only one of its copies.
   */
  readonly duplicateNames: readonly string[];
  /** Most policies live at once while the apply runs: creates first count, and each replacement
   * holds its temporary copy beside the old one. Stale policies go last, so they never lower it. */
  readonly peakCount: number;
}

/** Turnkey refuses `create_policy` past this many per org: "Exceeded maximum number of policies: 100". */
export const TURNKEY_MAX_POLICIES = 100;

/**
 * Compare the emitted set against what is live, in both directions.
 *
 * The second direction is the one that is easy to omit: walking only the emitted set leaves a
 * renamed or retired policy live and unmentioned, and a policy set is only as tight as its widest
 * ALLOW, so a retired broad allow silently readmits everything its replacement was written to
 * exclude. Pure, so it is safe to call from a dry run.
 */
export function planPolicyChanges(
  existing: readonly TurnkeyPolicySummary[],
  policies: readonly PolicyDefinition[],
): PolicyPlan {
  const existingByName = new Map(existing.map((p) => [p.policyName, p]));
  const drifted: Array<{ name: string; diff: string }> = [];
  for (const p of policies) {
    const prev = existingByName.get(p.policyName);
    if (!prev) continue;
    const matches =
      prev.effect === p.effect &&
      prev.condition === p.condition &&
      (prev.consensus ?? '') === (p.consensus ?? '');
    if (!matches) drifted.push({ name: p.policyName, diff: formatPolicyDiff(prev, p) });
  }
  const emittedNames = new Set(policies.map((p) => p.policyName));
  const replacementNames = new Set(policies.map((p) => replacementName(p.policyName)));
  const leftovers = existing.filter((p) => replacementNames.has(p.policyName));
  const stale = existing.filter(
    (p) => !emittedNames.has(p.policyName) && !replacementNames.has(p.policyName),
  );
  const copies = new Map<string, number>();
  for (const p of existing) copies.set(p.policyName, (copies.get(p.policyName) ?? 0) + 1);
  const duplicateNames = [...copies].filter(([, n]) => n > 1).map(([name]) => name);
  // Walk the apply order: a new name adds one, a replacement first clears its own leftover, then
  // briefly holds the temporary copy, and nets to zero.
  const driftedNames = new Set(drifted.map((d) => d.name));
  const leftoverNames = new Set(leftovers.map((p) => p.policyName));
  let live = existing.length;
  let peakCount = live;
  for (const p of policies) {
    if (!existingByName.has(p.policyName)) {
      peakCount = Math.max(peakCount, ++live);
    } else if (driftedNames.has(p.policyName)) {
      if (leftoverNames.has(replacementName(p.policyName))) live--;
      peakCount = Math.max(peakCount, live + 1);
    }
  }
  return { drifted, stale, leftovers, duplicateNames, peakCount };
}

export interface ApplyPoliciesOptions {
  readonly organizationId: string;
  /** Replace policies whose content drifted, through a temporary copy. Off by default, so drift
   * fails loudly and the operator reviews the diff first. */
  readonly update?: boolean;
  /**
   * Delete live policies that the emitted set no longer contains. Off by default, because
   * deleting someone else's policy is not a decision this function should take silently.
   *
   * Leaving a stale ALLOW live is not a cosmetic leftover: a policy set is only as tight as its
   * widest ALLOW, so one retired broad allow can readmit everything a narrower replacement was
   * written to exclude. Without this flag such a policy is reported and the run fails.
   */
  readonly prune?: boolean;
}

export interface ApplyPoliciesResult {
  readonly created: string[];
  readonly skippedUnchanged: string[];
  readonly replaced: ReadonlyArray<{ name: string; oldPolicyId: string; newPolicyId: string }>;
  /** Live policies absent from the emitted set, deleted when `prune` is set. */
  readonly pruned: ReadonlyArray<{ name: string; policyId: string }>;
  /** `[replacing]` copies an interrupted replacement left, deleted once the real copy is live. */
  readonly clearedLeftovers: ReadonlyArray<{ name: string; policyId: string }>;
}

/**
 * Push a derived policy set to Turnkey with content-drift detection by `policyName`:
 *   - missing name        → create
 *   - same effect+condition+consensus → skip (true idempotency)
 *   - drift, no `--update` → fail with diff
 *   - drift, with `--update` → replace through a temporary copy, so the policy is never absent
 *   - `[replacing]` copy an interrupted run left → deleted once the real copy is live
 * `notes` is compared as cosmetic-only.
 */
export async function applyPolicies(
  client: TurnkeyClient,
  policies: readonly PolicyDefinition[],
  options: ApplyPoliciesOptions,
): Promise<ApplyPoliciesResult> {
  const existing = await listPolicies(client, options.organizationId);
  const existingByName = new Map(existing.map((p) => [p.policyName, p]));
  const created: string[] = [];
  const skippedUnchanged: string[] = [];
  const replaced: Array<{ name: string; oldPolicyId: string; newPolicyId: string }> = [];
  const pruned: Array<{ name: string; policyId: string }> = [];
  const clearedLeftovers: Array<{ name: string; policyId: string }> = [];

  // PRE-PASS. Both refusals are pure functions of what is already live and what we are about to
  // emit, so they are decided BEFORE anything is written. Deciding them afterwards meant a run
  // that ends in an error had already created policies, and with `prune` had already deleted
  // live ones, leaving the sub-org changed in both directions with no result to report.
  const { drifted, stale, leftovers, duplicateNames, peakCount } = planPolicyChanges(existing, policies);
  // Live policies are keyed by name below, so with two copies of an emitted name only one is seen:
  // the other is neither drifted nor stale, and a DENY fix could silently not take effect.
  const emitted = new Set(policies.map((p) => p.policyName));
  const shadowed = duplicateNames.filter((name) => emitted.has(name));
  if (shadowed.length > 0) {
    const detail = shadowed
      .map((name) => {
        const ids = existing.filter((p) => p.policyName === name).map((p) => p.policyId);
        return `  - ${name}: ${ids.join(', ')}`;
      })
      .join('\n');
    throw new Error(
      `${shadowed.length} emitted polic${shadowed.length === 1 ? 'y name is' : 'y names are'} held ` +
        `by more than one live policy:\n${detail}\n\n` +
        `Reconciliation by name sees only one copy of each. Delete the extra copies ` +
        `(turnkey:delete-policies), then re-run.`,
    );
  }
  if (stale.length > 0 && !options.prune) {
    const detail = stale.map((p) => `  - ${p.policyName} [${p.effect}] (${p.policyId})`).join('\n');
    throw new Error(
      `${stale.length} live polic${stale.length === 1 ? 'y is' : 'ies are'} absent from the ` +
        `emitted set:\n${detail}\n\n` +
        `A retired ALLOW left live keeps granting what it always granted, so a narrower ` +
        `replacement does not take effect until it is gone. Re-run with --prune to delete them, ` +
        `or reconcile the config if they are policies this set should still emit.`,
    );
  }
  if (drifted.length > 0 && !options.update) {
    const detail = drifted.map((d) => `  - ${d.name}:\n${indent(d.diff, '      ')}`).join('\n');
    throw new Error(
      `Content drift detected on ${drifted.length} polic${drifted.length === 1 ? 'y' : 'ies'}. ` +
        `Re-run with --update to replace them through a temporary copy, or fix the existing policy in the Turnkey console.\n${detail}`,
    );
  }

  if (peakCount > TURNKEY_MAX_POLICIES) {
    throw new Error(
      `This run would hold up to ${peakCount} policies at once (${existing.length} live now), over ` +
        `Turnkey's limit of ${TURNKEY_MAX_POLICIES} per org, so it would stop partway. Free ` +
        `${peakCount - TURNKEY_MAX_POLICIES} slot(s) first by deleting policies the sub-org no ` +
        `longer needs (turnkey:delete-policies), then re-run.`,
    );
  }

  // Consume the plan rather than recomputing the comparison: two copies of the predicate would
  // drift apart and a policy could be pre-approved as clean here yet take the recreate branch.
  const driftedNames = new Set(drifted.map((d) => d.name));
  const leftoverByName = new Map(leftovers.map((p) => [p.policyName, p]));
  const clearLeftover = async (leftover: TurnkeyPolicySummary) => {
    await deletePolicy(client, leftover.policyId);
    clearedLeftovers.push({ name: leftover.policyName, policyId: leftover.policyId });
    leftoverByName.delete(leftover.policyName);
  };
  for (const p of policies) {
    const prev = existingByName.get(p.policyName);
    if (prev) {
      if (!driftedNames.has(p.policyName)) {
        skippedUnchanged.push(p.policyName);
        continue;
      }
      // Keep a copy live at every step: a missing DENY admits what it fenced, a missing ALLOW
      // refuses live signatures. An interrupted run's copy goes first, while the old one is live.
      const leftover = leftoverByName.get(replacementName(p.policyName));
      if (leftover) await clearLeftover(leftover);
      const tempId = await createPolicyRaw(client, { ...p, policyName: replacementName(p.policyName) });
      await deletePolicy(client, prev.policyId);
      const newId = await createPolicyRaw(client, p);
      await deletePolicy(client, tempId);
      replaced.push({ name: p.policyName, oldPolicyId: prev.policyId, newPolicyId: newId });
      created.push(newId);
      continue;
    }
    const id = await createPolicyRaw(client, p);
    created.push(id);
  }

  // Every emitted policy now has its real copy live, so an interrupted run's temporary copy can go.
  for (const leftover of [...leftoverByName.values()]) await clearLeftover(leftover);

  // Deletions last, so the narrow replacements are already live before the broad allow goes.
  for (const p of stale) {
    await deletePolicy(client, p.policyId);
    pruned.push({ name: p.policyName, policyId: p.policyId });
  }

  return { created, skippedUnchanged, replaced, pruned, clearedLeftovers };
}

/** The name a drifted policy's new copy holds while the old copy is deleted. */
export function replacementName(policyName: string): string {
  return `${policyName} [replacing]`;
}

async function createPolicyRaw(client: TurnkeyClient, p: PolicyDefinition): Promise<string> {
  // Turnkey wraps activity results in `createPolicyResult`.
  const result = await client.executeActivity<{ createPolicyResult: { policyId: string } }>(
    'ACTIVITY_TYPE_CREATE_POLICY_V3',
    'create_policy',
    {
      policyName: p.policyName,
      effect: p.effect,
      condition: p.condition,
      ...(p.consensus ? { consensus: p.consensus } : {}),
      ...(p.notes ? { notes: p.notes } : {}),
    },
  );
  const id = result.createPolicyResult?.policyId;
  if (!id) {
    throw new Error(
      `CREATE_POLICY_V3 response missing createPolicyResult.policyId for "${p.policyName}": ${JSON.stringify(result)}`,
    );
  }
  return id;
}

function formatPolicyDiff(prev: TurnkeyPolicySummary, next: PolicyDefinition): string {
  const lines: string[] = [];
  if (prev.effect !== next.effect) lines.push(`effect:    ${prev.effect}  →  ${next.effect}`);
  if (prev.condition !== next.condition) {
    lines.push(`condition (was): ${prev.condition}`);
    lines.push(`condition (now): ${next.condition}`);
  }
  const prevCon = prev.consensus ?? '(none)';
  const nextCon = next.consensus ?? '(none)';
  if (prevCon !== nextCon) lines.push(`consensus: ${prevCon}  →  ${nextCon}`);
  return lines.join('\n');
}

function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

/** CAIP-2 `eip155:<id>` → numeric id. Falls through unchanged on non-CAIP input so
 * operator misconfig surfaces as a Turnkey-side parse error rather than silent mismatch. */
function chainIdFromCaip2Evm(chainId: string): string {
  const [namespace, ref] = chainId.split(':');
  return namespace === 'eip155' && ref ? ref : chainId;
}
