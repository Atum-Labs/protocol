import { getChainAdapter, namespaceForTurnkeyAddressFormat } from '../chain-adapters';
import { requirePinnedSender } from './pinned-address';
import { STELLAR_TURNKEY_UNSUPPORTED } from './stellar-turnkey';
import { RawSenderSigner } from './raw';
import { TurnkeySenderSigner } from './turnkey';
import type { SenderSigner, SenderSignerOptions, TurnkeyConfig } from './types';

export type {
  SenderSignInput,
  SenderSigner,
  SenderSignature,
  SenderSignerOptions,
  TurnkeyConfig,
} from './types';
export { RawSenderSigner } from './raw';
export { TurnkeySenderSigner } from './turnkey';

/**
 * Build a SenderSigner for the given CAIP-2 source chain. Defaults to the
 * private-key provider (unchanged local signing); pass
 * `{ provider: 'turnkey', ... }` to sign the sender_auth message via a Turnkey
 * wallet instead.
 */
export function createSenderSigner(sourceChainId: string, opts: SenderSignerOptions): SenderSigner {
  // Lowercased so a namespace's capitalization alone cannot make a supported chain unroutable,
  // matching getChainAdapter.
  const chainPrefix = sourceChainId.split(':')[0]?.toLowerCase() ?? '';
  if (opts.provider === 'turnkey') {
    // SEAM(turnkey-stellar): fail closed before a wallet is contacted; see stellar-turnkey.ts.
    if (chainPrefix === 'stellar') throw new Error(STELLAR_TURNKEY_UNSUPPORTED);
    return new TurnkeySenderSigner(chainPrefix, opts);
  }
  const pinnedAddress = requirePinnedSender(opts.pinnedAddress);
  const adapter = getChainAdapter(sourceChainId);
  const privateKey = adapter.formatPrivateKey(opts.privateKey);
  // Reject a malformed key value-free before the pinnedAddress check below runs
  // it through ethers (which would otherwise echo the key in its error).
  adapter.validatePrivateKey?.(opts.privateKey);
  // Mirror the Turnkey pinnedAddress check: fail fast if the key does not derive
  // the expected sender, rather than signing as the wrong depositor. Fail closed:
  // if an adapter cannot verify the key, refuse the pin rather than silently
  // skipping it and signing with an unverified key.
  if (pinnedAddress) {
    if (!adapter.verifyAddressMatchesKey) {
      throw new Error(
        `pinnedAddress was provided but the ${sourceChainId} adapter cannot verify the key derives it`,
      );
    }
    adapter.verifyAddressMatchesKey(privateKey, pinnedAddress);
  }
  // Actual signing runs through the shared SDK's localKeySigner (wrapped by
  // RawSenderSigner), the single canonical signing path.
  return new RawSenderSigner(sourceChainId, opts.privateKey);
}

/**
 * Resolve a Turnkey wallet's sender addresses keyed by CAIP-2 namespace, in one
 * query. The Turnkey impl is loaded lazily so a plain SDK import stays free of
 * @solana/web3.js.
 */
export async function resolveTurnkeyAddresses(
  cfg: Omit<TurnkeyConfig, 'pinnedAddress'>,
): Promise<Record<string, string>> {
  const impl = await import('./turnkey-impl');
  // No pinnedAddress: this lists accounts and verifies nothing, so a pin here would read as a
  // check that does not happen.
  const accounts = await impl.resolveSenderAddresses({
    organizationId: cfg.organizationId,
    walletId: cfg.walletId,
    apiPublicKey: cfg.apiPublicKey,
    apiPrivateKey: cfg.apiPrivateKey,
    ...(cfg.logger ? { logger: cfg.logger } : {}),
    ...(cfg.meter ? { meter: cfg.meter } : {}),
  });
  // Map each account's Turnkey format to its namespace via the chain-adapter registry.
  const addresses: Record<string, string> = {};
  for (const { address, addressFormat } of accounts) {
    const namespace = namespaceForTurnkeyAddressFormat(addressFormat);
    if (namespace) addresses[namespace] = address;
  }
  return addresses;
}
