/**
 * Refuse a policy config that still lists a contract a redeploy has replaced.
 *
 * This lives in its own module rather than inside `apply-policies.ts` for a mundane but load-bearing
 * reason: that file calls `main()` at import time, the way every script in this directory does. A
 * test that imported the guard from there would run the CLI, which exits(1) on the missing --config
 * and fails the suite with an unhandled error while every assertion still passed. Keeping the rule
 * importable keeps it testable without changing how the scripts are invoked.
 *
 * The parameter is typed STRUCTURALLY rather than against apply-policies' `Config`, so importing
 * this back into that file cannot create a cycle.
 */

import { tronBase58ToEvmHex } from '../src/admin/sender-policies';

export interface RetiredContract {
  readonly address: string;
  readonly what: string;
}

/**
 * Addresses of Atum contracts that have been REPLACED by a redeploy. Listing one in `allowedTo` (or
 * `allowedPrograms`) means the config was written against an older deployment, and applying it
 * yields a policy set that denies the live contracts with HTTP 403 while looking like a success.
 *
 * This fails CLOSED on a known-bad address rather than validating against a known-good list. That
 * polarity is deliberate: a known-good list would have to be updated in lockstep with every
 * deployment or it would start rejecting valid new addresses, whereas a retired list can only ever
 * be incomplete — it never wrongly blocks. Incomplete is a missed catch; wrongly blocking is an
 * outage of its own.
 *
 * Add an entry whenever a contract is redeployed, in the same change that moves the deployment.
 */
export const RETIRED_CONTRACTS: ReadonlyArray<RetiredContract> = [
  // EVM contracts superseded by the v4 deployment.
  { address: '0xa61a0c025943aa79b73d8d07e3adbee1873738b4', what: 'v3 escrow' },
  { address: '0x09a5a0d6955e5394a661cd9e7007076fa63b4158', what: 'v3 fulfillment proxy' },
  // Tron.
  { address: 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py', what: 'v3 shasta escrow' },
  { address: 'TBx4epYWH6gp5b6hqhjo3pUmzMXdj4ypML', what: 'v3 shasta fulfillment proxy' },
  { address: 'TFXoNv8TuzXEGrkRv6aNghM2G7Lfjy15Aj', what: 'v1 mainnet escrow' },
  { address: 'TNSwwHhw1dWiwEPf7cQ3bUpBXBDpfNUvK2', what: 'v1 mainnet fulfillment proxy' },
  // Solana. On v1/v3 one pair served every cluster; v4 has a distinct pair per cluster, so these
  // two are retired everywhere at once.
  { address: '44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs', what: 'v1/v3 escrow program' },
  { address: '77AqGeSh3GLFcBwSxdTnefgv92Cosi9o6NsK992TZsRe', what: 'v1/v3 fulfillment program' },
];

/**
 * The shape this guard needs, and no more — but it must cover BOTH config kinds. A settler config
 * carries per-chain `allowlists`; a sender config carries none of those and puts its only
 * contract-address fields under `senderExtras`.
 *
 * Both members are optional because either kind is a valid argument. That makes this a TypeScript
 * "weak type" (every property optional), and a weak type rejects an argument that shares NO
 * property with it. An allowlists-only shape therefore could not accept a sender config at all:
 * `assertNoRetiredContracts(cfg)` failed to compile with
 * "Type 'SenderConfig' has no properties in common with type 'AllowlistBearing'". Naming
 * `senderExtras` here is what makes the union assignable, and it is also what the guard has to read
 * to be worth anything on the sender path.
 */
export interface RetiredContractBearing {
  readonly allowlists?: Record<
    string,
    { readonly allowedTo?: unknown; readonly allowedPrograms?: unknown } | undefined
  >;
  readonly senderExtras?: {
    readonly solanaEscrowProgramId?: unknown;
    readonly allowedTokens?: unknown;
  };
  /**
   * approveDeny holds the FULFILLMENT PROXIES by design: ensureTokenApprovals() calls
   * approve(fulfillmentProxy, MAX) at boot for EVERY proxy the agent trusts, so each of them is a
   * spender the allowlist needs (and the escrow is not).
   * Its addresses are spelled differently from every other field here — EVM spenders are bare
   * 40-char hex with NO 0x, and tron spenders are EVM-style hex rather than base58 — which is why
   * naming the field is not enough on its own; see retiredSpellings.
   */
  readonly approveDeny?: {
    readonly evm?: Record<string, { readonly allowedSpendersHex?: unknown } | undefined>;
    readonly tron?: Record<string, { readonly allowedSpendersHex?: unknown } | undefined>;
  };
}

/**
 * Every spelling each retired address can legitimately appear in, derived from the constants at
 * module load rather than hand-typed.
 *
 * This is the part that makes walking approveDeny actually work. The matcher used to be a raw
 * case-insensitive string compare, and BOTH offending values in settler-testnet.example.yaml
 * returned no match against it: the EVM spender because the list stores `0x...`, the tron spender
 * because the list stores base58 while the field stores hex. Adding the field name without this
 * would have produced the appearance of coverage over exactly the two lines it was added for.
 *
 * DERIVED, not normalized. The rule above still holds — operator input is compared verbatim and is
 * never transformed. What is transformed is our own compile-time constants, in one direction, once.
 * A constant that cannot decode is SKIPPED, which is the expected path for the 0x-hex and the
 * Solana entries; retired-contracts.test.ts pins the resulting key count so a silent collapse to
 * "raw only" cannot pass.
 */
const retiredSpellings: ReadonlyMap<string, RetiredContract> = (() => {
  const m = new Map<string, RetiredContract>();
  const add = (key: string, entry: RetiredContract): void => {
    const k = key.trim().toLowerCase();
    if (k === '') return;
    const prior = m.get(k);
    if (prior && prior.address !== entry.address) {
      // Two retired contracts sharing a spelling would make an offence report ambiguous about
      // WHICH contract was named, so fail at load rather than pick one.
      throw new Error(
        `retired-contracts: spelling ${k} maps to both ${prior.address} and ${entry.address}`,
      );
    }
    m.set(k, entry);
  };
  for (const entry of RETIRED_CONTRACTS) {
    add(entry.address, entry);
    if (entry.address.startsWith('0x') || entry.address.startsWith('0X')) {
      add(entry.address.slice(2), entry); // approveDeny.evm spellings carry no 0x
    } else {
      try {
        add(tronBase58ToEvmHex(entry.address), entry); // approveDeny.tron is EVM-style hex
      } catch {
        // Not a tron base58 address. Expected for the Solana program ids, which are 32-byte
        // base58 and therefore fail the 25-byte/0x41/checksum shape. Nothing to add.
      }
    }
  }
  return m;
})();

/** The count retiredSpellings must produce; asserted in the tests so a collapse cannot pass. */
export const RETIRED_SPELLING_COUNT = retiredSpellings.size;

/**
 * Throws if any allowlist entry names a retired contract.
 *
 * Comparison is case-insensitive, which is correct for EVM hex and acceptable for the base58 entries
 * because each is compared against its own exact spelling — but note base58 IS case-significant in
 * general, so this must never be used to NORMALIZE an address, only to match one.
 */
export function assertNoRetiredContracts(cfg: RetiredContractBearing): void {
  const offences: string[] = [];

  const check = (chainKey: string, field: string, addrs: readonly unknown[]): void => {
    for (const a of addrs) {
      if (typeof a !== 'string') continue;
      const hit = retiredSpellings.get(a.trim().toLowerCase());
      if (hit) offences.push(`  ${chainKey}.${field}: ${a}  (${hit.what})`);
    }
  };

  for (const [chainKey, entry] of Object.entries(cfg.allowlists ?? {})) {
    if (!entry) continue;
    if (Array.isArray(entry.allowedTo)) check(chainKey, 'allowedTo', entry.allowedTo);
    if (Array.isArray(entry.allowedPrograms)) check(chainKey, 'allowedPrograms', entry.allowedPrograms);
  }

  // The sender path. A sender config has no `allowlists` at all, so everything above skips it and
  // the guard used to be a complete no-op on that shape — while `solanaEscrowProgramId` names the
  // escrow program DIRECTLY, which is precisely what the v4 redeploy retired. The shipped
  // sender-testnet example was still on the v1/v3 program because of this blind spot, and the
  // "example configs pass their own guard" test reported green over it.
  const sender = cfg.senderExtras;
  if (sender) {
    const escrowIds = Array.isArray(sender.solanaEscrowProgramId)
      ? sender.solanaEscrowProgramId
      : [sender.solanaEscrowProgramId];
    check('senderExtras', 'solanaEscrowProgramId', escrowIds);
    // Token contracts rather than escrows, so no current entry can match. Walked anyway: the cost
    // is nothing and the failure mode of missing it is an address pasted into the wrong field.
    if (sender.allowedTokens && typeof sender.allowedTokens === 'object') {
      for (const [chainKey, toks] of Object.entries(sender.allowedTokens as Record<string, unknown>)) {
        if (Array.isArray(toks)) check(`senderExtras.allowedTokens.${chainKey}`, 'allowedTokens', toks);
      }
    }
  }

  // approveDeny. Walked last so its offences read after the allowlist ones, and counted so the
  // error can describe the right mechanism for it — an approveDeny miss is NOT the eth.tx.to
  // default-deny the message below describes.
  const beforeApproveDeny = offences.length;
  for (const vm of ['evm', 'tron'] as const) {
    const perChain = cfg.approveDeny?.[vm];
    if (!perChain) continue;
    for (const [chainKey, entry] of Object.entries(perChain)) {
      if (!entry) continue;
      if (Array.isArray(entry.allowedSpendersHex)) {
        check(`approveDeny.${vm}.${chainKey}`, 'allowedSpendersHex', entry.allowedSpendersHex);
      }
    }
  }
  const approveDenyOffences = offences.length - beforeApproveDeny;

  if (offences.length > 0) {
    throw new Error(
      'This config lists contract addresses that have been retired by a redeploy:\n' +
        offences.join('\n') +
        '\n\nApplying it would emit a policy set that DENIES the live contracts: Turnkey pins ' +
        'eth.tx.to, so an address absent from allowedTo is default-denied with HTTP 403 "add a ' +
        'policy granting this user permissions", and every settlement on that chain fails.\n' +
        'Update the addresses to the current deployment. When rolling out, ADD the new pair before ' +
        'removing the old one so agents mid-rollout keep signing.' +
        (approveDenyOffences > 0
          ? '\n\nNOTE on the approveDeny entries above: those fail DIFFERENTLY from the rest. ' +
            'approveDeny emits a DENY on approve() and the other allowance grants to any spender ' +
            'outside the list, so a retired ' +
            'address being PRESENT denies nothing — it is stale breadth. What breaks the settler is ' +
            'a current proxy being ABSENT, which denies the approve(fulfillmentProxy, MAX) that ' +
            'ensureTokenApprovals() performs at boot, once per trusted proxy. So treat this as a ' +
            'staleness signal and check that EVERY current proxy the agent trusts is listed, which ' +
            'this guard cannot tell you.'
          : ''),
    );
  }
}
