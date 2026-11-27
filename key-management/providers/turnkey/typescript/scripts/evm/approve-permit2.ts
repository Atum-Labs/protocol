/**
 * Approve the Permit2 contract to move a token held by a Turnkey-managed
 * wallet. This is the on-chain allowance the payment flow needs from a sender
 * wallet: token movement is relayed through Permit2 (the wallet signs a permit
 * off-chain and a relayer submits it), so Permit2 must first hold a spending
 * allowance on the token. The Turnkey signer only signs, so this script also
 * populates the transaction and broadcasts the signed result via an RPC.
 *
 * Run it (workspace must be installed first with `pnpm install` at the repo root):
 *
 *   # approve an exact amount (whole units, decimals fetched on-chain):
 *   npx tsx scripts/evm/approve-permit2.ts <tokenAddress> <amount>
 *
 *   # approve the maximum, unlimited allowance:
 *   npx tsx scripts/evm/approve-permit2.ts <tokenAddress> max
 *
 * Env is read from `scripts/.env` (gitignored, see .env.example); anything already
 * exported in the shell wins over it.
 *
 * Required env:
 *   RPC_URL                  JSON-RPC endpoint to broadcast on
 *   TURNKEY_ORGANIZATION_ID  Turnkey (sub-)organization id
 *   TURNKEY_API_PUBLIC_KEY   Turnkey API key (public)
 *   TURNKEY_API_PRIVATE_KEY  Turnkey API key (private)
 *   TURNKEY_WALLET_ID        Turnkey wallet id holding the account
 *     (or TURNKEY_WALLET_ADDRESS to discover the wallet id from an address)
 * Optional env:
 *   TURNKEY_API_URL          Turnkey API base (default https://api.turnkey.com)
 *   TURNKEY_WALLET_ADDRESS   address to send from; discovers the wallet id
 *                            and is pinned as the expected resolved address
 *   TURNKEY_PINNED_ADDRESS   assert the wallet resolves to this exact address
 *   PERMIT2_ADDRESS          Permit2 contract to approve (default canonical
 *                            0x000000000022D473030F116dDEE9F6B43aC78BA3)
 */
import {
  Contract,
  Interface,
  JsonRpcProvider,
  MaxUint256,
  isAddress,
  parseUnits,
  type TransactionRequest,
} from 'ethers';

import { getOrCreateTurnkeyClient, TurnkeyEvmSigner, noopLogger } from '../../src/index';
import { DEFAULT_API_URL, loadScriptEnv, readEnv } from '../_shared';

// Canonical Permit2, deployed at the same address on virtually every chain.
const CANONICAL_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const TOKEN_ABI = [
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount)',
];

/** Find the walletId holding an address — operators usually have the address, not the id. */
async function resolveWalletId(
  client: ReturnType<typeof getOrCreateTurnkeyClient>,
  address: string,
): Promise<string> {
  for (const w of await client.listWallets()) {
    const accounts = await client.listWalletAccounts(w.walletId);
    if (accounts.some((a) => a.address.toLowerCase() === address.toLowerCase())) {
      return w.walletId;
    }
  }
  throw new Error(`no Turnkey wallet in this organization holds address ${address}`);
}

async function main(): Promise<void> {
  loadScriptEnv();
  const [tokenArg, amountArg] = process.argv.slice(2);
  if (!tokenArg || !amountArg) {
    console.error('usage: tsx scripts/evm/approve-permit2.ts <tokenAddress> <amount|max>');
    process.exit(1);
  }
  if (!isAddress(tokenArg)) {
    console.error(`✗ invalid token address: ${tokenArg}`);
    process.exit(1);
  }
  const spender = process.env.PERMIT2_ADDRESS ?? CANONICAL_PERMIT2;
  if (!isAddress(spender)) {
    console.error(`✗ invalid Permit2 address: ${spender}`);
    process.exit(1);
  }

  const provider = new JsonRpcProvider(readEnv('RPC_URL'));

  const client = getOrCreateTurnkeyClient({
    organizationId: readEnv('TURNKEY_ORGANIZATION_ID'),
    apiUrl: process.env.TURNKEY_API_URL ?? DEFAULT_API_URL,
    apiPublicKey: readEnv('TURNKEY_API_PUBLIC_KEY'),
    apiPrivateKey: readEnv('TURNKEY_API_PRIVATE_KEY'),
    concurrencyLimit: 10,
    requestTimeoutMs: 30_000,
  });

  // Accept either the Turnkey walletId directly, or a wallet address to discover it from.
  const walletAddress = process.env.TURNKEY_WALLET_ADDRESS;
  let walletId = process.env.TURNKEY_WALLET_ID;
  if (!walletId) {
    if (!walletAddress) {
      console.error('✗ set TURNKEY_WALLET_ID or TURNKEY_WALLET_ADDRESS');
      process.exit(1);
    }
    walletId = await resolveWalletId(client, walletAddress);
  }
  const signer = new TurnkeyEvmSigner(client, {
    walletId,
    log: noopLogger,
    discoveryTimeoutMs: 30_000,
    pinnedAddress: walletAddress ?? process.env.TURNKEY_PINNED_ADDRESS,
  });
  await signer.initialize();
  const from = signer.identity.address;

  // Resolve the approval amount: `max` grants an unlimited allowance, otherwise
  // parse the amount in whole units using the token's own decimals.
  const token = new Contract(tokenArg, TOKEN_ABI, provider);
  let amount: bigint;
  let amountLabel: string;
  if (amountArg.toLowerCase() === 'max') {
    amount = MaxUint256;
    amountLabel = 'max (unlimited)';
  } else {
    const decimals = Number(await token.decimals());
    amount = parseUnits(amountArg, decimals);
    amountLabel = amountArg;
  }

  // Build the approval: approve(spender = Permit2, amount) on the token.
  const data = new Interface(TOKEN_ABI).encodeFunctionData('approve', [spender, amount]);
  const req: TransactionRequest = { to: tokenArg, value: 0n, data };

  const currentAllowance: bigint = await token.allowance(from, spender);

  // The signer serializes exactly what it is given, so fully populate the tx here.
  const network = await provider.getNetwork();
  const fee = await provider.getFeeData();
  const [nonce, gasLimit] = await Promise.all([
    provider.getTransactionCount(from, 'pending'),
    provider.estimateGas({ from, ...req }),
  ]);
  const feeFields: Partial<TransactionRequest> =
    fee.maxFeePerGas && fee.maxPriorityFeePerGas
      ? {
          type: 2,
          maxFeePerGas: fee.maxFeePerGas,
          maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
        }
      : { type: 0, gasPrice: fee.gasPrice };

  const populated: TransactionRequest = {
    ...req,
    chainId: network.chainId,
    nonce,
    gasLimit,
    ...feeFields,
  };

  console.log(`From:    ${from}`);
  console.log(`Approve: ${amountLabel} of token ${tokenArg} for Permit2 ${spender}`);
  console.log(`Current: allowance ${currentAllowance}`);
  console.log(`Chain:   ${network.chainId}  nonce ${nonce}  gas ${gasLimit}`);

  const signed = await signer.signTransaction(populated);
  const sent = await provider.broadcastTransaction(signed);
  console.log(`Broadcast: ${sent.hash}`);
  const receipt = await sent.wait();
  console.log(
    `Confirmed in block ${receipt?.blockNumber} (status ${receipt?.status === 1 ? 'success' : 'reverted'})`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
