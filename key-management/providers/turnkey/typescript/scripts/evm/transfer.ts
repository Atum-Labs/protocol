/**
 * Send a regular transfer (native coin or token) FROM a Turnkey-managed
 * wallet TO any address. The Turnkey signer only signs, so this script also
 * populates the transaction and broadcasts the signed result via an RPC.
 *
 * Run it (workspace must be installed first with `pnpm install` at the repo root):
 *
 *   # native coin, amount in whole units:
 *   npx tsx scripts/evm/transfer.ts <toAddress> <amount>
 *
 *   # token, amount in whole units (decimals fetched on-chain):
 *   npx tsx scripts/evm/transfer.ts <toAddress> <amount> <tokenAddress>
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
 */
import {
  Contract,
  Interface,
  JsonRpcProvider,
  isAddress,
  parseEther,
  parseUnits,
  type TransactionRequest,
} from 'ethers';

import { getOrCreateTurnkeyClient, TurnkeyEvmSigner, noopLogger } from '../../src/index';
import { DEFAULT_API_URL, loadScriptEnv, readEnv } from '../_shared';

const TOKEN_ABI = [
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount)',
];

/** Find the walletId holding a chain address — operators usually have the address, not the id. */
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
  const [to, amount, token] = process.argv.slice(2);
  if (!to || !amount) {
    console.error('usage: tsx scripts/evm/transfer.ts <toAddress> <amount> [tokenAddress]');
    process.exit(1);
  }
  if (!isAddress(to)) {
    console.error(`✗ invalid recipient address: ${to}`);
    process.exit(1);
  }
  if (token && !isAddress(token)) {
    console.error(`✗ invalid token address: ${token}`);
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

  // Build the transfer: native -> {to, value}; token -> {to: token, data: transfer(...)}.
  let req: TransactionRequest;
  let summary: string;
  if (token) {
    const decimals = Number(await new Contract(token, TOKEN_ABI, provider).decimals());
    const value = parseUnits(amount, decimals);
    const data = new Interface(TOKEN_ABI).encodeFunctionData('transfer', [to, value]);
    req = { to: token, value: 0n, data };
    summary = `${amount} of token ${token} -> ${to}`;
  } else {
    req = { to, value: parseEther(amount) };
    summary = `${amount} (native) -> ${to}`;
  }

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

  console.log(`From:   ${from}`);
  console.log(`Send:   ${summary}`);
  console.log(`Chain:  ${network.chainId}  nonce ${nonce}  gas ${gasLimit}`);

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
