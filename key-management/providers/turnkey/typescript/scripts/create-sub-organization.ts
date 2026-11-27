/**
 * Create a new Turnkey sub-organization with an inline wallet (EVM + Tron + Solana accounts) and
 * one root user whose root API keypair is generated locally. Prints and saves the values you need
 * downstream: the sub-organization ID, the wallet ID, the three chain addresses, and the root
 * user's API keypair (root keys).
 *
 * Run with PARENT-org root credentials (env: TURNKEY_PARENT_ORG_ID, TURNKEY_PARENT_API_PUBLIC_KEY,
 * TURNKEY_PARENT_API_PRIVATE_KEY). The wallet must be created inline here — the parent API key has
 * no membership inside the fresh sub-org, so a follow-up CREATE_WALLET would fail auth.
 *
 * The `--name` is passed to Turnkey verbatim. There are NO name restrictions imposed by this
 * script; use whatever naming your deployment wants (e.g. "settler-testnet", "sender-mainnet").
 *
 * Usage:
 *   pnpm turnkey:create-sub-org -- \
 *     --name "settler-testnet" \
 *     [--root-user-name ops-root] [--root-user-email root@example.com] \
 *     [--wallet-name settler-wallet] \
 *     [--parent-org <uuid>] [--api-url https://api.turnkey.com] \
 *     [--out ./settler-testnet.suborg.json]
 *
 * This is a run-once-per-sub-org operation. It does NOT check for an existing sub-org of the same
 * name — running it twice creates two sub-orgs.
 */
import { createSubOrganization } from '../src/admin';
import {
  DEFAULT_API_URL,
  activityIdFromError,
  argParser,
  generateApiKeyPair,
  isConsensusNeeded,
  loadScriptEnv,
  makeClient,
  parentCreds,
  writeSecretJson,
} from './_shared';

// Default BIP-44 derivation: EVM (secp256k1), Tron (secp256k1, SLIP-44 195), Solana (Ed25519).
// One seed, three accounts — same layout the settler wallet uses in production.
const WALLET_ACCOUNTS = [
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

async function main() {
  loadScriptEnv();
  const args = argParser();

  const name = args.required('name'); // passed to Turnkey verbatim — no restrictions
  const rootUserName = args.get('root-user-name') ?? 'root-user';
  const rootUserEmail = args.get('root-user-email');
  const walletName = args.get('wallet-name') ?? `${name}-wallet`;
  const apiUrl = args.get('api-url') ?? DEFAULT_API_URL;
  const outPath = args.get('out') ?? `./${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.suborg.json`;

  const parent = parentCreds(args.get('parent-org'));
  const client = makeClient({ ...parent, apiUrl });

  // Root keys: generated locally. Only the public key is registered with Turnkey; the private
  // key is the root credential for this sub-org and is printed + saved below.
  const rootKey = generateApiKeyPair();

  console.log(`Creating sub-organization "${name}" with an inline wallet…`);
  let result;
  try {
    result = await createSubOrganization(client, {
      subOrganizationName: name,
      rootUsers: [
        {
          userName: rootUserName,
          ...(rootUserEmail ? { userEmail: rootUserEmail } : {}),
          apiKeys: [{ apiKeyName: `${rootUserName}-root`, publicKey: rootKey.publicKey }],
        },
      ],
      rootQuorumThreshold: 1,
      wallet: { walletName, accounts: WALLET_ACCOUNTS },
    });
  } catch (err) {
    if (!isConsensusNeeded(err)) throw err;
    // Not a failure: the parent org's root quorum needs more approvers, so the activity is pending.
    // The root private key we generated only exists here, so persist it now — otherwise approving
    // the pending activity yields a sub-org whose root user has an unusable (unknown-private-key) key.
    const activityId = activityIdFromError(err);
    console.error('\n=========================================');
    console.error('PENDING APPROVAL — the request was accepted, not failed.');
    console.error("The parent org's root quorum needs more approvers before the sub-org is created.");
    if (activityId) console.error(`  activity to approve: ${activityId}`);
    console.error('Approve it in the Turnkey dashboard (Activities) with the other root user(s), or');
    console.error('lower the parent root quorum to 1. Do NOT re-run blindly — that queues another one.');
    console.error('\nGenerated ROOT keypair (needed once the sub-org exists — saved to the out file too):');
    console.error(`  public key:  ${rootKey.publicKey}`);
    console.error(`  private key: ${rootKey.privateKey}`);
    console.error('=========================================');
    writeSecretJson(outPath, {
      status: 'PENDING_CONSENSUS',
      activityId,
      subOrganizationName: name,
      rootUser: { userName: rootUserName, apiKey: { name: `${rootUserName}-root`, ...rootKey } },
    });
    process.exit(2);
  }

  if (!result.wallet) {
    throw new Error('Turnkey did not return a wallet in the sub-org creation response.');
  }
  const [evm, tron, solana] = result.wallet.addresses;

  const record = {
    subOrganizationName: name,
    subOrganizationId: result.subOrganizationId,
    walletId: result.wallet.walletId,
    addresses: { evm, tron, solana },
    rootUser: {
      userName: rootUserName,
      apiKey: { name: `${rootUserName}-root`, ...rootKey },
    },
  };

  console.log('\n=========================================');
  console.log('Sub-organization created. Relevant data:');
  console.log(`  subOrganizationId: ${record.subOrganizationId}`);
  console.log(`  walletId:          ${record.walletId}`);
  console.log(`  EVM address:       ${evm}`);
  console.log(`  Tron address:      ${tron}`);
  console.log(`  Solana address:    ${solana}`);
  console.log('\nRoot user (root quorum 1-of-1, scoped to this sub-org):');
  console.log(`  userName:    ${rootUserName}`);
  console.log(`  public key:  ${rootKey.publicKey}`);
  console.log(`  private key: ${rootKey.privateKey}`);
  console.log('=========================================');

  writeSecretJson(outPath, record);
}

main().catch((err) => {
  console.error('create-sub-organization failed:', err);
  process.exit(1);
});
