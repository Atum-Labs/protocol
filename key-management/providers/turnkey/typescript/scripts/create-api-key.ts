/**
 * Create a non-human ("machine") API-key user inside an EXISTING sub-organization and print its
 * freshly generated P-256 API keypair. This is the credential a settler or sender agent process
 * authenticates with at runtime — it has an API key only (no passkey / human authenticator), so
 * it can sign unattended but cannot log into the Turnkey console.
 *
 * The key has no expiry. To replace it later, use rotate-api-key.ts, which swaps the key on this
 * same user. Re-running this script creates a SECOND user instead, which is not a rotation.
 *
 * Run with the SUB-ORG root credentials (TURNKEY_SUBORG_ROOT_API_PUBLIC_KEY / _PRIVATE_KEY), the root
 * user created by create-sub-org. It has authority inside the sub-org to add this machine user.
 *
 * Usage:
 *   pnpm turnkey:create-api-key -- \
 *     --sub-org <sub-org-uuid> \
 *     --user-name <name> \
 *     [--api-url https://api.turnkey.com] \
 *     [--out ./<user-name>.apikey.json]
 *
 * The printed/saved private key is shown ONCE. Store it in your secret manager immediately.
 */
import { provisionAgentUser } from '../src/admin';
import {
  DEFAULT_API_URL,
  activityIdFromError,
  argParser,
  generateApiKeyPair,
  isConsensusNeeded,
  loadScriptEnv,
  makeClient,
  subOrgCreds,
  writeSecretJson,
} from './_shared';

async function main() {
  loadScriptEnv();
  const args = argParser();

  const subOrg = args.required('sub-org');
  // No default: a forgotten flag must not create a second user under the agent's name.
  const userName = args.required('user-name');
  const apiUrl = args.get('api-url') ?? DEFAULT_API_URL;
  const outPath = args.get('out') ?? `./${userName}.apikey.json`;

  // Authenticate with the sub-org's own root key (created by create-sub-org), targeting the sub-org.
  const client = makeClient({ organizationId: subOrg, apiUrl, ...subOrgCreds() });

  const apiKey = generateApiKeyPair();

  console.log(`Creating machine API user "${userName}" in sub-org ${subOrg}…`);
  let provisioned;
  try {
    provisioned = await provisionAgentUser(client, {
      subOrganizationId: subOrg,
      userName,
      apiPublicKey: apiKey.publicKey,
      apiKeyName: 'primary',
    });
  } catch (err) {
    if (!isConsensusNeeded(err)) throw err;
    // Pending quorum approval, not a failure. Persist the generated key now so it is not lost while
    // the activity waits — otherwise the approved user would have a key with no known private half.
    const activityId = activityIdFromError(err);
    console.error('\n=========================================');
    console.error('PENDING APPROVAL — the request was accepted, not failed.');
    console.error('The org root quorum needs more approvers before the API user is created.');
    if (activityId) console.error(`  activity to approve: ${activityId}`);
    console.error('Approve it in the Turnkey dashboard, or lower the quorum to 1. Do NOT re-run blindly.');
    console.error('\nGenerated API keypair (needed once approved — saved to the out file too):');
    console.error(`  public key:  ${apiKey.publicKey}`);
    console.error(`  private key: ${apiKey.privateKey}`);
    console.error('=========================================');
    writeSecretJson(outPath, {
      status: 'PENDING_CONSENSUS',
      activityId,
      subOrganizationId: subOrg,
      userName,
      apiKey: { name: 'primary', ...apiKey },
    });
    process.exit(2);
  }

  const record = {
    subOrganizationId: subOrg,
    userId: provisioned.userId,
    apiKeyIds: provisioned.apiKeyIds,
    apiKey: { name: 'primary', ...apiKey },
  };

  console.log('\n=========================================');
  console.log('Machine API user created:');
  console.log(`  userId:      ${provisioned.userId}`);
  console.log('\nAPI key (this is shown once):');
  console.log(`  public key:  ${apiKey.publicKey}`);
  console.log(`  private key: ${apiKey.privateKey}`);
  console.log('=========================================');

  writeSecretJson(outPath, record);
}

main().catch((err) => {
  console.error('create-api-key failed:', err);
  process.exit(1);
});
