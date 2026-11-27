/**
 * Approve the Permit2 contract to move a token held by a Turnkey-managed wallet
 * on Tron. Tron sibling of ../evm/approve-permit2.ts: the payment flow relays
 * token movement through Permit2, so a sender wallet must hold a Permit2
 * allowance on each source token first. The Turnkey signer only signs, so this
 * script builds the approve() call via the full-node HTTP API, signs it with
 * the Turnkey Tron signer, and broadcasts it.
 *
 * Run it (workspace must be installed first with `pnpm install` at the repo root):
 *
 *   # unlimited allowance (what the payment flow uses):
 *   npx tsx scripts/tvm/approve-permit2.ts <tokenBase58> max
 *
 *   # exact amount in whole units (decimals fetched on-chain):
 *   npx tsx scripts/tvm/approve-permit2.ts <tokenBase58> 100
 *
 * Env is read from `scripts/.env` (gitignored, see .env.example); anything already
 * exported in the shell wins over it.
 *
 * Required env:
 *   RPC_URL                  Tron full-node HTTP base (e.g. https://api.shasta.trongrid.io)
 *   TURNKEY_ORGANIZATION_ID  Turnkey (sub-)organization id
 *   TURNKEY_API_PUBLIC_KEY   Turnkey API key (public)
 *   TURNKEY_API_PRIVATE_KEY  Turnkey API key (private)
 *   TURNKEY_WALLET_ID        Turnkey wallet id holding the account
 *     (or TURNKEY_WALLET_ADDRESS, the Tron base58 address, to discover the wallet id)
 * Optional env:
 *   TURNKEY_API_URL          Turnkey API base (default https://api.turnkey.com)
 *   TURNKEY_WALLET_ADDRESS   Tron base58 address to send from; discovers the wallet id
 *                            and is pinned as the expected resolved address
 *   TURNKEY_PINNED_ADDRESS   assert the wallet resolves to this exact address
 *   TRON_NETWORK             'mainnet' (default) or 'shasta' — selects the default Permit2
 *   PERMIT2_ADDRESS          Permit2 contract to approve, base58 (overrides TRON_NETWORK default)
 *   FEE_LIMIT_SUN            fee_limit in SUN (default 100000000 = 100 TRX)
 */
import { parseUnits } from 'ethers';

import { getOrCreateTurnkeyClient, TurnkeyTronSigner, noopLogger } from '../../src/index';
import { TRON_PERMIT2, tronBase58ToEvmHex } from '../../src/admin';
import { DEFAULT_API_URL, loadScriptEnv, readEnv } from '../_shared';

const MAX_UINT256 = 2n ** 256n - 1n;

/** Find the walletId holding a Tron address — operators usually have the address, not the id. */
async function resolveWalletId(
  client: ReturnType<typeof getOrCreateTurnkeyClient>,
  address: string,
): Promise<string> {
  for (const w of await client.listWallets()) {
    const accounts = await client.listWalletAccounts(w.walletId);
    if (accounts.some((a) => a.address === address)) {
      return w.walletId;
    }
  }
  throw new Error(`no Turnkey wallet in this organization holds address ${address}`);
}

/** POST to a Tron full-node HTTP endpoint and return the parsed JSON. */
async function tronRpc<T>(base: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** left-pad a 32-byte ABI word (64 hex chars). */
const word = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

async function main(): Promise<void> {
  loadScriptEnv();
  const [token, amountArg] = process.argv.slice(2);
  if (!token || !amountArg) {
    console.error('usage: tsx scripts/tvm/approve-permit2.ts <tokenBase58> <amount|max>');
    process.exit(1);
  }

  const base = readEnv('RPC_URL').replace(/\/$/, '');
  const network = process.env.TRON_NETWORK === 'shasta' ? 'shasta' : 'mainnet';
  const permit2 = process.env.PERMIT2_ADDRESS ?? TRON_PERMIT2[network];
  const feeLimit = Number(process.env.FEE_LIMIT_SUN ?? '100000000');

  const client = getOrCreateTurnkeyClient({
    organizationId: readEnv('TURNKEY_ORGANIZATION_ID'),
    apiUrl: process.env.TURNKEY_API_URL ?? DEFAULT_API_URL,
    apiPublicKey: readEnv('TURNKEY_API_PUBLIC_KEY'),
    apiPrivateKey: readEnv('TURNKEY_API_PRIVATE_KEY'),
    concurrencyLimit: 10,
    requestTimeoutMs: 30_000,
  });

  // Accept either the Turnkey walletId directly, or a Tron address to discover it from.
  const walletAddress = process.env.TURNKEY_WALLET_ADDRESS;
  let walletId = process.env.TURNKEY_WALLET_ID;
  if (!walletId) {
    if (!walletAddress) {
      console.error('✗ set TURNKEY_WALLET_ID or TURNKEY_WALLET_ADDRESS');
      process.exit(1);
    }
    walletId = await resolveWalletId(client, walletAddress);
  }
  const signer = new TurnkeyTronSigner(client, {
    walletId,
    log: noopLogger,
    discoveryTimeoutMs: 30_000,
    pinnedAddress: walletAddress ?? process.env.TURNKEY_PINNED_ADDRESS,
  });
  await signer.initialize();
  const from = signer.identity.address;

  // Resolve the approval amount: `max` grants an unlimited allowance, otherwise
  // parse the amount in whole units using the token's own decimals.
  let amount: bigint;
  let amountLabel: string;
  if (amountArg.toLowerCase() === 'max') {
    amount = MAX_UINT256;
    amountLabel = 'max (unlimited)';
  } else {
    const dec = await tronRpc<{ constant_result?: string[] }>(base, '/wallet/triggerconstantcontract', {
      owner_address: from,
      contract_address: token,
      function_selector: 'decimals()',
      parameter: '',
      visible: true,
    });
    const raw = dec.constant_result?.[0];
    if (!raw) throw new Error('could not read token decimals()');
    amount = parseUnits(amountArg, Number(BigInt('0x' + raw)));
    amountLabel = amountArg;
  }

  // TRC-20 approve(spender, amount): the parameter is the ABI encoding of the two
  // args (no selector) — spender as a 32-byte word, then the amount as a 32-byte word.
  const parameter = word(tronBase58ToEvmHex(permit2)) + word(amount.toString(16));

  const built = await tronRpc<{
    result?: { result?: boolean; message?: string };
    transaction?: { txID: string; raw_data_hex: string };
  }>(base, '/wallet/triggersmartcontract', {
    owner_address: from,
    contract_address: token,
    function_selector: 'approve(address,uint256)',
    parameter,
    fee_limit: feeLimit,
    call_value: 0,
    visible: true,
  });
  if (!built.result?.result || !built.transaction) {
    const msg = built.result?.message
      ? Buffer.from(built.result.message, 'hex').toString('utf8')
      : JSON.stringify(built.result);
    throw new Error(`triggersmartcontract failed: ${msg}`);
  }
  const unsigned = built.transaction;

  console.log(`From:    ${from}`);
  console.log(`Approve: ${amountLabel} of TRC-20 ${token} for Permit2 ${permit2}`);
  console.log(`txID:    ${unsigned.txID}  fee_limit ${feeLimit} SUN  (${network})`);

  // The signer sends raw_data_hex to Turnkey (TRANSACTION_TYPE_TRON) and returns the tx
  // with `signature` populated. broadcasttransaction wants the full signed tx object.
  const signed = await signer.signTransaction(unsigned as never);

  const bc = await tronRpc<{ result?: boolean; code?: string; message?: string; txid?: string }>(
    base,
    '/wallet/broadcasttransaction',
    signed,
  );
  if (bc.result !== true) {
    const msg = bc.message ? Buffer.from(bc.message, 'hex').toString('utf8') : bc.code ?? JSON.stringify(bc);
    throw new Error(`broadcast rejected: ${msg}`);
  }
  console.log(`Broadcast: ${unsigned.txID} accepted. Check status with gettransactioninfobyid.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
