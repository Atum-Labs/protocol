/**
 * Set the Tempo fee token for a Turnkey-managed wallet.
 *
 * On Tempo, network fees are paid in a stablecoin and swapped to the network fee
 * asset via an on-chain liquidity pool (the "FeeAMM"). If the chosen fee token's
 * pool lacks liquidity, transactions from the wallet are rejected (not a balance
 * problem — a liquidity condition). The fee token is an account-level preference
 * stored on Tempo's FeeManager contract, changed by calling setUserToken(token).
 * This script points the wallet at a more liquid token (for example pathUSD).
 *
 * The Turnkey signer only signs, so this also populates the transaction and
 * broadcasts the signed result via an RPC. Note the setUserToken tx itself pays
 * its fee in the wallet's CURRENT fee token, so if that token is the one that is
 * illiquid the switch may need to be sent when its pool can still settle.
 *
 * Run it (workspace must be installed first with `pnpm install` at the repo root):
 *
 *   npx tsx scripts/evm/set-tempo-fee-token.ts <feeTokenAddress>
 *   # e.g. switch fees to pathUSD:
 *   npx tsx scripts/evm/set-tempo-fee-token.ts 0x20C0000000000000000000000000000000000000
 *
 * Env is read from `scripts/.env` (gitignored, see .env.example); anything already
 * exported in the shell wins over it.
 *
 * Required env:
 *   RPC_URL                  Tempo JSON-RPC endpoint to broadcast on
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
 *   FEE_MANAGER_ADDRESS      Tempo FeeManager (default 0xfeEC000000000000000000000000000000000000)
 */
import { Interface, JsonRpcProvider, isAddress, type TransactionRequest } from 'ethers';

import { getOrCreateTurnkeyClient, TurnkeyEvmSigner, noopLogger } from '../../src/index';
import { DEFAULT_API_URL, loadScriptEnv, readEnv } from '../_shared';

// Tempo FeeManager holds the per-account fee-token preference.
const CANONICAL_FEE_MANAGER = '0xfeEC000000000000000000000000000000000000';

const FEE_MANAGER_ABI = ['function setUserToken(address token)'];

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

/**
 * Poll the raw JSON-RPC receipt for a tx hash. Tempo returns account-abstraction transactions
 * (type 0x76, with feeToken / calls / nonceKey fields and null values) that ethers v6 cannot
 * parse while scanning a block, so `tx.wait()` throws even on a successful tx. Reading the raw
 * receipt object over `eth_getTransactionReceipt` avoids ethers' typed transaction parsing.
 */
async function waitForReceipt(
  provider: JsonRpcProvider,
  hash: string,
  timeoutMs = 120_000,
): Promise<{ blockNumber: string; status: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = (await provider.send('eth_getTransactionReceipt', [hash])) as {
      blockNumber: string;
      status: string;
    } | null;
    if (r) return r;
    await new Promise((res) => setTimeout(res, 2_000));
  }
  throw new Error(`timed out waiting for receipt ${hash}`);
}

async function main(): Promise<void> {
  loadScriptEnv();
  const [feeToken] = process.argv.slice(2);
  if (!feeToken) {
    console.error('usage: tsx scripts/evm/set-tempo-fee-token.ts <feeTokenAddress>');
    process.exit(1);
  }
  if (!isAddress(feeToken)) {
    console.error(`✗ invalid fee token address: ${feeToken}`);
    process.exit(1);
  }
  const feeManager = process.env.FEE_MANAGER_ADDRESS ?? CANONICAL_FEE_MANAGER;
  if (!isAddress(feeManager)) {
    console.error(`✗ invalid FeeManager address: ${feeManager}`);
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

  // Build the call: FeeManager.setUserToken(feeToken).
  const data = new Interface(FEE_MANAGER_ABI).encodeFunctionData('setUserToken', [feeToken]);
  const req: TransactionRequest = { to: feeManager, value: 0n, data };

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

  console.log(`From:      ${from}`);
  console.log(`Fee token: ${feeToken}  via FeeManager ${feeManager}`);
  console.log(`Chain:     ${network.chainId}  nonce ${nonce}  gas ${gasLimit}`);

  const signed = await signer.signTransaction(populated);
  // Broadcast and poll the raw receipt over JSON-RPC (see waitForReceipt): ethers' typed
  // broadcastTransaction/tx.wait() path chokes on Tempo's account-abstraction tx format.
  const hash: string = await provider.send('eth_sendRawTransaction', [signed]);
  console.log(`Broadcast: ${hash}`);
  const receipt = await waitForReceipt(provider, hash);
  console.log(
    `Confirmed in block ${parseInt(receipt.blockNumber, 16)} (status ${receipt.status === '0x1' ? 'success' : 'reverted'})`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
