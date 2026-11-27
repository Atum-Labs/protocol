/**
 * READ-ONLY: list the server-side policies applied to a sub-organization. Makes no changes.
 * Use it to verify what apply-policies actually pushed (e.g. that the EVM `allowedTo` allows exist),
 * and to compare a live policy's condition against what a test expects.
 *
 * Auth: the sub-org's agent (non-root) key by default (TURNKEY_SUBORG_USER_API_*), since that is
 * usually the key present on a test machine. Override the var names with --api-public-key-env /
 * --api-private-key-env (e.g. to read with the sub-org root key) if the agent key lacks read access.
 *
 * Usage:
 *   pnpm turnkey:list-policies -- --sub-org <sub-org-uuid> [--allow-only] [--grep <substr>]
 */
import { listPolicies } from '../src/admin';
import {
  DEFAULT_API_URL,
  agentCreds,
  argParser,
  loadScriptEnv,
  makeClient,
  readEnv,
} from './_shared';

async function main() {
  loadScriptEnv();
  const args = argParser();
  const subOrg = args.required('sub-org');
  const allowOnly = args.flag('allow-only');
  const grep = args.get('grep')?.toLowerCase();

  const pubEnv = args.get('api-public-key-env');
  const privEnv = args.get('api-private-key-env');
  const creds =
    pubEnv && privEnv
      ? { apiPublicKey: readEnv(pubEnv), apiPrivateKey: readEnv(privEnv) }
      : agentCreds();

  const client = makeClient({
    organizationId: subOrg,
    apiUrl: args.get('api-url') ?? DEFAULT_API_URL,
    ...creds,
  });

  const policies = await listPolicies(client, subOrg);
  const shown = policies.filter(
    (p) =>
      (!allowOnly || p.effect === 'EFFECT_ALLOW') &&
      (!grep || `${p.policyName} ${p.condition}`.toLowerCase().includes(grep)),
  );

  console.log(
    `\n${policies.length} policies on ${subOrg}` +
      (shown.length !== policies.length ? ` (${shown.length} shown)` : '') +
      '\n',
  );
  for (const p of shown) {
    console.log(`[${p.effect}] ${p.policyName}`);
    if (p.condition) console.log(`    ${p.condition}`);
  }
}

main().catch((err) => {
  console.error('list-policies failed:', err);
  process.exit(1);
});
