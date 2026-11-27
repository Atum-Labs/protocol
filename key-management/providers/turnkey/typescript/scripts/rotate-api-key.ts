/**
 * Rotate a Turnkey API key on an EXISTING user inside a sub-organization, for both the sub-org
 * ROOT user and the non-root machine (agent) user. One script covers both because the mechanics are
 * identical — CREATE_API_KEYS_V2 then DELETE_API_KEYS against a stable userId — and `--target`
 * selects the differences that do matter: which identity is being rotated, and how much the script
 * refuses to do without proof.
 *
 * Rotation is TWO PHASES and the script will not run them together:
 *
 *   --add     mint a keypair and register the public half on the user. The old key keeps working,
 *             so nothing is interrupted. Deploy the new private key, restart the consumer, verify.
 *   --revoke  delete the key(s) named by --key-id. Only after the new key has actually been used.
 *
 * --key-id is MANDATORY on --revoke and nothing is ever inferred. A rule like "delete everything
 * except the key I am stamping with" reads the victim out of the environment instead of the command,
 * so the identical line deletes the old key or the replacement depending on which credential .env
 * happens to hold. The --add phase prints the ready-made revoke command with the ids filled in.
 *
 * There is no single-shot mode on purpose. A sub-org's root credential has no break-glass above it:
 * a parent organization has read-only visibility into its sub-orgs and cannot add users, add keys,
 * or change the root quorum inside one, and even DELETE_SUB_ORGANIZATION has to be initiated from
 * inside. Revoking before the replacement is proven can therefore make a sub-org unreachable.
 *
 * Rotating key material never touches the root quorum, which is defined by userIds and not by keys,
 * so no UPDATE_ROOT_QUORUM is involved. Replacing the root *user* (a new userId) is a different,
 * riskier operation this script does not do.
 *
 * Root quorum, verified live against a 2-of-2 sub-org: a user changing its OWN credentials completes
 * on ONE vote at any threshold, so `--target root` self-rotation needs no approvals ever. Changing
 * ANOTHER user's credentials is gated, so every `--target agent` run on a threshold above 1 comes
 * back CONSENSUS_NEEDED and exits 2 with the activity id and fingerprint to approve. This run prints
 * which case applies before it submits anything.
 *
 * Credentials. Both phases stamp with TURNKEY_SUBORG_ROOT_API_PUBLIC_KEY / _PRIVATE_KEY, the sub-org
 * root key. Root is what can edit the agent user, and for the root user itself the key being rotated
 * is its own.
 *
 * Deleting the key stamping the request is refused and nothing overrides that, so a root --revoke has
 * to run on the NEW key: replace the value of those two vars between the phases. That constraint is
 * the safety property, not an inconvenience — the rotation cannot finish until the replacement has
 * proven it can authorize a root action, so a bad new key fails the rotation instead of locking the
 * sub-org out.
 *
 * --api-public-key-env / --api-private-key-env are optional and only change which var NAMES are read.
 * Useful to keep the old key readable during the overlap, or when one .env holds several sub-orgs.
 *
 * Usage:
 *   # non-root agent key
 *   pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target agent --user-name settler-agent --add
 *   pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target agent --user-name settler-agent \
 *     --revoke --confirm <uuid> --key-id <old-id> [--verify-public-key <new-pub-hex>] [--dry-run]
 *
 *   # sub-org root key (self-rotation)
 *   pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target root --add
 *   # after putting the NEW key into TURNKEY_SUBORG_ROOT_API_*
 *   pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target root --revoke --confirm <uuid> \
 *     --key-id <old-id>
 *
 * The printed/saved private key is shown ONCE. Store it in your secret manager immediately.
 */
import {
  MAX_API_KEYS_PER_USER,
  addApiKeys,
  deleteApiKeys,
  UnsafeRevocationError,
  getRootQuorum,
  getUser,
  isDurableApiKey,
  isExpiredApiKey,
  listPendingActivities,
  listUsers,
  planRevocation,
  type TurnkeyUserSummary,
} from '../src/admin';
import {
  DEFAULT_API_URL,
  activityIdFromError,
  argParser,
  fingerprintFromError,
  generateApiKeyPair,
  isConsensusNeeded,
  loadScriptEnv,
  makeClient,
  readEnv,
  subOrgCreds,
  writeSecretJson,
} from './_shared';
import type { TurnkeyClient } from '../src/client';

type Target = 'root' | 'agent';

async function main() {
  loadScriptEnv();
  const args = argParser();

  const subOrg = args.required('sub-org');
  const target = parseTarget(args.required('target'));
  const add = args.flag('add');
  const revoke = args.flag('revoke');
  if (add === revoke) {
    throw new Error('Pass exactly one phase: --add (mint + register) or --revoke (delete the old key).');
  }
  const apiUrl = args.get('api-url') ?? DEFAULT_API_URL;

  const pubEnv = args.get('api-public-key-env');
  const privEnv = args.get('api-private-key-env');
  if (Boolean(pubEnv) !== Boolean(privEnv)) {
    throw new Error('--api-public-key-env and --api-private-key-env must be given together.');
  }
  // Everything checkable from the argv alone is checked before the first Turnkey call, so a typo
  // fails in a second instead of after two round trips.
  validateSelectorArgs(target, args);
  if (revoke) {
    const confirm = args.required('confirm');
    if (confirm !== subOrg) {
      throw new Error(`--confirm (${confirm}) must exactly equal --sub-org (${subOrg}). Refusing.`);
    }
    // --key-id is mandatory. There is no "delete the old one" shorthand, because any such rule
    // resolves the victim from the environment rather than from the command, so the same line deletes
    // the old key or the replacement depending on which credential .env currently holds.
    if (parseKeyIds(args).length === 0) {
      throw new Error(
        '--revoke requires --key-id <id>[,<id>] naming every key to delete. Run without --revoke, or ' +
          'with --add, to print the current key list with ids. Nothing is ever inferred.',
      );
    }
  }
  const creds =
    pubEnv && privEnv
      ? { apiPublicKey: readEnv(pubEnv), apiPrivateKey: readEnv(privEnv) }
      : subOrgCreds();
  const client = makeClient({ organizationId: subOrg, apiUrl, ...creds });

  // The identity we are stamping with. Everything downstream keys off whether it is the same user
  // we are rotating (self-rotation, the normal root path) or a different one (the agent path).
  const me = await client.whoami();
  if (!me.userId) {
    throw new Error(
      `whoami on ${subOrg} returned no userId, so the stamping identity cannot be established. ` +
        'Check that the credentials belong to a user in this sub-org.',
    );
  }
  const userId = await resolveTargetUser(client, subOrg, target, args, me.userId);
  const selfRotation = userId === me.userId;

  const user = await getUser(client, subOrg, userId);
  console.log(
    `\nsub-org ${subOrg}\ntarget   ${target} → user "${user.userName}" (${user.userId})` +
      `\nstamping as ${selfRotation ? 'this same user (self-rotation)' : `a different user (${me.userId})`}`,
  );
  printKeys(user, creds.apiPublicKey);
  await reportConsensusExpectation(client, subOrg, selfRotation);

  if (add) {
    await runAdd({ client, subOrg, user, args, target, selfRotation });
  } else {
    await runRevoke({ subOrg, user, args, client, stampingPublicKey: creds.apiPublicKey, selfRotation });
  }
}

/**
 * Say up front whether this run will need quorum approvals, and surface anything already pending.
 *
 * A user changing its OWN credentials completes on one vote at any threshold, so self rotation is
 * quorum-independent. Changing another user's credentials is gated, which is every `--target agent`
 * run. Pending activities are worth naming because `get_user` cannot show them: a pending add has not
 * applied, so the user still looks untouched and a second `--add` would queue a duplicate.
 *
 * Best-effort. A quorum read that fails must not block a rotation that would otherwise work.
 */
async function reportConsensusExpectation(
  client: TurnkeyClient,
  subOrg: string,
  selfRotation: boolean,
): Promise<void> {
  let quorum;
  try {
    quorum = await getRootQuorum(client, subOrg);
  } catch (err) {
    console.log(
      `\nCould not read the root quorum (${err instanceof Error ? err.message : err}). Continuing: if ` +
        'the threshold is above 1 this run may come back CONSENSUS_NEEDED instead of completing.',
    );
    return;
  }
  console.log(`root quorum: ${quorum.threshold}-of-${quorum.userIds.length}`);
  if (quorum.threshold > 1) {
    console.log(
      selfRotation
        ? '  self-rotation changes your own credentials, which completes on one vote — no approvals needed.'
        : `  this changes ANOTHER user's credentials, so it needs ${quorum.threshold - 1} more approval(s):` +
          '\n  the run will report PENDING APPROVAL and exit 2. Approve with turnkey:approve-activity.',
    );
  }

  try {
    const pending = await listPendingActivities(client, subOrg);
    if (pending.length > 0) {
      console.log(`\n  ${pending.length} activity(ies) ALREADY waiting on consensus in this sub-org:`);
      for (const a of pending) console.log(`    ${a.id}  ${a.type ?? '(unknown)'}`);
      console.log(
        '  A pending change has not applied yet, so it is invisible in the key list above. Check it is\n' +
          '  not a duplicate of what you are about to submit (pnpm turnkey:approve-activity -- --list).',
      );
    }
  } catch {
    // Non-fatal: this is advisory only.
  }
}

/**
 * Refuse a revoke while an unapplied activity already references this user. Such an activity is
 * invisible to the key-set guards, because it has not taken effect yet, so a revoke that looks safe
 * now can combine with it later into one that never would have been allowed.
 *
 * Matches by looking for the user id anywhere in the pending intent, which over-matches rather than
 * under-matches: intent shapes differ per activity type, and a false refusal costs one `--force` while
 * a missed one costs the credential.
 */
async function refuseIfPendingTouchesUser(
  client: TurnkeyClient,
  subOrg: string,
  userId: string,
  force: boolean,
): Promise<void> {
  let pending;
  try {
    pending = await listPendingActivities(client, subOrg);
  } catch (err) {
    // Cannot confirm the absence of pending work, so say so rather than imply it was checked.
    console.log(
      `\nCould not list pending activities (${err instanceof Error ? err.message : err}). Proceeding ` +
        'without that check: if a revoke on this user is awaiting approval, this one cannot see it.',
    );
    return;
  }
  const touching = pending.filter((a) =>
    JSON.stringify((a as { intent?: unknown }).intent ?? {}).includes(userId),
  );
  if (touching.length === 0) return;

  const list = touching.map((a) => `${a.id} (${a.type ?? 'unknown type'})`).join(', ');
  if (force) {
    console.log(`\n--force: proceeding despite ${touching.length} pending activity(ies) on this user: ${list}`);
    return;
  }
  throw new Error(
    `Refusing: ${touching.length} activity(ies) awaiting approval already reference this user: ${list}. ` +
      'They have not applied, so nothing here can account for them, and approving one after this ' +
      'revoke could leave the user with no working key. Approve or reject them first ' +
      '(pnpm turnkey:approve-activity -- --sub-org ' +
      `${subOrg} --list), or pass --force if you are certain they are unrelated.`,
  );
}

/** `--key-id a,b` → ['a','b']. Parsed in one place so the mandatory-flag check in main and the plan
 * built later can never disagree about what was asked for. */
function parseKeyIds(args: ReturnType<typeof argParser>): string[] {
  return (args.get('key-id') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTarget(raw: string): Target {
  if (raw === 'root' || raw === 'agent') return raw;
  throw new Error(`--target must be "root" or "agent", got "${raw}".`);
}

/** Argv-only half of user selection. `--target root` may omit both selectors (it then means the
 * stamping identity); `--target agent` must name its user, since there is no safe default. */
function validateSelectorArgs(target: Target, args: ReturnType<typeof argParser>): void {
  const byId = args.get('user-id');
  const byName = args.get('user-name');
  if (byId && byName) throw new Error('Pass --user-id or --user-name, not both.');
  if (target === 'agent' && !byId && !byName) {
    throw new Error('--target agent requires --user-name <name> or --user-id <uuid>.');
  }
}

/**
 * `--target root` defaults to the stamping identity, which is what makes root rotation safe: the
 * revoke phase is authorized by the surviving key, so a broken new key cannot get that far.
 * `--target agent` must name its user, and is refused if it resolves to the stamping identity —
 * that combination means someone is about to rotate the root key while believing they are touching
 * the agent's.
 */
async function resolveTargetUser(
  client: TurnkeyClient,
  subOrg: string,
  target: Target,
  args: ReturnType<typeof argParser>,
  meUserId: string,
): Promise<string> {
  // validateSelectorArgs already rejected the impossible argv combinations.
  const explicit = args.get('user-id');
  const userName = args.get('user-name');
  const named = explicit ?? (userName ? await userIdByName(client, subOrg, userName) : undefined);

  if (target === 'root') return named ?? meUserId;

  if (!named) throw new Error('--target agent requires --user-name <name> or --user-id <uuid>.');
  if (named === meUserId) {
    throw new Error(
      `--target agent resolved to ${named}, which is the identity these credentials belong to ` +
        '(the sub-org root user). Refusing: use --target root to rotate the root key.',
    );
  }
  return named;
}

async function userIdByName(
  client: TurnkeyClient,
  subOrg: string,
  userName: string,
): Promise<string> {
  const users = await listUsers(client, subOrg);
  const matches = users.filter((u) => u.userName === userName);
  if (matches.length === 0) {
    const names = users.map((u) => `${u.userName} (${u.userId})`).join(', ') || '(none)';
    throw new Error(`No user named "${userName}" in ${subOrg}. Users: ${names}`);
  }
  if (matches.length > 1) {
    const ids = matches.map((u) => u.userId).join(', ');
    throw new Error(
      `${matches.length} users named "${userName}" in ${subOrg} (${ids}). Disambiguate with --user-id.`,
    );
  }
  return matches[0]!.userId;
}

interface AddCtx {
  readonly client: TurnkeyClient;
  readonly subOrg: string;
  readonly user: TurnkeyUserSummary;
  readonly args: ReturnType<typeof argParser>;
  readonly target: Target;
  readonly selfRotation: boolean;
}

async function runAdd({ client, subOrg, user, args, target, selfRotation }: AddCtx): Promise<void> {
  // Refuse before minting rather than after: a key generated and then rejected by Turnkey is a
  // secret on the operator's terminal that protects nothing.
  if (user.apiKeys.length >= MAX_API_KEYS_PER_USER) {
    throw new Error(
      `User "${user.userName}" already holds ${user.apiKeys.length} API keys, Turnkey's cap is ` +
        `${MAX_API_KEYS_PER_USER}. Revoke a stale key first (--revoke --key-id <id>).`,
    );
  }
  const keyName = args.get('key-name') ?? `${user.userName}-${today()}`;
  if (user.apiKeys.some((k) => k.apiKeyName === keyName)) {
    throw new Error(
      `User "${user.userName}" already has a key named "${keyName}". Pass --key-name <name> so the ` +
        'revoke phase can tell the old key from the new one.',
    );
  }
  const expirationSeconds = args.get('expiration-seconds');
  // A TTL'd root key is a scheduled lockout: once the old key is revoked it becomes the only way into
  // the sub-org, and nothing outside the sub-org can mint a replacement after it lapses.
  if (expirationSeconds && target === 'root') {
    throw new Error(
      '--expiration-seconds is refused for --target root: an expiring root key locks the sub-org out ' +
        'when it lapses, and no parent org can add credentials inside a sub-org to recover it.',
    );
  }
  const outPath = args.get('out') ?? `./${keyName}.apikey.json`;

  const pair = generateApiKeyPair();
  // Persist BEFORE submitting. The activity can complete server-side while the response is lost to a
  // timeout or a dropped connection, and a registered public key whose private half was never written
  // down is a dead slot on the user that only a revoke can clear.
  writeSecretJson(outPath, {
    status: 'SUBMITTED',
    subOrganizationId: subOrg,
    userId: user.userId,
    userName: user.userName,
    apiKey: { name: keyName, ...pair },
  });
  console.log(`\nRegistering new key "${keyName}" on user ${user.userId}…`);

  let apiKeyIds: readonly string[];
  try {
    apiKeyIds = await addApiKeys(client, {
      userId: user.userId,
      apiKeys: [{ apiKeyName: keyName, publicKey: pair.publicKey, ...(expirationSeconds ? { expirationSeconds } : {}) }],
    });
  } catch (err) {
    if (!isConsensusNeeded(err)) {
      // The submit failed, but "failed" here can also mean the activity landed and the response did
      // not come back. The keypair is already on disk, so say where, and say how to tell which
      // happened before anyone re-runs and burns a second key slot.
      console.error(
        `\nThe key may or may not have been registered: a lost response looks like a failure. The ` +
          `generated keypair is in ${outPath}. Check whether "${keyName}" is on user ${user.userId} ` +
          'before re-running, or the retry consumes another of the 10 key slots.',
      );
      throw err;
    }
    // Accepted but waiting on quorum. Persist the generated key now — once approved, the user has a
    // registered public key whose private half exists only in this process.
    const activityId = activityIdFromError(err);
    const fingerprint = fingerprintFromError(err);
    console.error('\n=========================================');
    console.error('PENDING APPROVAL — the request was accepted, not failed. Do NOT re-run blindly.');
    console.error('The sub-org root quorum needs more approvers before the key is registered.');
    if (activityId) console.error(`  activity:    ${activityId}`);
    if (fingerprint) console.error(`  fingerprint: ${fingerprint}`);
    if (activityId) {
      console.error('\nApprove it, stamping with a DIFFERENT root user (the submitter cannot approve):');
      console.error(
        `  pnpm turnkey:approve-activity -- --sub-org ${subOrg} --activity ${activityId} \\` +
          '\n    --api-public-key-env <OTHER_ROOT_PUB_ENV> --api-private-key-env <OTHER_ROOT_PRIV_ENV>',
      );
    }
    console.error('\nGenerated keypair (needed once approved — saved to the out file too):');
    console.error(`  public key:  ${pair.publicKey}`);
    console.error(`  private key: ${pair.privateKey}`);
    console.error('=========================================');
    writeSecretJson(outPath, {
      status: 'PENDING_CONSENSUS',
      activityId,
      subOrganizationId: subOrg,
      userId: user.userId,
      userName: user.userName,
      apiKey: { name: keyName, ...pair },
    });
    process.exit(2);
  }

  console.log('\n=========================================');
  console.log(`New API key registered on "${user.userName}" (the old key still works):`);
  console.log(`  apiKeyId:    ${apiKeyIds.join(', ')}`);
  console.log(`  apiKeyName:  ${keyName}`);
  console.log('\nKey material (shown once):');
  console.log(`  public key:  ${pair.publicKey}`);
  console.log(`  private key: ${pair.privateKey}`);
  console.log('=========================================');

  writeSecretJson(outPath, {
    subOrganizationId: subOrg,
    userId: user.userId,
    userName: user.userName,
    apiKeyIds,
    apiKey: { name: keyName, ...pair },
  });

  // `user` is the pre-add state, so these are exactly the keys this rotation replaces. Printing the
  // ids is what keeps the mandatory --key-id from being a chore: the revoke line below is complete.
  const supersededIds = user.apiKeys.map((k) => k.apiKeyId).join(',');
  const supersededNames = user.apiKeys.map((k) => `"${k.apiKeyName}"`).join(', ') || '(none)';

  console.log('\nNext, in order:');
  console.log('  1. Put the private key in your secret manager and cut the consumer over to it.');
  if (target === 'root') {
    console.log('  2. Replace TURNKEY_SUBORG_ROOT_API_PUBLIC_KEY / _PRIVATE_KEY with the new key.');
    console.log('     Required: revoking the key you stamp with is refused, so the revoke below must');
    console.log('     run on the new key. That call succeeding is the proof the new key works.');
    console.log(
      `       npx tsx scripts/rotate-api-key.ts --sub-org ${subOrg} --target root --revoke --confirm ${subOrg} \\` +
        `\n         --key-id ${supersededIds} --dry-run`,
    );
  } else {
    console.log('  2. Restart the agent on the new key and confirm it signs:');
    console.log(
      '       pnpm turnkey:test-policies -- --config <yaml> --sub-org ' +
        `${subOrg} --evm-address <0x…>  # with the NEW agent key in the env`,
    );
    console.log('  3. Only then revoke the old key:');
    console.log(
      `       npx tsx scripts/rotate-api-key.ts --sub-org ${subOrg} --target agent --user-id ${user.userId} \\` +
        `\n         --revoke --confirm ${subOrg} --key-id ${supersededIds} \\` +
        `\n         --verify-public-key ${pair.publicKey} --dry-run`,
    );
  }
  console.log(`\n  --key-id above names the key(s) this replaces: ${supersededNames}.`);
  console.log('  Drop --dry-run once the printed revoke list is what you expect.');
  if (!selfRotation && target === 'root') {
    console.log(
      '\nNote: you rotated another user\'s root key, so this script cannot prove the new key works. ' +
        'Have its holder authorize something with it before you revoke.',
    );
  }
}

interface RevokeCtx {
  readonly subOrg: string;
  readonly user: TurnkeyUserSummary;
  readonly args: ReturnType<typeof argParser>;
  readonly client: TurnkeyClient;
  readonly stampingPublicKey: string;
  readonly selfRotation: boolean;
}

async function runRevoke({
  subOrg,
  user,
  args,
  client,
  stampingPublicKey,
  selfRotation,
}: RevokeCtx): Promise<void> {
  // --confirm was matched against --sub-org in main, before any Turnkey call.
  const dryRun = args.flag('dry-run');
  const force = args.flag('force');
  const explicitIds = parseKeyIds(args);
  const verifyPublicKey = args.get('verify-public-key');

  // A pending activity has not applied, so it is invisible to every guard here: they reason about the
  // key set as it stands. Approve a pending revoke after this one lands and the two combine into a
  // strip that neither would have allowed alone. The window is as long as the quorum takes, so this is
  // a refusal rather than a warning.
  await refuseIfPendingTouchesUser(client, subOrg, user.userId, force);

  let plan;
  try {
    plan = planRevocation({
      user,
      stampingPublicKey,
      selfRotation,
      explicitIds,
      ...(verifyPublicKey ? { verifyPublicKey } : {}),
      force,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    if (err instanceof UnsafeRevocationError) throw new Error(`Refusing: ${err.message}`);
    throw err;
  }

  console.log(`\n${plan.targets.length} key(s) to revoke from "${user.userName}":`);
  for (const k of plan.targets) {
    console.log(`  ${k.apiKeyId}  "${k.apiKeyName}"  ${k.credential?.publicKey ?? '(no public key)'}`);
  }
  console.log(
    `Credentials left afterwards: ${plan.survivors.length} API key(s) of which ` +
      `${plan.durableSurvivors.length} working without a TTL, ${user.authenticators.length} authenticator(s).`,
  );
  const targets = plan.targets;

  if (dryRun) {
    console.log('\nDry run — nothing revoked. Re-run without --dry-run to delete the above.');
    return;
  }

  // Re-read and re-plan against fresh state immediately before deleting. The plan above was built
  // from a snapshot taken several calls ago, and the guards only hold for the key set they saw. Two
  // operators revoking concurrently, each stamping with a key the other is deleting, would each pass
  // their own guards and together strip the user. This makes the loser of that race fail instead.
  const fresh = await getUser(client, subOrg, user.userId);
  try {
    const recheck = planRevocation({
      user: fresh,
      stampingPublicKey,
      selfRotation,
      explicitIds: targets.map((k) => k.apiKeyId),
      ...(verifyPublicKey ? { verifyPublicKey } : {}),
      force,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (recheck.targets.length !== targets.length) {
      throw new Error(
        `Refusing: the key set changed between the preview and now (${targets.length} target(s) ` +
          `became ${recheck.targets.length}). Re-run to see the current state.`,
      );
    }
  } catch (err) {
    if (err instanceof UnsafeRevocationError) {
      throw new Error(
        `Refusing: the key set changed between the preview and now, and the revoke is no longer ` +
          `safe: ${err.message}`,
      );
    }
    throw err;
  }

  try {
    const deleted = await deleteApiKeys(client, {
      userId: user.userId,
      apiKeyIds: targets.map((k) => k.apiKeyId),
    });
    console.log(`\nRevoked ${deleted.length || targets.length} key(s). Rotation complete.`);
  } catch (err) {
    if (isConsensusNeeded(err)) {
      const activityId = activityIdFromError(err);
      const fingerprint = fingerprintFromError(err);
      console.error('\nPENDING APPROVAL — the revoke was accepted, not failed. Do NOT re-run.');
      console.error('The old key stays LIVE until the quorum approves.');
      if (activityId) console.error(`  activity:    ${activityId}`);
      if (fingerprint) console.error(`  fingerprint: ${fingerprint}`);
      if (activityId) {
        console.error(
          `\n  pnpm turnkey:approve-activity -- --sub-org ${subOrg} --activity ${activityId} \\` +
            '\n    --api-public-key-env <OTHER_ROOT_PUB_ENV> --api-private-key-env <OTHER_ROOT_PRIV_ENV>',
        );
      }
      // The guards ran against the key set as it is NOW. Approval can land much later, and Turnkey
      // re-checks the intent, not these guards, so the state they cleared may no longer hold.
      console.error(
        '\nWhile this waits, do not revoke anything else on this user: the guards that cleared this\n' +
          'request were evaluated against the current key set, and approval applies the deletion\n' +
          'whenever it arrives.',
      );
      process.exit(2);
    }
    throw err;
  }

  console.log('Remove the old private key from your secret manager and delete any local *.apikey.json.');
}

function printKeys(user: TurnkeyUserSummary, stampingPublicKey: string): void {
  const stampingPub = stampingPublicKey.toLowerCase();
  const nowSeconds = Math.floor(Date.now() / 1000);
  console.log(`\nCurrent credentials on "${user.userName}":`);
  for (const k of user.apiKeys) {
    const isStamping = k.credential?.publicKey?.toLowerCase() === stampingPub;
    // Expiry is shown because it decides whether a key counts as a way back in after a revoke.
    const expiry = isDurableApiKey(k)
      ? ''
      : isExpiredApiKey(k, nowSeconds)
        ? `  EXPIRED (ttl ${k.expirationSeconds}s)`
        : `  ttl=${k.expirationSeconds}s from creation`;
    console.log(
      `  ${k.apiKeyId}  "${k.apiKeyName}"${expiry}${isStamping ? '  ← stamping this request' : ''}`,
    );
  }
  if (user.apiKeys.length === 0) console.log('  (no API keys)');
  console.log(`  authenticators: ${user.authenticators.length}`);
}

/** yyyymmdd, used to make the default key name self-dating so two rotations never collide. */
function today(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

main().catch((err) => {
  console.error('rotate-api-key failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
