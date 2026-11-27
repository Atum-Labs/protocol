/**
 * Live policy-enforcement test. Sends real sign requests to Turnkey using the AGENT (non-root)
 * credentials and checks that each disallowed operation is rejected by the policy engine and each
 * allowed one succeeds. Signatures from positive controls are discarded — nothing is broadcast, so
 * there are no on-chain side effects.
 *
 * It doubles as a misconfiguration detector: the agent credentials must NOT be root (root bypasses
 * all policies), so if root creds were installed by mistake every "expect DENY" case reports ALLOW.
 *
 * Inputs come from the same YAML config `apply-policies` uses (settler, sender or verifier) plus flags. The
 * config's `type` selects the matrix. Run this as the LAST provisioning step, after apply-policies.
 *
 * Usage:
 *   pnpm turnkey:test-policies -- \
 *     --config ./scripts/config/settler-mainnet.yaml \
 *     --suborg-file ./settler-mainnet.suborg.json \      # or --sub-org + --evm/-tron/-solana-address
 *     [--solana-rpc <url>] [--tron-fullhost <url>] [--tron-token <base58>] [--wallet-id <uuid>] [--dry-run]
 *
 * Credentials come from TURNKEY_SUBORG_USER_API_PUBLIC_KEY / TURNKEY_SUBORG_USER_API_PRIVATE_KEY, the sub-org's
 * NON-ROOT agent key (root would bypass the policies under test). Override the var names with
 * --api-public-key-env / --api-private-key-env.
 *
 * --dry-run prints the planned test matrix (names + expected outcomes) WITHOUT submitting anything,
 * so you can review coverage offline. Building Tron/Solana txs needs the respective RPC at run time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { classifyError } from './classify-error';
import { ethers } from 'ethers';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { TronWeb } from 'tronweb';

import { buildEscrowDestination } from '@atum-labs/payment-request-sender-auth';

import {
  EVM_PERMIT2,
  SETTLER_IDENTITY_VERIFYING_CONTRACT,
  TRON_PERMIT2,
  parseCowswapHook,
  selectorAllowedFor,
  toTronEvmHex,
  tronTip712ChainId,
} from '../src/admin';
import type { TurnkeyAllowlistPolicy } from '../src/admin';
import type { TurnkeyClient } from '../src/client';
import { DEFAULT_API_URL, agentCreds, argParser, loadScriptEnv, makeClient, readEnv } from './_shared';
import { assertAuthenticatedAs, cowswapHookCases, fencedUserFor } from './cowswap-hook-cases';
import { stellarCases } from './stellar-cases';
import { verifierCases } from './verifier-cases';

interface TestSpec {
  name: string;
  /**
   * ALLOW / DENY are policy outcomes. REJECTED is a refusal by the API before any policy ran (HTTP
   * 400 or 404) rather than a policy decision, used where the safety of a broad ALLOW rests on Turnkey refusing
   * a pairing outright. Those are security controls owned by a third party with no documented
   * contract, so they are asserted here rather than left to a manual probe.
   */
  expect: 'DENY' | 'ALLOW' | 'REJECTED' | 'REFUSED';
  run: () => Promise<unknown>;
}
interface TestResult extends Omit<TestSpec, 'run'> {
  actual: 'DENY' | 'ALLOW' | 'ERROR' | 'REJECTED';
  detail: string;
  pass: boolean;
}

// ── config shape (subset we read; mirrors apply-policies) ────────────────────
interface ChainCfg {
  kind: 'evm' | 'tron' | 'solana' | 'stellar';
  chainId: string;
}
interface Cfg {
  type: 'settler' | 'sender' | 'verifier';
  chains: Record<string, ChainCfg>;
  allowlists?: Record<
    string,
    {
      allowedTo?: string[];
      allowedSelectors?: string[];
      allowedSelectorsByTo?: Record<string, string[] | 'any'>;
      allowedPrograms?: string[];
    }
  >;
  transferWithAuthorizationTokens?: Record<string, string[]>;
  approveDeny?: {
    evm?: Record<string, { tokenContractsHex: string[]; allowedSpendersHex: string[] }>;
    tron?: Record<string, { tokenContractsBase58: string[]; allowedSpendersHex: string[] }>;
  };
  extras?: {
    allowedErc20Recipients?: Record<string, string[]>;
    evmCaps?: Record<string, { maxGasLimit?: number; maxFeePerGasWei?: string }>;
  };
  senderExtras?: {
    network?: 'mainnet' | 'testnet';
    allowedTokens?: Record<string, string[]>;
    escrows?: Record<string, string[]>;
    reservers?: Record<string, string[]>;
    releasers?: Record<string, string[]>;
    /** As authored: the two CAIP components, joined here the same way apply-policies joins them. */
    allowedDestinations?: Record<string, { asset: string; account: string }[]>;
    permit2?: string;
    solanaEscrowProgramId?: string | string[];
    evmCaps?: Record<string, { maxGasLimit?: number; maxFeePerGasWei?: string }>;
    solanaMaxNativeValue?: string;
    stellarSigners?: Record<string, string[]>;
  };
  /** Settler configs: the settler's Stellar account(s) per Stellar chain key. */
  stellarSigners?: Record<string, string[]>;
  verifierExtras?: {
    escrows?: Record<string, string[]>;
    releasers?: Record<string, string[]>;
    solanaSigners?: Record<string, string[]>;
    stellarSigners?: Record<string, string[]>;
  };
  /** The fenced CoW order signers and their pairs (settler configs); read by `--as <userName>`. */
  cowswapHook?: {
    users: Array<{ userId: string; userName: string }>;
    chains: Record<string, { pairs: Array<{ sell: string; buy: string }> }>;
  };
}

async function runTest(spec: TestSpec): Promise<TestResult> {
  try {
    await spec.run();
    return { name: spec.name, expect: spec.expect, actual: 'ALLOW', detail: 'signed', pass: spec.expect === 'ALLOW' };
  } catch (err) {
    const { actual, detail } = classifyError(err);
    // REFUSED passes on either refusal, for a request that policy or the API may turn away first.
    const pass = spec.expect === 'REFUSED' ? actual === 'DENY' || actual === 'REJECTED' : actual === spec.expect;
    return { name: spec.name, expect: spec.expect, actual, detail, pass };
  }
}

const firstChain = (cfg: Cfg, kind: ChainCfg['kind']): [string, ChainCfg] | undefined =>
  Object.entries(cfg.chains).find(([, c]) => c.kind === kind);

const numericChainId = (chainId: string): number => parseInt(chainId.split(':')[1]!, 10);

/** Any configured EVM chain id, for a probe whose domain only has to be well formed. Falls back to
 * 1 for a config with no EVM chain, since the probe tests the request shape, not a policy rule. */
const evmChainIdForProbe = (cfg: Cfg): number => {
  const evm = firstChain(cfg, 'evm');
  return evm ? numericChainId(evm[1].chainId) : 1;
};

/** Build a deterministic, syntactically valid EIP-1559 tx (unsigned, hex, no 0x). Nonce/gas are
 * arbitrary — the policy engine only inspects the fields it is configured to check. */
function evmTx(opts: {
  to: string;
  value: bigint;
  chainId: number;
  data?: string;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
}): string {
  return ethers.Transaction.from({
    to: opts.to,
    value: opts.value,
    data: opts.data ?? '0x',
    nonce: 0,
    chainId: opts.chainId,
    gasLimit: opts.gasLimit ?? 100_000n,
    maxFeePerGas: opts.maxFeePerGas ?? 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    type: 2,
  }).unsignedSerialized.slice(2);
}

const TRANSFER_SELECTOR = '0xa9059cbb';
const APPROVE_SELECTOR = '0x095ea7b3';
const INCREASE_ALLOWANCE_SELECTOR = '0x39509351';
const erc20Call = (selector: string) => (address: string, amount: bigint): string =>
  selector +
  address.toLowerCase().replace(/^0x/, '').padStart(64, '0') +
  amount.toString(16).padStart(64, '0');
const erc20Transfer = erc20Call(TRANSFER_SELECTOR);
const erc20Approve = erc20Call(APPROVE_SELECTOR);
const erc20IncreaseAllowance = erc20Call(INCREASE_ALLOWANCE_SELECTOR);
/** A selector no settler contract exposes, so only a missing ALLOW can deny it. */
const UNLISTED_SELECTOR = '0x12345678';
/** A call with `selector` and two zero words of arguments; policies read only the selector. */
const callWith = (selector: string): string => selector.toLowerCase() + '00'.repeat(64);

/** A chain's allowlist entry in the shape the policy helpers read. */
function allowlistPolicy(entry: NonNullable<Cfg['allowlists']>[string] | undefined): TurnkeyAllowlistPolicy {
  return { requireChainIdMatch: true, maxNativeValue: '0', ...entry } as TurnkeyAllowlistPolicy;
}

/** The selectors `allowedSelectorsByTo` binds `to` to, or undefined when it is unbound or 'any'. */
function boundSelectors(
  entry: NonNullable<Cfg['allowlists']>[string] | undefined,
  to: string,
  chain: 'evm' | 'tron',
): string[] | undefined {
  const same = (a: string) => (chain === 'evm' ? a.toLowerCase() === to.toLowerCase() : a === to);
  const found = Object.entries(entry?.allowedSelectorsByTo ?? {}).find(([k]) => same(k))?.[1];
  return Array.isArray(found) ? found : undefined;
}

// Permit deadline for every probe payload, dated in the past. No policy condition binds `deadline`,
// so the verdicts are identical either way, and any signature the matrix produces is already expired.
const EXPIRED_PERMIT_DEADLINE = 1_000_000_000n;

/** Member form of a configured address, tolerating either spelling, for comparisons only. */
function toTronEvmHexSafe(address: string): string {
  try {
    return toTronEvmHex(address);
  } catch {
    return address.toLowerCase();
  }
}

async function main() {
  loadScriptEnv();
  const args = argParser();

  const cfg = parseYaml(fs.readFileSync(path.resolve(args.required('config')), 'utf8')) as Cfg;
  if (cfg.type !== 'settler' && cfg.type !== 'sender' && cfg.type !== 'verifier') {
    throw new Error(`config.type must be "settler", "sender" or "verifier"; got ${JSON.stringify((cfg as { type?: unknown }).type)}`);
  }
  const isSender = cfg.type === 'sender';
  const isVerifier = cfg.type === 'verifier';
  const dryRun = args.flag('dry-run');
  const apiUrl = args.get('api-url') ?? DEFAULT_API_URL;
  const solanaRpc = args.get('solana-rpc') ?? 'https://api.mainnet-beta.solana.com';
  const tronHost = args.get('tron-fullhost') ?? 'https://api.trongrid.io';
  const tronToken = args.get('tron-token'); // optional: our configs carry no Tron token contract
  // Only shapes the management-surface probes. The activity must be denied before Turnkey ever
  // resolves the id, so a placeholder still proves the point.
  const walletId = args.get('wallet-id') ?? '00000000-0000-0000-0000-000000000000';

  // Addresses + sub-org: from a create-sub-org output file or explicit flags. No live wallet query.
  const fileArg = args.get('suborg-file');
  const file = fileArg
    ? (JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8')) as {
        subOrganizationId?: string;
        addresses?: { evm?: string; tron?: string; solana?: string; stellar?: string };
      })
    : undefined;
  const subOrg = args.get('sub-org') ?? file?.subOrganizationId;
  const evmAddr = args.get('evm-address') ?? file?.addresses?.evm;
  const tronAddr = args.get('tron-address') ?? file?.addresses?.tron;
  // The verifier's ed25519 allow is scoped to its configured Solana account, so its rows sign with
  // that account rather than whatever the sub-org file names.
  const verifierSolana = Object.values(cfg.verifierExtras?.solanaSigners ?? {}).flat()[0];
  const solAddr =
    args.get('solana-address') ?? (cfg.type === 'verifier' ? verifierSolana : undefined) ?? file?.addresses?.solana;
  // The Stellar allow is scoped to the configured account(s), so the rows sign with that account
  // unless a flag or the sub-org file names another.
  const configuredStellar = (
    cfg.type === 'verifier'
      ? Object.values(cfg.verifierExtras?.stellarSigners ?? {})
      : cfg.type === 'sender'
        ? Object.values(cfg.senderExtras?.stellarSigners ?? {})
        : Object.values(cfg.stellarSigners ?? {})
  ).flat()[0];
  const stellarAddr = args.get('stellar-address') ?? configuredStellar ?? file?.addresses?.stellar;
  if (!subOrg) throw new Error('Missing sub-org (pass --sub-org or --suborg-file).');
  if (!evmAddr) throw new Error('Missing EVM address (pass --evm-address or --suborg-file).');

  // Credentials must be the AGENT (non-root) key — root bypasses policies and would make every
  // "expect DENY" pass. Defaults to TURNKEY_SUBORG_USER_API_*; override the var names with the flags if
  // you keep several agent keys in one .env.
  //
  // Built only for a live run. A dry run just prints the matrix, so requiring credentials for it
  // would defeat the offline review the flag exists for. Test closures read `client` when they
  // run, which is after the dry-run branch has returned.
  let client!: TurnkeyClient;
  if (!dryRun) {
    const pubEnv = args.get('api-public-key-env');
    const privEnv = args.get('api-private-key-env');
    const apiPublicKey = pubEnv ? readEnv(pubEnv) : agentCreds().apiPublicKey;
    const apiPrivateKey = privEnv ? readEnv(privEnv) : agentCreds().apiPrivateKey;
    client = makeClient({ organizationId: subOrg, apiUrl, apiPublicKey, apiPrivateKey });
  }

  const tests: TestSpec[] = [];
  const note = (m: string) => console.log(`  (skip) ${m}`);

  // --as <userName>: one fenced user's matrix (for example cowswap-hook), run with that user's own
  // API key against the settler config that lists it under `cowswapHook.users`. It replaces the
  // settler matrix for this run; run it once per listed user.
  const asRole = args.get('as');
  // argParser reads only `--as <value>`; a bare `--as` or `--as=…` would otherwise fall through to
  // the settler matrix with the hook's key.
  if (asRole === undefined && process.argv.some((a) => a === '--as' || a.startsWith('--as='))) {
    throw new Error('--as takes a value as a separate argument: --as cowswap-hook');
  }
  if (asRole !== undefined) {
    if (cfg.type !== 'settler') throw new Error(`--as ${asRole} needs a settler config.`);
    const hook = parseCowswapHook(
      cfg.cowswapHook,
      Object.entries(cfg.chains).map(([key, c]) => ({ key, kind: c.kind, chainId: c.chainId })),
    );
    if (!hook) throw new Error(`--as ${asRole} needs a \`cowswapHook\` block in the config.`);
    const fencedUser = fencedUserFor(hook.users, asRole);
    const hookChains = hook.chains.map((c) => ({
      chainId: numericChainId(c.chain.chainId),
      pairs: c.pairs,
    }));
    const hookChainIds = hookChains.map((c) => c.chainId);
    const otherEvm = Object.values(cfg.chains)
      .filter((c) => c.kind === 'evm')
      .map((c) => numericChainId(c.chainId))
      .find((id) => !hookChainIds.includes(id));
    // Any chain the hook is not listed for will do.
    const unlistedChainId =
      otherEvm ?? [1, 10, 56, 100, 137, 8453, 42161].find((id) => !hookChainIds.includes(id))!;
    const hookTests = cowswapHookCases({
      hookChains,
      unlistedChainId,
      wallet: evmAddr,
      client: () => client,
      configChains: cfg.chains,
      // The settler's inherited ed25519 allow signs with this key; the hook must not.
      ...(solAddr ? { solanaAddress: solAddr } : {}),
      onSkip: note,
    });
    // The whoami check in runMatrix pins the key to this user, so another fenced user's key fails.
    await runMatrix(asRole, hookTests, subOrg, dryRun, () => client, fencedUser.userId);
    return;
  }

  // ── shared signRawPayload hash-function cases ────────────────────────────
  tests.push({
    name: 'signRawPayload HASH_FUNCTION_NO_OP (universal-oracle defense)',
    expect: 'DENY',
    run: () =>
      client.signRawPayload({ signWith: evmAddr, payload: '0x' + 'aa'.repeat(32), encoding: 'PAYLOAD_ENCODING_HEXADECIMAL', hashFunction: 'HASH_FUNCTION_NO_OP' }),
  });
  tests.push({
    // KECCAK256 signs a caller-supplied preimage, and an EIP-712 digest or an unsigned transaction
    // IS one, which reproduces any typed-data or transaction signature while every eth.eip_712.*
    // and eth.tx.* condition sits unevaluated. Every role signs typed data only.
    name: `signRawPayload HASH_FUNCTION_KECCAK256 (${cfg.type} signs typed data only)`,
    expect: 'DENY',
    run: () =>
      client.signRawPayload({ signWith: evmAddr, payload: '0x' + 'bb'.repeat(32), encoding: 'PAYLOAD_ENCODING_HEXADECIMAL', hashFunction: 'HASH_FUNCTION_KECCAK256' }),
  });
  tests.push({
    // No role signs with SHA256, and every role denies it outright.
    name: 'signRawPayload HASH_FUNCTION_SHA256',
    expect: 'DENY',
    run: () =>
      client.signRawPayload({ signWith: evmAddr, payload: '0x' + 'ab'.repeat(32), encoding: 'PAYLOAD_ENCODING_HEXADECIMAL', hashFunction: 'HASH_FUNCTION_SHA256' }),
  });
  if (solAddr) {
    // NOT_APPLICABLE is the ed25519 raw-sign mode (Solana). Every policy set allows it, and it's how
    // the Solana deposit signature is produced. With HEXADECIMAL, Turnkey rejects NOT_APPLICABLE on
    // a secp256k1 account (HTTP 400 "unsupported hash function: NotApplicable"), so this control
    // MUST sign with the Solana account, not the EVM one.
    tests.push({
      name: 'signRawPayload HASH_FUNCTION_NOT_APPLICABLE on ed25519 (positive control)',
      expect: 'ALLOW',
      run: () =>
        client.signRawPayload({ signWith: solAddr, payload: '0x' + 'cc'.repeat(32), encoding: 'PAYLOAD_ENCODING_HEXADECIMAL', hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE' }),
    });
    // The pairing `TurnkeySolanaSigner.signMessage` sends whenever `encodePayload` finds the bytes
    // textual, which the gateway handshake always is. HEXADECIMAL + NOT_APPLICABLE is refused on a
    // secp256k1 account, and this asserts whether that refusal is scoped to the curve or to the
    // encoding. If it reports REJECTED, `encodePayload` must go back to hex unconditionally: every
    // Solana settler would otherwise fail the handshake with a 400 that reads like misconfiguration.
    tests.push({
      name: isVerifier
        ? 'signRawPayload TEXT_UTF8 + NOT_APPLICABLE on ed25519 (the verifier allows HEXADECIMAL only)'
        : 'signRawPayload TEXT_UTF8 + NOT_APPLICABLE on ed25519 (the Solana signMessage pairing)',
      expect: isVerifier ? 'DENY' : 'ALLOW',
      run: () =>
        client.signRawPayload({
          signWith: solAddr,
          payload: 'settler-agent:gw-handshake:v1\nprobe',
          encoding: 'PAYLOAD_ENCODING_TEXT_UTF8',
          hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
        }),
    });
  }

  // ── EIP-712 encoding pairing control ─────────────────────────────────────
  // The pairing `signSecp256k1TypedDataAndVerify` sends. NOT_APPLICABLE is the only legal hash
  // function for EIP712 encoding: KECCAK256 is rejected with HTTP 400 "EIP-712 signing does not
  // require hashing", which is a request-shape error and so not expressible as a DENY case.
  {
    const probeDomain = {
      name: 'AtumPolicyProbe',
      version: '1',
      chainId: evmChainIdForProbe(cfg),
      verifyingContract: '0x0000000000000000000000000000000000000001',
    };
    const probeTypes = { Probe: [{ name: 'value', type: 'uint256' }] };
    const probeMessage = { value: 1n };
    // Exactly what the production helper sends: ethers' canonical EIP-712 JSON.
    const probePayload = JSON.stringify(
      ethers.TypedDataEncoder.getPayload(probeDomain, probeTypes, probeMessage),
    );

    // The broad NOT_APPLICABLE allow is only safe because Turnkey refuses these two pairings on a
    // secp256k1 account. That refusal is the security control, so assert it: if Turnkey ever starts
    // accepting either, this run fails instead of the policy quietly permitting a caller to sign a
    // 32-byte digest of its own choosing. A set with no matching allow (the verifier) denies first.
    tests.push({
      name: 'signRawPayload HEXADECIMAL + NOT_APPLICABLE on secp256k1 (must stay refused)',
      expect: 'REFUSED',
      run: () =>
        client.signRawPayload({
          signWith: evmAddr,
          payload: '0x' + 'dd'.repeat(32),
          encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
          hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
        }),
    });
    tests.push({
      name: 'signRawPayload TEXT_UTF8 + NOT_APPLICABLE on secp256k1 (must stay refused)',
      expect: 'REFUSED',
      run: () =>
        client.signRawPayload({
          signWith: evmAddr,
          payload: 'atum-policy-probe',
          encoding: 'PAYLOAD_ENCODING_TEXT_UTF8',
          hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
        }),
    });

    tests.push({
      // The domain-binding proof: correct encoding, arbitrary domain. Every typed-data allow is
      // bound to a verifying contract (Permit2, a token, or the settler identity sentinel).
      name: `EIP712 on an arbitrary domain (${cfg.type} domain binding)`,
      expect: 'DENY',
      run: () =>
        client.signRawPayload({
          signWith: evmAddr,
          payload: probePayload,
          encoding: 'PAYLOAD_ENCODING_EIP712',
          hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
        }),
    });
  }

  // ── management surface (every config type) ──────────────────────────────
  // No policy set emits an allow for any management activity: settler and sender alike rely on
  // Turnkey's default deny for non-root users to keep wallet export, key management and policy
  // edits closed. That assumption is load-bearing, so prove it rather than assert it.
  // executeActivity reaches these directly.
  const adminProbes: Array<[string, string, Record<string, unknown>]> = [
    ['ACTIVITY_TYPE_EXPORT_WALLET', 'export_wallet', { walletId, targetPublicKey: '0x' + '02'.repeat(33) }],
    ['ACTIVITY_TYPE_EXPORT_WALLET_ACCOUNT', 'export_wallet_account', { address: evmAddr, targetPublicKey: '0x' + '02'.repeat(33) }],
    ['ACTIVITY_TYPE_UPDATE_WALLET', 'update_wallet', { walletId, walletName: 'policy-probe' }],
    ['ACTIVITY_TYPE_CREATE_POLICY_V3', 'create_policy', { policyName: 'policy-probe', effect: 'EFFECT_ALLOW', condition: 'true', consensus: '', notes: '' }],
    ['ACTIVITY_TYPE_CREATE_API_KEYS_V2', 'create_api_keys', { apiKeys: [], userId: '00000000-0000-0000-0000-000000000000' }],
    // Imported keys (the verifier cutover) are Private Key resources, not wallet accounts, so their
    // export and delete paths are probed separately. Deleting one would strand every open deposit.
    ['ACTIVITY_TYPE_EXPORT_PRIVATE_KEY', 'export_private_key', { privateKeyId: '00000000-0000-0000-0000-000000000000', targetPublicKey: '0x' + '02'.repeat(33) }],
    ['ACTIVITY_TYPE_DELETE_PRIVATE_KEYS', 'delete_private_keys', { privateKeyIds: ['00000000-0000-0000-0000-000000000000'], deleteWithoutExport: false }],
  ];
  for (const [activityType, endpoint, params] of adminProbes) {
    tests.push({
      name: `${activityType} (management surface must stay default-denied)`,
      expect: 'DENY',
      run: () => client.executeActivity(activityType, endpoint, params),
    });
  }

  const evm = firstChain(cfg, 'evm');
  if (evm) {
    const [evmKey, evmChain] = evm;
    const cid = numericChainId(evmChain.chainId);
    const decoy = '0x' + 'de'.repeat(20);
    const evmTxn = (o: Parameters<typeof evmTx>[0]) => ({ signWith: evmAddr, unsignedTransaction: evmTx(o), type: 'TRANSACTION_TYPE_ETHEREUM' as const });

    if (cfg.type === 'settler') {
      const allow = cfg.allowlists?.[evmKey];
      const allowedTo = allow?.allowedTo ?? [];
      const target = allowedTo[0];
      const caps = cfg.extras?.evmCaps?.[evmKey];
      // Controls come from this config, so a green run shows the live set matches the file, not
      // that the file lists every selector the settler signs. That check sits with the settler's defaults.
      const allowed = (to: string, selector: string | undefined) =>
        selectorAllowedFor(allowlistPolicy(allow), 'evm', to, selector);
      if (!target) {
        note(`EVM chain "${evmKey}" has no allowlists.allowedTo — skipping EVM allowlist tests.`);
      } else {
        // A target bound to selectors gets one of them, so the value, chain id and cap DENYs below
        // fail on what they test rather than on a missing ALLOW.
        const listed = boundSelectors(allow, target, 'evm')?.[0];
        const data = listed ? callWith(listed) : undefined;
        const onTarget = { to: target, chainId: cid, ...(data ? { data } : {}) };
        tests.push({ name: 'EVM signTransaction to NON-allowlisted address', expect: 'DENY', run: () => client.signTransaction(evmTxn({ to: decoy, value: 0n, chainId: cid })) });
        tests.push({ name: 'EVM signTransaction to allowlisted contract, value>0', expect: 'DENY', run: () => client.signTransaction(evmTxn({ ...onTarget, value: 1n })) });
        tests.push({ name: 'EVM signTransaction to allowlisted contract, value=0 (positive control)', expect: 'ALLOW', run: () => client.signTransaction(evmTxn({ ...onTarget, value: 0n })) });
        tests.push({ name: 'EVM signTransaction to allowlisted contract on WRONG chain id', expect: 'DENY', run: () => client.signTransaction(evmTxn({ ...onTarget, value: 0n, chainId: cid + 999_000 })) });
        if (caps?.maxGasLimit) {
          tests.push({ name: 'EVM gas exceeding maxGasLimit cap', expect: 'DENY', run: () => client.signTransaction(evmTxn({ ...onTarget, value: 0n, gasLimit: BigInt(caps.maxGasLimit!) * 2n })) });
        }
        if (caps?.maxFeePerGasWei) {
          tests.push({ name: 'EVM max_fee_per_gas exceeding maxFeePerGasWei cap', expect: 'DENY', run: () => client.signTransaction(evmTxn({ ...onTarget, value: 0n, maxFeePerGas: BigInt(caps.maxFeePerGasWei!) * 2n })) });
        }
        // allowedSelectorsByTo: an allowlisted contract called with a selector outside its list.
        const bound = allowedTo.find((a) => boundSelectors(allow, a, 'evm') !== undefined);
        if (bound) {
          const sel = boundSelectors(allow, bound, 'evm')![0]!;
          tests.push({ name: `EVM allowlisted contract ${bound} with a selector outside its list`, expect: 'DENY', run: () => client.signTransaction(evmTxn({ to: bound, value: 0n, chainId: cid, data: callWith(UNLISTED_SELECTOR) })) });
          tests.push({ name: `EVM allowlisted contract ${bound} with listed selector ${sel} (positive control)`, expect: 'ALLOW', run: () => client.signTransaction(evmTxn({ to: bound, value: 0n, chainId: cid, data: callWith(sel) })) });
        } else {
          note(`EVM chain "${evmKey}" has no allowedSelectorsByTo — any selector reaches its allowlisted contracts.`);
        }
      }
      // ERC-20 recipient allowlist + approve/increaseAllowance spender drain defense.
      const token = cfg.approveDeny?.evm?.[evmKey]?.tokenContractsHex?.[0];
      const spender = cfg.approveDeny?.evm?.[evmKey]?.allowedSpendersHex?.[0];
      const recip = cfg.extras?.allowedErc20Recipients?.[evmKey]?.[0];
      const tokenAddr = token ? '0x' + token : undefined;
      // A positive control the selector map refuses by design is skipped, not reported as a failure.
      const control = (name: string, selector: string, run: () => Promise<unknown>) => {
        if (allowed(tokenAddr!, selector)) tests.push({ name, expect: 'ALLOW', run });
        else note(`${name}: ${selector} is not allowed on ${tokenAddr} by the allowlist, so there is no positive control.`);
      };
      if (tokenAddr && recip) {
        const recipDecoy = '0x53cAd7ec8D9fb3F61C001EA49d0bADB19D0c1A83';
        const transferVia = allowed(tokenAddr, TRANSFER_SELECTOR) ? 'recipient allowlist' : 'denied by the selector map, recipient deny not reached';
        tests.push({ name: `EVM ERC-20 transfer to NON-allowlisted recipient (${transferVia})`, expect: 'DENY', run: () => client.signTransaction(evmTxn({ to: tokenAddr, value: 0n, chainId: cid, data: erc20Transfer(recipDecoy, 1n) })) });
        control('EVM ERC-20 transfer to allowlisted recipient (positive control)', TRANSFER_SELECTOR, () => client.signTransaction(evmTxn({ to: tokenAddr, value: 0n, chainId: cid, data: erc20Transfer(recip, 1n) })));
      } else {
        note('No ERC-20 token/recipient in config for this chain — skipping recipient tests.');
      }
      if (tokenAddr && spender) {
        const dead = '0x000000000000000000000000000000000000dEaD';
        tests.push({ name: 'EVM ERC-20 approve to NON-allowlisted spender (drain defense)', expect: 'DENY', run: () => client.signTransaction(evmTxn({ to: tokenAddr, value: 0n, chainId: cid, data: erc20Approve(dead, ethers.MaxUint256) })) });
        // With increaseAllowance outside the token's selector list, the missing ALLOW denies first
        // and the spender deny is not exercised live (unit tests pin its condition).
        const increaseVia = allowed(tokenAddr, INCREASE_ALLOWANCE_SELECTOR) ? 'drain defense' : 'denied by the selector map, spender deny not reached';
        tests.push({ name: `EVM ERC-20 increaseAllowance to NON-allowlisted spender (${increaseVia})`, expect: 'DENY', run: () => client.signTransaction(evmTxn({ to: tokenAddr, value: 0n, chainId: cid, data: erc20IncreaseAllowance(dead, ethers.MaxUint256) })) });
        control('EVM ERC-20 approve to allowlisted spender (positive control)', APPROVE_SELECTOR, () => client.signTransaction(evmTxn({ to: tokenAddr, value: 0n, chainId: cid, data: erc20Approve('0x' + spender, ethers.MaxUint256) })));
        control('EVM ERC-20 increaseAllowance to allowlisted spender (positive control)', INCREASE_ALLOWANCE_SELECTOR, () => client.signTransaction(evmTxn({ to: tokenAddr, value: 0n, chainId: cid, data: erc20IncreaseAllowance('0x' + spender, ethers.MaxUint256) })));
      } else {
        note('No approveDeny token/spender in config for this chain — skipping approve/increaseAllowance tests.');
      }
    } else if (isSender) {
      // Sender EVM: only approve(Permit2, …) on an allowlisted token is allowed.
      const token = cfg.senderExtras?.allowedTokens?.[evmKey]?.[0];
      const caps = cfg.senderExtras?.evmCaps?.[evmKey];
      if (!token) {
        note(`Sender EVM chain "${evmKey}" has no allowedTokens — skipping EVM tests.`);
      } else {
        tests.push({ name: 'Sender approve(Permit2) on allowlisted token (positive control)', expect: 'ALLOW', run: () => client.signTransaction(evmTxn({ to: token, value: 0n, chainId: cid, data: erc20Approve(EVM_PERMIT2, ethers.MaxUint256) })) });
        tests.push({ name: 'Sender approve to NON-Permit2 spender', expect: 'DENY', run: () => client.signTransaction(evmTxn({ to: token, value: 0n, chainId: cid, data: erc20Approve('0x000000000000000000000000000000000000dEaD', ethers.MaxUint256) })) });
        tests.push({ name: 'Sender ERC-20 transfer (sender only approves, never transfers)', expect: 'DENY', run: () => client.signTransaction(evmTxn({ to: token, value: 0n, chainId: cid, data: erc20Transfer('0x000000000000000000000000000000000000dEaD', 1n) })) });
        tests.push({ name: 'Sender signTransaction with native value>0', expect: 'DENY', run: () => client.signTransaction(evmTxn({ to: token, value: 1n, chainId: cid, data: erc20Approve(EVM_PERMIT2, 1n) })) });
        if (caps?.maxGasLimit) {
          tests.push({ name: 'Sender EVM gas exceeding maxGasLimit cap', expect: 'DENY', run: () => client.signTransaction(evmTxn({ to: token, value: 0n, chainId: cid, gasLimit: BigInt(caps.maxGasLimit!) * 2n, data: erc20Approve(EVM_PERMIT2, 1n) })) });
        }
      }
    }
  }

  // ── Sender: the Permit2 deposit typed-data binding ───────────────────────
  // Every case differs from the canonical request in exactly ONE field, so a denial is
  // attributable to that binding rather than to a malformed request. The destination cases are
  // the ones this policy set exists for.
  if (isSender) {
    // EVERY EVM and Tron chain, not just the first. Each carries its own hand-authored escrow and
    // destination list, and one typo'd entry fails closed for that chain alone — which a single
    // control on one chain cannot see. Same reasoning the Solana block applies per anchor program.
    //
    // Tron belongs here rather than in the settler-only Tron block below, which tests calldata
    // policies. Its TIP-712 payload differs from EVM in three derived values only, and all three
    // are hand-derived in the emitter, so this arm is the one most worth exercising: the domain
    // verifying contract is the Tron Permit2 in EVM-hex form, the chain id is masked to 32 bits,
    // and every address MEMBER is the 0x41-stripped hex rather than the base58 in the config.
    const sEvmChains = Object.entries(cfg.chains).filter(
      ([, c]) => c.kind === 'evm' || c.kind === 'tron',
    );
    if (sEvmChains.length === 0) {
      note('Sender config has no EVM or Tron chain — typed-data binding untested.');
    }
    // Per chain KIND, not per list position: the single-field cases prove the emitter's shape,
    // and the EVM and Tron arms derive that shape differently, so proving it once on Ethereum
    // says nothing about Tron. Without this the witness-role cases never run on Tron, which is
    // exactly the binding the config fix above touched.
    const deepDone = { evm: false, tron: false };
    for (const sEvm of sEvmChains) {
      const escrowRaw = cfg.senderExtras?.escrows?.[sEvm[0]]?.[0];
      const destinations = cfg.senderExtras?.allowedDestinations?.[sEvm[0]] ?? [];
      if (!escrowRaw || destinations.length === 0) {
        note(
          `Sender chain "${sEvm[0]}" is missing senderExtras.escrows or allowedDestinations — ` +
            'typed-data binding untested.',
        );
        continue;
      }
      // Tron typed data is signed with the TRON account, the way TurnkeyTronSigner does. Signing
      // it with the EVM account would still exercise the policy (the DSL has no signWith
      // selector) but it would not be the request the runtime actually sends, so a pass would
      // prove less than it appears to.
      if (sEvm[1].kind === 'tron' && !tronAddr) {
        note('No --tron-address given, so the Tron sender typed-data cases are skipped.');
        continue;
      }
      const signWithForChain = sEvm[1].kind === 'tron' ? tronAddr! : evmAddr;
      // A placeholder role would make the positive control sign the same zero address the policy
      // allowlists, so the case passes while proving nothing and the chain still cannot pay.
      const ZERO_MEMBER = '0x0000000000000000000000000000000000000000';
      const placeholderRoles = [
        ...(cfg.senderExtras?.reservers?.[sEvm[0]] ?? []),
        ...(cfg.senderExtras?.releasers?.[sEvm[0]] ?? []),
      ].some((a) => toTronEvmHexSafe(a) === ZERO_MEMBER);
      if (placeholderRoles) {
        note(
          `Sender chain "${sEvm[0]}" still has a placeholder (zero address) witness role, so its ` +
            'typed-data cases are skipped: they would pass against the placeholder and prove nothing.',
        );
        continue;
      }
      // The deeper single-field cases only need proving once; the per-chain lists are what vary.
      const kind = sEvm[1].kind === 'tron' ? 'tron' : 'evm';
      const deep = !deepDone[kind];
      deepDone[kind] = true;
      const chainLabel = sEvm[0];
      const isTron = sEvm[1].kind === 'tron';
      // Mirror the emitter exactly. Deriving these any other way would make a passing run prove
      // only that the harness and the emitter share a bug.
      const sCid = isTron ? tronTip712ChainId(sEvm[1].chainId) : numericChainId(sEvm[1].chainId);
      const network = cfg.senderExtras?.network === 'mainnet' ? 'mainnet' : 'shasta';
      const permit2 = isTron
        ? toTronEvmHex(TRON_PERMIT2[network])
        : (cfg.senderExtras?.permit2 ?? EVM_PERMIT2);
      // Config holds base58 for Tron, but the TIP-712 message carries 0x41-stripped hex, and
      // ethers rejects a base58 string as an address outright.
      const asMember = (a: string): string => (isTron ? toTronEvmHex(a) : a);
      const tokens = (cfg.senderExtras?.allowedTokens?.[sEvm[0]] ?? []).map(asMember);
      const reservers = (cfg.senderExtras?.reservers?.[sEvm[0]] ?? []).map(asMember);
      const releasers = (cfg.senderExtras?.releasers?.[sEvm[0]] ?? []).map(asMember);
      const ATTACKER = '0x000000000000000000000000000000000000dead';
      const escrow = asMember(escrowRaw);

      // The four-member CORE-2120 witness. `destination` is a string, which is exactly why it
      // survives to the policy engine in the clear: an address member would too, but a hashed
      // commitment would not.
      const SENDER_PERMIT_TYPES = {
        PermitWitnessTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions' },
          { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'witness', type: 'DepositWitness' },
        ],
        TokenPermissions: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        DepositWitness: [
          { name: 'depositRequestHash', type: 'bytes32' },
          { name: 'destination', type: 'string' },
          { name: 'reserver', type: 'address' },
          { name: 'releaser', type: 'address' },
        ],
      };
      const okDestination = buildEscrowDestination(destinations[0]!.asset, destinations[0]!.account);
      const okToken = tokens[0] ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
      const okReserver = reservers[0] ?? '0x1111111111111111111111111111111111111111';
      const okReleaser = releasers[0] ?? '0x2222222222222222222222222222222222222222';

      const senderPayload = (o: {
        spender?: string;
        token?: string;
        destination?: string;
        reserver?: string;
        releaser?: string;
      }): string =>
        JSON.stringify(
          ethers.TypedDataEncoder.getPayload(
            { name: 'Permit2', chainId: sCid, verifyingContract: permit2 },
            SENDER_PERMIT_TYPES,
            {
              permitted: { token: o.token ?? okToken, amount: 1_000_000n },
              spender: o.spender ?? escrow,
              nonce: 1n,
              deadline: EXPIRED_PERMIT_DEADLINE,
              witness: {
                depositRequestHash: '0x' + '11'.repeat(32),
                destination: o.destination ?? okDestination,
                reserver: o.reserver ?? okReserver,
                releaser: o.releaser ?? okReleaser,
              },
            },
          ),
        );

      const signTyped = (payload: string) =>
        client.signRawPayload({
          signWith: signWithForChain,
          payload,
          encoding: 'PAYLOAD_ENCODING_EIP712',
          hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
        });

      // If this denies, the whole set is meaningless and the sender cannot pay at all.
      tests.push({
        name: `Sender canonical Permit2 deposit to an allowlisted destination on ${chainLabel} (positive control)`,
        expect: 'ALLOW',
        run: () => signTyped(senderPayload({})),
      });

      // What CORE-172 exists for: an authentic signature naming a payee we never approved.
      tests.push({
        name: `Sender deposit on ${chainLabel} with the destination redirected to an attacker`,
        expect: 'DENY',
        run: () =>
          signTyped(
            senderPayload({
              destination: buildEscrowDestination(
                destinations[0]!.asset,
                '0x000000000000000000000000000000000000dead',
              ),
            }),
          ),
      });

      // Byte-exactness, not merely "the right payee". A re-cased destination is a different
      // commitment on-chain, so the policy must treat it as one too.
      const recased = okDestination.toUpperCase();
      if (deep && recased !== okDestination) {
        tests.push({
          name: 'Sender deposit with a re-cased destination (byte-exactness)',
          expect: 'DENY',
          run: () => signTyped(senderPayload({ destination: recased })),
        });
      }

      // Permit2 leaves the transfer recipient unsigned, so spender is what bounds where funds go.
      tests.push({
        name: `Sender deposit on ${chainLabel} with spender redirected to an attacker (funds-diversion defense)`,
        expect: 'DENY',
        run: () => signTyped(senderPayload({ spender: ATTACKER })),
      });

      if (tokens.length === 0) {
        note(`senderExtras.allowedTokens is unset for "${chainLabel}" — any token may be deposited.`);
      } else if (deep) {
        tests.push({
          name: `Sender deposit of a non-allowlisted token on ${chainLabel}`,
          expect: 'DENY',
          run: () => signTyped(senderPayload({ token: ATTACKER })),
        });
      }
      if (reservers.length === 0) {
        note(`senderExtras.reservers is unset for "${chainLabel}" — witness.reserver is unbound.`);
      } else if (deep) {
        tests.push({
          name: `Sender deposit with witness.reserver redirected on ${chainLabel}`,
          expect: 'DENY',
          run: () => signTyped(senderPayload({ reserver: ATTACKER })),
        });
      }
      if (releasers.length === 0) {
        note(`senderExtras.releasers is unset for "${chainLabel}" — witness.releaser is unbound.`);
      } else if (deep) {
        tests.push({
          name: `Sender deposit with witness.releaser redirected on ${chainLabel}`,
          expect: 'DENY',
          run: () => signTyped(senderPayload({ releaser: ATTACKER })),
        });
      }

      // The two-member witness has no `destination` member, so this also pins what the policy
      // does with an absent nested key: it must not match, or the binding is bypassable by
      // simply omitting the field.
      // The batch form sets encoding once but carries an ARRAY of payloads, and the message
      // conditions bind only one of them, so a redirected second element could ride behind a
      // legitimate first. Denied outright, which this proves rather than assumes.
      if (deep)
        tests.push({
          name: 'Sender batch signRawPayloads smuggling a redirected second payload',
          expect: 'DENY',
          run: () =>
            client.executeActivity('ACTIVITY_TYPE_SIGN_RAW_PAYLOADS', 'sign_raw_payloads', {
              signWith: signWithForChain,
              payloads: [
                senderPayload({}),
                senderPayload({ spender: ATTACKER }),
              ],
              encoding: 'PAYLOAD_ENCODING_EIP712',
              hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
            }),
        });

      if (deep)
      tests.push({
        name: 'Sender deposit using the two-member witness (no destination member)',
        expect: 'DENY',
        run: () =>
          signTyped(
            JSON.stringify(
              ethers.TypedDataEncoder.getPayload(
                { name: 'Permit2', chainId: sCid, verifyingContract: permit2 },
                {
                  PermitWitnessTransferFrom: [
                    { name: 'permitted', type: 'TokenPermissions' },
                    { name: 'spender', type: 'address' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' },
                    { name: 'witness', type: 'DepositWitness' },
                  ],
                  TokenPermissions: [
                    { name: 'token', type: 'address' },
                    { name: 'amount', type: 'uint256' },
                  ],
                  DepositWitness: [
                    { name: 'reserver', type: 'address' },
                    { name: 'releaser', type: 'address' },
                  ],
                },
                {
                  permitted: { token: okToken, amount: 1_000_000n },
                  spender: escrow,
                  nonce: 1n,
                  deadline: EXPIRED_PERMIT_DEADLINE,
                  witness: { reserver: okReserver, releaser: okReleaser },
                },
              ),
            ),
          ),
      });
    }
  }


  // ── Settler: identity and EIP-3009 typed data ────────────────────────────
  // The settler's only non-transaction secp256k1 signatures. Each DENY differs from an ALLOW in
  // one binding, so a denial is attributable to that binding.
  if (cfg.type === 'settler') {
    const identityDomain = {
      name: 'Atum Settler Identity',
      version: '1',
      verifyingContract: SETTLER_IDENTITY_VERIFYING_CONTRACT,
    };
    const identityPayload = (primary: 'SettlerProof' | 'WalletProof'): string =>
      JSON.stringify(
        primary === 'SettlerProof'
          ? ethers.TypedDataEncoder.getPayload(
              identityDomain,
              { SettlerProof: [{ name: 'proofHash', type: 'bytes32' }, { name: 'docHash', type: 'bytes32' }] },
              { proofHash: '0x' + '11'.repeat(32), docHash: '0x' + '22'.repeat(32) },
            )
          : ethers.TypedDataEncoder.getPayload(
              identityDomain,
              { WalletProof: [{ name: 'digest', type: 'bytes32' }] },
              { digest: '0x' + '33'.repeat(32) },
            ),
      );
    const signTypedWith = (signWith: string, payload: string) =>
      client.signRawPayload({
        signWith,
        payload,
        encoding: 'PAYLOAD_ENCODING_EIP712',
        hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
      });

    tests.push({
      name: 'Settler identity-domain SettlerProof (positive control)',
      expect: 'ALLOW',
      run: () => signTypedWith(evmAddr, identityPayload('SettlerProof')),
    });
    tests.push({
      name: 'Settler identity-domain WalletProof (positive control)',
      expect: 'ALLOW',
      run: () => signTypedWith(evmAddr, identityPayload('WalletProof')),
    });
    if (tronAddr) {
      tests.push({
        name: 'Settler identity-domain SettlerProof signed by the Tron account (positive control)',
        expect: 'ALLOW',
        run: () => signTypedWith(tronAddr, identityPayload('SettlerProof')),
      });
    }
    tests.push({
      name: 'Settler batch signRawPayloads of two identity payloads',
      expect: 'DENY',
      run: () =>
        client.executeActivity('ACTIVITY_TYPE_SIGN_RAW_PAYLOADS', 'sign_raw_payloads', {
          signWith: evmAddr,
          payloads: [identityPayload('SettlerProof'), identityPayload('WalletProof')],
          encoding: 'PAYLOAD_ENCODING_EIP712',
          hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
        }),
    });
    // The payload is the RLP authorization tuple [chain_id, address, nonce]. REJECTED here means
    // Turnkey wants a different payload shape for this encoding, not that the deny is missing.
    tests.push({
      name: 'Settler EIP-7702 authorization encoding',
      expect: 'DENY',
      run: () =>
        client.executeActivity('ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2', 'sign_raw_payload', {
          signWith: evmAddr,
          payload: ethers
            .encodeRlp([ethers.toBeHex(evmChainIdForProbe(cfg)), '0x' + 'de'.repeat(20), '0x'])
            .slice(2),
          encoding: 'PAYLOAD_ENCODING_EIP7702_AUTHORIZATION',
          hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
        }),
    });

    const AUTHORIZATION_FIELDS = [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ];
    const PERMIT_TYPES = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    const FOREIGN = '0x000000000000000000000000000000000000dead';
    const twaChains = Object.entries(cfg.transferWithAuthorizationTokens ?? {});
    if (twaChains.length === 0) {
      note('Settler config has no transferWithAuthorizationTokens — EIP-3009 cases skipped.');
    }
    for (const [key, tokens] of twaChains) {
      const chain = cfg.chains[key];
      const token = tokens[0];
      if (!chain || chain.kind !== 'evm' || !token) continue;
      const domainFor = (verifyingContract: string) => ({
        name: 'USD Coin',
        version: '2',
        chainId: numericChainId(chain.chainId),
        verifyingContract,
      });
      const domain = domainFor(token);
      const authorization = (
        primary: 'TransferWithAuthorization' | 'ReceiveWithAuthorization',
        from: string,
        verifyingContract = token,
      ) =>
        JSON.stringify(
          ethers.TypedDataEncoder.getPayload(domainFor(verifyingContract), { [primary]: AUTHORIZATION_FIELDS }, {
            from,
            to: FOREIGN,
            value: 1n,
            validAfter: 0n,
            validBefore: EXPIRED_PERMIT_DEADLINE,
            nonce: '0x' + '44'.repeat(32),
          }),
        );
      // One positive control per configured token; the negative cases reuse the first.
      for (const t of tokens) {
        tests.push({
          name: `Settler EIP-3009 TransferWithAuthorization from the settler on ${key} token ${t} (positive control)`,
          expect: 'ALLOW',
          run: () => signTypedWith(evmAddr, authorization('TransferWithAuthorization', evmAddr, t)),
        });
      }
      tests.push({
        name: `Settler EIP-3009 TransferWithAuthorization with a foreign from on ${key}`,
        expect: 'DENY',
        run: () => signTypedWith(evmAddr, authorization('TransferWithAuthorization', FOREIGN)),
      });
      // Same domain, fields and `from` as the positive control: only primary_type can deny it.
      tests.push({
        name: `Settler EIP-3009 ReceiveWithAuthorization from the settler on ${key} (primary type binding probe)`,
        expect: 'DENY',
        run: () => signTypedWith(evmAddr, authorization('ReceiveWithAuthorization', evmAddr)),
      });
      tests.push({
        name: `Settler EIP-2612 Permit on an allowlisted token on ${key} (denied by primary type and the missing from)`,
        expect: 'DENY',
        run: () =>
          signTypedWith(
            evmAddr,
            JSON.stringify(
              ethers.TypedDataEncoder.getPayload(domain, PERMIT_TYPES, {
                owner: evmAddr,
                spender: FOREIGN,
                value: ethers.MaxUint256,
                nonce: 0n,
                deadline: EXPIRED_PERMIT_DEADLINE,
              }),
            ),
          ),
      });
    }
  }

  // ── Tron (settler only, and only when a token contract is supplied) ──────
  const tron = firstChain(cfg, 'tron');
  if (cfg.type === 'settler' && tron && tronAddr) {
    const tronWeb = new TronWeb({ fullHost: tronHost });
    tests.push({
      name: 'Tron TransferContract (sendTrx) — not a TriggerSmartContract, no allow matches',
      expect: 'DENY',
      run: async () => {
        const tx = await tronWeb.transactionBuilder.sendTrx('TQQpmpt9LXAXsEvatSEpqBMa8iMZy2CmLv', 1, tronAddr);
        await client.signTransaction({ signWith: tronAddr, unsignedTransaction: tx.raw_data_hex, type: 'TRANSACTION_TYPE_TRON' });
      },
    });
    if (tronToken) {
      const buildTrc20 = async (recipient: string, feeLimit: number): Promise<string> => {
        const r = await tronWeb.transactionBuilder.triggerSmartContract(
          tronToken,
          'transfer(address,uint256)',
          { feeLimit },
          [{ type: 'address', value: recipient }, { type: 'uint256', value: 1 }],
          tronAddr,
        );
        if (!r.result?.result || !r.transaction?.raw_data_hex) throw new Error(`triggerSmartContract build failed: ${JSON.stringify(r)}`);
        return r.transaction.raw_data_hex;
      };
      tests.push({ name: 'Tron TRC-20 transfer to NON-allowlisted recipient', expect: 'DENY', run: async () => { const hex = await buildTrc20('TQQpmpt9LXAXsEvatSEpqBMa8iMZy2CmLv', 100_000_000); await client.signTransaction({ signWith: tronAddr, unsignedTransaction: hex, type: 'TRANSACTION_TYPE_TRON' }); } });
    } else {
      note('No --tron-token provided — skipping Tron TRC-20 recipient tests (our configs carry no Tron token contract).');
    }
    // approve / increaseAllowance spender drain defense on the approveDeny token.
    const tronAllow = cfg.allowlists?.[tron[0]];
    const tronDeny = cfg.approveDeny?.tron?.[tron[0]];
    const tronGrantToken = tronDeny?.tokenContractsBase58?.[0];
    const tronSpenderHex = tronDeny?.allowedSpendersHex?.[0];
    if (tronGrantToken && tronSpenderHex) {
      const buildGrant = async (fn: 'approve' | 'increaseAllowance', spender: string): Promise<string> => {
        // Below every configured maxFeeLimitSun, so a positive control is not denied by the cap.
        const r = await tronWeb.transactionBuilder.triggerSmartContract(
          tronGrantToken,
          `${fn}(address,uint256)`,
          { feeLimit: 10_000_000 },
          [{ type: 'address', value: spender }, { type: 'uint256', value: 1 }],
          tronAddr,
        );
        if (!r.result?.result || !r.transaction?.raw_data_hex) throw new Error(`triggerSmartContract build failed: ${JSON.stringify(r)}`);
        return r.transaction.raw_data_hex;
      };
      const signTron = async (hex: Promise<string>) =>
        client.signTransaction({ signWith: tronAddr, unsignedTransaction: await hex, type: 'TRANSACTION_TYPE_TRON' });
      const untrusted = 'TQQpmpt9LXAXsEvatSEpqBMa8iMZy2CmLv';
      const trustedSpender = TronWeb.address.fromHex('41' + tronSpenderHex.replace(/^0x/, ''));
      for (const [fn, selector] of [['approve', APPROVE_SELECTOR], ['increaseAllowance', INCREASE_ALLOWANCE_SELECTOR]] as const) {
        const grantAllowed = selectorAllowedFor(allowlistPolicy(tronAllow), 'tron', tronGrantToken, selector);
        const via = grantAllowed ? 'drain defense' : 'denied by the allowlist, spender deny not reached';
        tests.push({ name: `Tron TRC-20 ${fn} to NON-allowlisted spender (${via})`, expect: 'DENY', run: () => signTron(buildGrant(fn, untrusted)) });
        const name = `Tron TRC-20 ${fn} to allowlisted spender (positive control)`;
        if (grantAllowed) {
          tests.push({ name, expect: 'ALLOW', run: () => signTron(buildGrant(fn, trustedSpender)) });
        } else {
          note(`${name}: ${fn} on ${tronGrantToken} is not allowed by the Tron allowlist, so there is no positive control.`);
        }
      }
    } else {
      note('No approveDeny.tron token/spender in config — skipping Tron approve/increaseAllowance tests.');
    }
    // allowedSelectorsByTo: a bound Tron contract called with a function no contract has, so no
    // DENY matches and only the selector binding can refuse it. The approve positive control above
    // proves the bound clause admits a listed selector.
    const tronBound = (tronAllow?.allowedTo ?? []).find((a) => boundSelectors(tronAllow, a, 'tron') !== undefined);
    if (tronBound) {
      tests.push({
        name: `Tron allowlisted contract ${tronBound} with a selector outside its list`,
        expect: 'DENY',
        run: async () => {
          const r = await tronWeb.transactionBuilder.triggerSmartContract(tronBound, 'atumPolicyProbe()', { feeLimit: 10_000_000 }, [], tronAddr);
          if (!r.result?.result || !r.transaction?.raw_data_hex) throw new Error(`triggerSmartContract build failed: ${JSON.stringify(r)}`);
          await client.signTransaction({ signWith: tronAddr, unsignedTransaction: r.transaction.raw_data_hex, type: 'TRANSACTION_TYPE_TRON' });
        },
      });
    } else {
      note(`Tron chain "${tron[0]}" has no allowedSelectorsByTo — any selector reaches its allowlisted contracts.`);
    }
  } else if (cfg.type === 'settler' && tron && !tronAddr) {
    note('No Tron address — skipping Tron tests.');
  }

  // ── Solana ────────────────────────────────────────────────────────────────
  const sol = firstChain(cfg, 'solana');
  if (isVerifier) {
    // The verifier signs no transaction on any chain, so its Solana rows live with its other cases.
    tests.push(
      ...verifierCases({
        chains: cfg.chains,
        verifierExtras: cfg.verifierExtras,
        client: () => client,
        ...(solAddr ? { solanaAddress: solAddr } : {}),
      }),
    );
  } else if (sol && solAddr) {
    const [solKey, solChain] = sol;
    const conn = new Connection(solanaRpc, 'confirmed');
    const payer = new PublicKey(solAddr);
    const buildSolTx = async (ixs: TransactionInstruction[]): Promise<string> => {
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
      return Buffer.from(new VersionedTransaction(msg).serialize()).toString('hex');
    };
    const memoIx = () => new TransactionInstruction({ keys: [], programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), data: Buffer.from('policy-test', 'utf-8') });
    const submit = (hex: string) => client.signTransaction({ signWith: solAddr, unsignedTransaction: hex, type: 'TRANSACTION_TYPE_SOLANA' });

    tests.push({ name: 'Solana tx touching Memo program (not allowlisted)', expect: 'DENY', run: async () => submit(await buildSolTx([memoIx()])) });
    tests.push({ name: 'Solana tx with only ComputeBudget instruction (positive control)', expect: 'ALLOW', run: async () => submit(await buildSolTx([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })])) });

    // Allowlisted Anchor programs with extra readonly accounts (fulfill/deposit shape). Each listed
    // program gets its own control: an allowlist carrying two escrow deployments is only proven by
    // exercising both against Turnkey, and a typo in any one entry fails closed for that program
    // alone, which a single control cannot see.
    const anchorPrograms =
      cfg.type === 'settler'
        ? (cfg.allowlists?.[solKey]?.allowedPrograms ?? []).filter((p) => !STANDARD_SOLANA.has(p))
        : (() => {
            const ids = cfg.senderExtras?.solanaEscrowProgramId;
            return typeof ids === 'string' ? [ids] : (ids ?? []);
          })();
    for (const anchorProgram of anchorPrograms) {
      tests.push({
        name: `Solana call to allowlisted Anchor program ${anchorProgram} with extra readonly accounts (positive control)`,
        expect: 'ALLOW',
        run: async () => {
          const ix = new TransactionInstruction({
            programId: new PublicKey(anchorProgram),
            keys: [
              { pubkey: payer, isSigner: true, isWritable: true },
              { pubkey: new PublicKey('4KuHbpFBaFpo9eCUnsbRSJj3M8tNdVmDymKjVCXjaFHw'), isSigner: false, isWritable: false },
              { pubkey: new PublicKey('3NgVyDm3gHCu2vQF8dJXMBPezPq1vNMrxGM8EYtaB7RF'), isSigner: false, isWritable: false },
            ],
            data: Buffer.from('0102030405060708', 'hex'),
          });
          await submit(await buildSolTx([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix]));
        },
      });
    }

    // Native SOL drain above the cap must be denied (settler and sender both cap it now).
    const solCap =
      cfg.type === 'sender'
        ? BigInt(cfg.senderExtras?.solanaMaxNativeValue ?? '10000000')
        : 10_000_000n; // settler config sets Solana maxNativeValue to 0.01 SOL
    tests.push({
      name: 'Solana System.transfer above native-value cap (drain defense)',
      expect: 'DENY',
      run: async () => submit(await buildSolTx([SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: solCap * 2n })])),
    });

    // Top-level SPL transfer must be denied (both configs deny all top-level SPL transfers).
    const throwawayMint = Keypair.generate().publicKey;
    const srcAta = getAssociatedTokenAddressSync(throwawayMint, payer, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const dstAta = getAssociatedTokenAddressSync(throwawayMint, Keypair.generate().publicKey, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    tests.push({
      name: 'Solana top-level SPL transfer (deny-all)',
      expect: 'DENY',
      run: async () => submit(await buildSolTx([createTransferInstruction(srcAta, dstAta, payer, 1n)])),
    });
  } else if (sol && !solAddr) {
    note('No Solana address — skipping Solana tests.');
  }

  // ── Stellar ───────────────────────────────────────────────────────────────
  // Turnkey documents no Stellar transaction parsing, so these rows exercise the raw-payload fence
  // only (see stellar-cases.ts). A Stellar chain with no address is skipped, not silently passed.
  if (firstChain(cfg, 'stellar')) {
    if (stellarAddr) {
      tests.push(
        ...stellarCases({ role: cfg.type, stellarAddress: stellarAddr, client: () => client }),
      );
    } else {
      note('No Stellar address (--stellar-address, stellarSigners or the sub-org file) — skipping Stellar tests.');
    }
  }

  await runMatrix(cfg.type, tests, subOrg, dryRun, () => client);
}

/**
 * Print or run a case list. `expectedUserId`, when given, must be the user the credentials
 * authenticate as: a role matrix run with another user's key proves nothing about that role.
 */
async function runMatrix(
  label: string,
  tests: TestSpec[],
  subOrg: string,
  dryRun: boolean,
  client: () => TurnkeyClient,
  expectedUserId?: string,
): Promise<void> {
  console.log(`\n${label} policy test — ${tests.length} cases → sub-org ${subOrg}\n`);
  if (dryRun) {
    for (const t of tests) console.log(`  [${t.expect.padEnd(5)}] ${t.name}`);
    console.log('\nDry run — no requests sent. Re-run without --dry-run to execute against Turnkey.');
    return;
  }

  const who = await client().whoami();
  console.log(`Authenticated to org ${who.organizationId}${who.userId ? ` as user ${who.userId}` : ''}\n`);
  if (expectedUserId) assertAuthenticatedAs(who.userId, expectedUserId, label);

  const results: TestResult[] = [];
  for (const t of tests) {
    process.stdout.write(`[${t.expect.padEnd(5)}] ${t.name} … `);
    const r = await runTest(t);
    results.push(r);
    console.log(r.pass ? `PASS (got ${r.actual})` : `FAIL (expected ${r.expect}, got ${r.actual})`);
    if (!r.pass) console.log(r.detail.split('\n').map((l) => `        ${l}`).join('\n'));
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\nSummary: ${passed}/${results.length} passed, ${failed} failed.`);
  if (failed > 0) {
    const denyAsAllow = results.filter((r) => r.expect === 'DENY' && r.actual === 'ALLOW').length;
    if (denyAsAllow > 1) {
      console.log('\nNOTE: multiple "expect DENY" cases reported ALLOW. The signing user is likely a');
      console.log('ROOT user — root bypasses all policies. Confirm the agent uses a non-root API key.');
    }
    process.exit(1);
  }
}

// Standard Solana programs that appear in a settler allowlist but are not the Atum Anchor program.
const STANDARD_SOLANA = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'ComputeBudget111111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
]);

main().catch((err) => {
  console.error('test-policies failed:', err);
  process.exit(1);
});
