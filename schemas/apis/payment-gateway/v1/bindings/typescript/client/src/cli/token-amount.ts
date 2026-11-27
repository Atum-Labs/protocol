/**
 * Amounts as a person reads them, `0.10015 USDC (100150 units)`, from the token list `/v1/defaults`
 * publishes for each chain. Display only: a token the gateway does not list, or a list that cannot
 * be read, shows the smallest units as the API carries them.
 */

import { ethers } from 'ethers';
import { POSITIVE_DECIMAL_UINT } from '@atum-labs/payment-request-sender-auth';
import type { PaymentGatewayClient } from '../index';
import { parseAssetIdentifier } from '../asset-identifier';
import { sameAccount } from '../award-quote';

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

/** The listed token of each asset identifier, by {@link tokenKey}. */
export type TokenInfos = ReadonlyMap<string, TokenInfo>;

/** One key per asset however its identifier is spelled: EVM hex in any case, base58 as is. */
export function tokenKey(assetId: string): string {
  try {
    const { chainId, namespace, tokenAddress } = parseAssetIdentifier(assetId);
    return `${chainId}/${namespace === 'eip155' ? tokenAddress.toLowerCase() : tokenAddress}`;
  } catch {
    return assetId;
  }
}

const SYMBOL = /^[A-Za-z0-9.$_+-]{1,16}$/;

/** A `/v1/defaults` token entry, unchecked. */
type ListedToken = { symbol?: unknown; address?: unknown; decimals?: unknown };

/** The token behind each asset identifier, where its chain's `/v1/defaults` lists it. */
export async function tokenInfos(
  client: PaymentGatewayClient,
  assetIds: readonly string[],
): Promise<TokenInfos> {
  const assets = assetIds.flatMap((id) => {
    try {
      return [{ id, parsed: parseAssetIdentifier(id) }];
    } catch {
      return [];
    }
  });
  const chains = [...new Set(assets.map((a) => a.parsed.chainId))];
  const listed = new Map<string, ListedToken[]>(
    await Promise.all(
      chains.map(async (chainId): Promise<[string, ListedToken[]]> => {
        try {
          // ChainDefaults leaves tokens out: they are display data, read off the typed call.
          const defaults = await client.chainDefaults.getDefaults({ chainId });
          const tokens = (defaults as { tokens?: unknown }).tokens;
          return [chainId, Array.isArray(tokens) ? (tokens as ListedToken[]) : []];
        } catch {
          return [chainId, []];
        }
      }),
    ),
  );
  const infos = new Map<string, TokenInfo>();
  for (const { id, parsed } of assets) {
    const token = listed
      .get(parsed.chainId)
      ?.find(
        (t) =>
          typeof t.address === 'string' &&
          sameAccount(parsed.namespace, t.address, parsed.tokenAddress),
      );
    const { symbol, decimals } = token ?? {};
    if (
      typeof symbol === 'string' &&
      SYMBOL.test(symbol) &&
      typeof decimals === 'number' &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= 36
    ) {
      infos.set(tokenKey(id), { symbol, decimals });
    }
  }
  return infos;
}

/**
 * `0.10015 USDC (100150 units)` for a listed token, else `100150 units of 0xaf88…5831`. The units
 * are always shown: they are what the deposit signs.
 */
export function formatAmount(
  units: string,
  assetId: string,
  tokens?: TokenInfos,
  { nameUnlisted = true }: { nameUnlisted?: boolean } = {},
): string {
  const token = tokens?.get(tokenKey(assetId));
  if (token && POSITIVE_DECIMAL_UINT.test(units)) {
    const amount = ethers.formatUnits(BigInt(units), token.decimals).replace(/\.0$/, '');
    return `${amount} ${token.symbol} (${units} units)`;
  }
  return nameUnlisted ? `${units} units of ${tokenOf(assetId)}` : `${units} units`;
}

/** `eip155:42161/erc20:0xaf88…5831` → `0xaf88…5831`. */
function tokenOf(assetId: string): string {
  const asset = assetId.slice(assetId.indexOf('/') + 1);
  const address = asset.slice(asset.indexOf(':') + 1);
  return address.length > 13 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address || '?';
}
