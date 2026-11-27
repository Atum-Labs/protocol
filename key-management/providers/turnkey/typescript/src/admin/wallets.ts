// Wallet provisioning. One wallet per sub-organization with three accounts (EVM,
// Tron, Solana) derived from the same seed via per-chain BIP-44 paths. EVM and Tron share
// the underlying secp256k1 key; the Solana account uses Ed25519 on the standard Solana path.

import type { TurnkeyClient } from '../client';

export interface CreateWalletInput {
  readonly walletName: string;
  /** When set, override the default BIP-44 paths. Default coverage: EVM at
   * m/44'/60'/0'/0/0, Tron at m/44'/195'/0'/0/0, Solana at m/44'/501'/0'/0'. */
  readonly customAccounts?: ReadonlyArray<{
    curve: 'CURVE_SECP256K1' | 'CURVE_ED25519';
    pathFormat: 'PATH_FORMAT_BIP32';
    path: string;
    addressFormat:
      | 'ADDRESS_FORMAT_ETHEREUM'
      | 'ADDRESS_FORMAT_TRON'
      | 'ADDRESS_FORMAT_SOLANA'
      | 'ADDRESS_FORMAT_XLM';
  }>;
}

export interface CreateWalletResult {
  readonly walletId: string;
  readonly addresses: readonly string[];
}

const DEFAULT_ACCOUNTS = [
  {
    curve: 'CURVE_SECP256K1',
    pathFormat: 'PATH_FORMAT_BIP32',
    path: "m/44'/60'/0'/0/0",
    addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
  },
  {
    curve: 'CURVE_SECP256K1',
    pathFormat: 'PATH_FORMAT_BIP32',
    path: "m/44'/195'/0'/0/0",
    addressFormat: 'ADDRESS_FORMAT_TRON',
  },
  {
    curve: 'CURVE_ED25519',
    pathFormat: 'PATH_FORMAT_BIP32',
    path: "m/44'/501'/0'/0'",
    addressFormat: 'ADDRESS_FORMAT_SOLANA',
  },
] as const;

/**
 * The Stellar account to append to `customAccounts` (with the three defaults) when a sub-org also
 * signs for Stellar. Format, curve and path are the row Turnkey lists for Stellar in its wallet
 * docs (docs.turnkey.com/concepts/wallets, checked 2026-11-10). Opt-in, so every existing
 * sub-org's wallet shape and the three-address output of `create-sub-org` are unchanged.
 */
export const STELLAR_WALLET_ACCOUNT = {
  curve: 'CURVE_ED25519',
  pathFormat: 'PATH_FORMAT_BIP32',
  path: "m/44'/148'/0'/0'/0",
  addressFormat: 'ADDRESS_FORMAT_XLM',
} as const;

/**
 * Create a wallet inside the agent's sub-organization with the three chain accounts the
 * settler needs. Runs against the sub-org's API user (not the parent org). Returns the
 * `walletId` to pin in profile YAML and the addresses Turnkey derived.
 */
export async function createWalletWithChainAccounts(
  client: TurnkeyClient,
  input: CreateWalletInput,
): Promise<CreateWalletResult> {
  const accounts = (input.customAccounts ?? DEFAULT_ACCOUNTS) as ReadonlyArray<
    Record<string, unknown>
  >;
  // Turnkey wraps activity results in a per-activity-type key (`createWalletResult` here).
  // Unwrap one level to expose the operational fields.
  const result = await client.executeActivity<{
    createWalletResult: { walletId: string; addresses: string[] };
  }>('ACTIVITY_TYPE_CREATE_WALLET', 'create_wallet', {
    walletName: input.walletName,
    accounts,
  });
  const inner = result.createWalletResult;
  if (!inner?.walletId) {
    throw new Error(
      `CREATE_WALLET response missing createWalletResult.walletId: ${JSON.stringify(result)}`,
    );
  }
  return { walletId: inner.walletId, addresses: inner.addresses ?? [] };
}
