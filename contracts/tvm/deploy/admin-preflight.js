#!/usr/bin/env node
'use strict';

/**
 * admin-preflight.js -- rehearse the post-deploy Tron admin sequence offline.
 *
 * WHY THIS EXISTS
 *
 * On a multisig-owned admin account the owner permission's threshold is > 1, so
 * a single signature against it is rejected. Tron's way out is an ACTIVE
 * permission with its own threshold and its own operations allowlist; using one
 * means stamping Permission_id on the transaction. deploy-permissioned.js does
 * that for the two CreateSmartContract transactions. The post-deploy admin
 * operations -- granting the four roles, allowlisting the token -- are
 * TriggerSmartContract calls, which is a DIFFERENT operation bit, and they go
 * through scripts/admin/**, which had no way to express a permission id at all.
 *
 * That gap is now closed in scripts/config.js (writeOptions), so the real
 * execution path is the existing admin scripts with TRON_PERMISSION_ID set.
 * This tool is the rehearsal for it, and it answers questions the real scripts
 * cannot answer until it is too late to matter:
 *
 *   - does the named permission actually permit TriggerSmartContract? Being
 *     allowed to DEPLOY (CreateSmartContract, op 30) is a separate bit from
 *     being allowed to CALL (op 31). The deploy driver checks 30. Nothing
 *     checked 31.
 *   - is this key's own weight enough to meet the permission's threshold, or
 *     does a single signature silently fall short?
 *   - will each transaction in the sequence really carry Permission_id, and
 *     will it really be signed by the key we think it is?
 *   - are the role hashes and function selectors the ones the contract expects?
 *
 * It builds every transaction with TronWeb's txLocal path, so construction and
 * signing happen with NO node involvement and NOTHING is broadcast. That also
 * makes it usable BEFORE the contracts exist on chain -- which matters on Tron,
 * where there is no CREATE2 and the v4 addresses are not known until after the
 * deploy transaction lands.
 *
 * Usage:
 *   NETWORK=mainnet node admin-preflight.js
 *   NETWORK=mainnet node admin-preflight.js --escrow T... --fproxy T...
 *   node admin-preflight.js --self-test      # hermetic, no network, no key
 *   node admin-preflight.js --offline        # skip the on-chain permission read
 *
 * Inputs (env):
 *   NETWORK              mainnet | shasta            (default mainnet)
 *   TRON_PERMISSION_ID   active permission id to rehearse (e.g. 2)
 *   ADMIN_PK             admin key; falls back to PRIVATE_KEY_MAINNET / PRIVATE_KEY_SHASTA
 *   TRON_RPC_URL         override the endpoint
 *   TRON_API_KEY         TronGrid api key
 *   ESCROW_ADDRESS       v4 escrow (else --escrow, else the deploy record)
 *   FULFILLMENT_PROXY_ADDRESS      ESCROW / FPROXY are accepted as aliases;
 *                                  set both or neither
 *   ADMIN_ADDRESS        role grantee (default: the signer)
 *
 * Exit codes: 0 ready, 1 a check failed, 2 could not run the checks.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const HERE = __dirname;
const SRC = path.join(HERE, '..', 'source');

// tronweb lives in ../source/node_modules and Node resolves upward, not
// sideways, so a plain require() from deploy/ cannot find it.
let TronWeb;
try {
  TronWeb = createRequire(path.join(SRC, 'package.json'))('tronweb').TronWeb;
} catch (e) {
  console.error(`Cannot load tronweb from ${SRC}/node_modules.`);
  console.error(`  ${e.message}`);
  console.error(`Run:  cd ${SRC} && pnpm install --ignore-workspace`);
  process.exit(2);
}

// tronweb builds two of its multiSign errors as `privateKey + ' has no permission
// to sign'` (lib/trx.js:493 and :496) -- the key IS the message. This tool signs
// with a live admin key (tw.trx.sign, in rehearse()), so an error message printed
// raw can carry that key into a terminal, a CI log, or the paste someone makes to
// ask what went wrong. Scrub any 64-hex run rather than tracking which tronweb
// version happens to do it. Same helper, same reason, as deploy-permissioned.js.
//
// The scope rule, stated once here so that no call site has to re-argue it: from
// the moment the admin key is in memory (`const PK` in main) until the process
// exits, EVERY error message this tool prints goes through redact() -- including
// the read-only reads (getAccount, getCurrentBlock) and the deploy-record parse,
// none of which are handed the key. Uniform, not because those paths are suspect,
// but because "can THIS tronweb call surface PK?" is a per-version claim that
// would have to be re-verified on every dependency bump, while redact() is a
// no-op on any message with no 64-hex run in it -- so the uniform rule costs
// nothing and leaves nothing to audit.
//
// Two regions sit outside that window because no key has been read yet: the
// module-load failures above, which run before main, and selfTest(), which
// returns before PK is read and works entirely on fixtures. A third region is
// outside it for a DIFFERENT reason and must not be read as one of those two:
// --print-admin (below) reads ADMIN_PK / PRIVATE_KEY_MAINNET / PRIVATE_KEY_SHASTA
// into `pk` and derives an address from it, so a live key IS in memory there.
// Nothing leaks today only because no message in that block carries an exception:
// the address.fromPrivateKey() catch is deliberately silent -- a bad key means
// "no derived source", which the "Cannot determine the admin address" branch
// already reports -- and the disagreement warning interpolates base58 addresses
// only. So the rule for that block is narrower but strict: if you ever print that
// error (e.message is the obvious improvement to an empty catch), it goes through
// redact(), which is defined just below and already in scope there.
//
// Addresses are NOT redacted, at any site: base58 addresses are public, they are
// the whole point of the output -- the operator has to see which account signed
// the rehearsal and which account is about to receive the roles -- and 34 chars
// of base58 never matches the 64-hex pattern, so wrapping one would be a no-op
// dressed up as a control while costing every reader that line's meaning.
function redact(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/(?:0x)?[0-9a-fA-F]{64}/g, '<redacted-64-hex>');
}

// ---------------------------------------------------------------------------
// Constants pinned from an authority OUTSIDE this repo, so that a mistake in
// our own source or ABI is caught rather than mirrored. grantRole's selector
// and PAUSER_ROLE's hash are published OpenZeppelin AccessControl constants.
// ---------------------------------------------------------------------------
const PINNED = {
  'grantRole(bytes32,address)': '0x2f2ff15d',
  'revokeRole(bytes32,address)': '0xd547741f',
  'pause()': '0x8456cb59',
  'unpause()': '0x3f4ba83a',
};
const PINNED_ROLE_HASH = {
  PAUSER_ROLE: '0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a',
};

// Tron numbers each contract type. The permission's `operations` field is a
// 32-byte hex bitmap in which type N occupies bit N%8 of byte N/8.
const OP_CREATE_SMART_CONTRACT = 30;
const OP_TRIGGER_SMART_CONTRACT = 31;
const OP_NAMES = {
  0: 'AccountCreate', 1: 'Transfer', 2: 'TransferAsset', 3: 'VoteAsset',
  4: 'VoteWitness', 5: 'WitnessCreate', 6: 'AssetIssue', 8: 'WitnessUpdate',
  9: 'ParticipateAssetIssue', 10: 'AccountUpdate', 11: 'FreezeBalance',
  12: 'UnfreezeBalance', 13: 'WithdrawBalance', 14: 'UnfreezeAsset',
  15: 'UpdateAsset', 16: 'ProposalCreate', 17: 'ProposalApprove',
  18: 'ProposalDelete', 19: 'SetAccountId', 20: 'CustomContract',
  30: 'CreateSmartContract', 31: 'TriggerSmartContract', 32: 'GetContract',
  33: 'UpdateSetting', 41: 'ExchangeCreate', 42: 'ExchangeInject',
  43: 'ExchangeWithdraw', 44: 'UpdateEnergyLimit', 45: 'AccountPermissionUpdate',
  46: 'ClearABI', 48: 'UpdateBrokerage', 49: 'ShieldedTransfer',
  54: 'FreezeBalanceV2', 55: 'UnfreezeBalanceV2', 56: 'WithdrawExpireUnfreeze',
  57: 'DelegateResource', 58: 'UnDelegateResource', 59: 'CancelAllUnfreezeV2',
};

// Deliberately NOT a local copy. This is the same function scripts/admin/**
// relies on through config.writeOptions, so the self-test below exercises the
// implementation that will actually run against mainnet rather than a lookalike
// that could drift away from it.
let hasOperation, sameTronAddress;
try {
  const cfg = require(path.join(SRC, 'scripts', 'config.js'));
  hasOperation = cfg.hasOperation;
  sameTronAddress = cfg.sameTronAddress;
  if (typeof hasOperation !== 'function' || typeof sameTronAddress !== 'function') {
    throw new Error('scripts/config.js does not export hasOperation / sameTronAddress');
  }
} catch (e) {
  console.error(`Cannot load the permission helpers from ${SRC}/scripts/config.js:`);
  console.error(`  ${e.message}`);
  console.error('This tool checks the same code the admin scripts use, so it will not');
  console.error('fall back to a private copy -- that would test the wrong thing.');
  process.exit(2);
}

function listOperations(operationsHex) {
  const out = [];
  for (let n = 0; n <= 255; n++) {
    if (hasOperation(operationsHex, n)) out.push({ n, name: OP_NAMES[n] || `type${n}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------
let FAILURES = [];
let WARNINGS = [];
function ok(msg) { console.log(`     ok   ${msg}`); }
function bad(msg) { console.log(`     FAIL ${msg}`); FAILURES.push(msg); }
function warn(msg) { console.log(`     warn ${msg}`); WARNINGS.push(msg); }
function check(cond, good, failMsg) { cond ? ok(good) : bad(failMsg); return !!cond; }

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(name); }
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1]);
  process.exit(0);
}
// Side-effect free, prints one line, mirrors atum-tvm-deploy --print-source-dir.
// Step 8c needs the admin address in a shell variable and used to get it from
// $EXPECT, which is empty.
if (flag('--print-admin')) {
  const rec = (() => {
    const out = process.env.OUT || path.join(process.env.HOME || '', 'atum-v4-tvm-deploy');
    const f = path.join(out, `${(process.env.NETWORK || 'mainnet').toLowerCase()}.addresses.json`);
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
  })();
  const fromEnv = process.env.ADMIN_ADDRESS;
  const fromRec = rec && (rec.admin || rec.deployer);
  let derived = null;
  const pk = (process.env.ADMIN_PK || process.env.PRIVATE_KEY_MAINNET ||
              process.env.PRIVATE_KEY_SHASTA || '').trim().replace(/^0x/, '');
  if (/^[0-9a-fA-F]{64}$/.test(pk)) {
    try { derived = new TronWeb({ fullHost: 'http://127.0.0.1:9' }).address.fromPrivateKey(pk) || null; }
    catch (e) { derived = null; }
  }
  const admin = fromEnv || fromRec || derived;
  if (!admin) {
    console.error('Cannot determine the admin address. Set ADMIN_ADDRESS, or export ADMIN_PK, or run');
    console.error('the deploy so its record names the admin.');
    process.exit(2);
  }
  // If two sources disagree, say so on stderr rather than silently preferring one:
  // granting roles to the wrong account is not self-correcting.
  const seen = [['ADMIN_ADDRESS', fromEnv], ['the deploy record', fromRec], ['ADMIN_PK', derived]]
    .filter(([, v]) => v);
  const distinct = [...new Set(seen.map(([, v]) => v))];
  if (distinct.length > 1) {
    console.error('WARNING: the admin address is not consistent across its sources:');
    for (const [where, v] of seen) console.error(`  ${v}  (${where})`);
    console.error(`Using ${admin}. Resolve this before granting anything.`);
  }
  console.log(admin);
  process.exit(0);
}

const SELF_TEST = flag('--self-test');
const OFFLINE = flag('--offline') || SELF_TEST;

const NETWORK = (process.env.NETWORK || 'mainnet').toLowerCase();
if (!['mainnet', 'shasta'].includes(NETWORK)) {
  console.error(`NETWORK must be mainnet or shasta, got "${NETWORK}"`);
  process.exit(2);
}
const DEFAULT_API = NETWORK === 'mainnet'
  ? 'https://api.trongrid.io'
  : 'https://api.shasta.trongrid.io';
const API = process.env.TRON_RPC_URL || DEFAULT_API;

const USDT = NETWORK === 'mainnet'
  ? 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  : 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';

// The v4 fee policy, same numbers as EVM. maxFee must equal the cap the
// offchain signer uses or release AND refund revert InvalidWitnessValues on
// anything above the cap threshold; see the guide's note on 8d.
const FEE_PERCENTAGE = process.env.FEE_PERCENTAGE || '20000';       // 2 bps
const MIN_FEE = process.env.MIN_FEE || '0';
const MAX_FEE = process.env.MAX_FEE || '250000000';                 // $250, 6dp
const TOKEN_DECIMALS = 6;

// ---------------------------------------------------------------------------
// address resolution -- explicitly NOT from scripts/config.js, whose mainnet
// entries still name the v3 pair until someone edits them by hand (step 8a).
// Reading them here would rehearse against the OLD contracts and pass.
// ---------------------------------------------------------------------------
function readDeployRecord() {
  const out = process.env.OUT || path.join(process.env.HOME || '', 'atum-v4-tvm-deploy');
  const rec = path.join(out, `${NETWORK}.addresses.json`);
  if (!fs.existsSync(rec)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(rec, 'utf8'));
    const esc = j.escrow && (j.escrow.address || j.escrow);
    const fp = j.fulfillmentProxy && (j.fulfillmentProxy.address || j.fulfillmentProxy);
    if (esc && fp) return { escrow: esc, fproxy: fp, from: rec };
  } catch (e) {
    warn(`deploy record ${rec} is not readable JSON: ${redact(e.message)}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// the sequence being rehearsed -- Step 8c then 8d, in the order the guide
// specifies. TOKEN_CONFIG_ROLE must come first because 8d needs it.
// ---------------------------------------------------------------------------
function buildPlan(addresses, admin) {
  const R = (name) => ({ kind: 'role', name });
  return [
    { label: 'escrow.grantRole TOKEN_CONFIG_ROLE', to: addresses.escrow,
      sig: 'grantRole(bytes32,address)',
      params: [R('TOKEN_CONFIG_ROLE'), { kind: 'address', value: admin }] },
    { label: 'escrow.grantRole PAUSER_ROLE', to: addresses.escrow,
      sig: 'grantRole(bytes32,address)',
      params: [R('PAUSER_ROLE'), { kind: 'address', value: admin }] },
    { label: 'escrow.grantRole TREASURER_ROLE', to: addresses.escrow,
      sig: 'grantRole(bytes32,address)',
      params: [R('TREASURER_ROLE'), { kind: 'address', value: admin }] },
    { label: 'fulfillmentProxy.grantRole PAUSER_ROLE', to: addresses.fproxy,
      sig: 'grantRole(bytes32,address)',
      params: [R('PAUSER_ROLE'), { kind: 'address', value: admin }] },
    { label: 'escrow.allowTokenAndSetFeeConfig USDT', to: addresses.escrow,
      sig: 'allowTokenAndSetFeeConfig(address,uint8,uint88,uint80,uint80)',
      params: [
        { kind: 'address', value: USDT },
        { kind: 'uint8', value: TOKEN_DECIMALS },
        { kind: 'uint88', value: FEE_PERCENTAGE },
        { kind: 'uint80', value: MIN_FEE },
        { kind: 'uint80', value: MAX_FEE },
      ] },
  ];
}

function selectorOf(tw, sig) {
  return tw.utils.ethersUtils.keccak256(Buffer.from(sig, 'utf8')).slice(0, 10);
}
function roleHash(tw, name) {
  return tw.utils.ethersUtils.keccak256(Buffer.from(name, 'utf8'));
}

// A fixed block header. TronWeb fills ref_block_bytes/ref_block_hash/expiration/
// timestamp by fetching a block whenever the caller supplies none -- so a
// "local" build still talks to the node, once per transaction. Passing a header
// makes construction genuinely offline and, because those fields feed the txID,
// deterministic. The values are arbitrary: nothing here is broadcast, and a
// real send fetches a live header.
const FIXED_BLOCK_HEADER = {
  ref_block_bytes: '0f2c',
  ref_block_hash: '3a1b7c4d5e6f8091',
  expiration: 1700000060000,
  timestamp: 1700000000000,
};

// Build, sign and dissect one transaction with no network involvement.
async function rehearse(tw, step, signer, permissionId, blockHeader) {
  const types = step.sig.slice(step.sig.indexOf('(') + 1, -1).split(',');
  const parameters = step.params.map((p, i) => ({
    type: types[i],
    value: p.kind === 'role' ? roleHash(tw, p.name) : p.value,
  }));

  const options = { feeLimit: 100_000_000, callValue: 0, txLocal: true };
  if (permissionId !== undefined) options.permissionId = permissionId;
  if (blockHeader) options.blockHeader = blockHeader;

  const built = await tw.transactionBuilder.triggerSmartContract(
    step.to, step.sig, options, parameters, tw.address.toHex(signer.address)
  );
  const tx = built.transaction;
  const signed = await tw.trx.sign(tx, signer.privateKey);
  const contract = signed.raw_data.contract[0];
  const data = contract.parameter.value.data || '';

  const recoveredEth = tw.utils.ethersUtils.recoverAddress(
    '0x' + signed.txID, '0x' + signed.signature[0]
  );
  const recovered = tw.address.fromHex('41' + recoveredEth.slice(2));

  return {
    permissionIdStamped: contract.Permission_id,
    signatures: signed.signature.length,
    recovered,
    selector: '0x' + data.slice(0, 8),
    txID: signed.txID,
    to: tw.address.fromHex(contract.parameter.value.contract_address),
  };
}

// ---------------------------------------------------------------------------
// self-test: proves this tool's own machinery against pinned vectors, with no
// network and no real key. A rehearsal tool that silently does nothing is
// worse than none, so this must be runnable at any time.
// ---------------------------------------------------------------------------
async function selfTest() {
  // Point TronWeb at a closed port. Every build below supplies a block header,
  // so nothing should reach the network -- and if anything does, it fails here
  // loudly instead of passing while quietly depending on a live node. (An
  // earlier version of this self-test claimed "no network" while fetching a
  // block header per transaction, and tripped TronGrid's rate limiter.)
  const HERMETIC_HOST = 'http://127.0.0.1:9';
  console.log('admin-preflight self-test');
  console.log(`  no key material; fullHost pinned to ${HERMETIC_HOST} so any network call fails\n`);
  const tw = new TronWeb({ fullHost: HERMETIC_HOST });

  console.log('-- operations bitmap decoding');
  // Hand-decoded from the live mainnet permission of TS22r3Rg...: bytes
  // 7f ff 1f c0 03 3e c3 0f then 24 zero bytes.
  const LIVE = '7fff1fc0033ec30f' + '00'.repeat(24);
  const expectPresent = new Set([
    0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    30, 31, 32, 33, 41, 42, 43, 44, 45, 48, 49, 54, 55, 56, 57, 58, 59,
  ]);
  let mismatches = 0;
  for (let n = 0; n <= 255; n++) {
    if (hasOperation(LIVE, n) !== expectPresent.has(n)) mismatches++;
  }
  check(mismatches === 0, `all 256 operation bits decode as expected`,
    `${mismatches} operation bit(s) decoded wrongly`);
  // A bitmap with 30 but not 31 is the exact case this tool exists to catch.
  const deployOnly = Buffer.alloc(32); deployOnly[3] |= (1 << 6);
  const hexDeployOnly = deployOnly.toString('hex');
  check(hasOperation(hexDeployOnly, OP_CREATE_SMART_CONTRACT) === true &&
        hasOperation(hexDeployOnly, OP_TRIGGER_SMART_CONTRACT) === false,
    'a deploy-only bitmap is distinguished from a call-capable one',
    'op 30 and op 31 are not distinguished -- the central check is broken');
  for (const junk of [undefined, null, 123, 'zz', '0x12', {}]) {
    let threw = false;
    try { hasOperation(junk, 31); } catch (e) { threw = true; }
    if (!threw) bad(`hasOperation(${JSON.stringify(junk)}) returned instead of throwing`);
  }
  ok('malformed operations fields throw rather than reading as "absent"');

  console.log('\n-- selectors and role hashes against pinned external constants');
  for (const [sig, want] of Object.entries(PINNED)) {
    const got = selectorOf(tw, sig);
    check(got === want, `${sig} = ${want}`, `${sig} computed ${got}, pinned ${want}`);
  }
  for (const [role, want] of Object.entries(PINNED_ROLE_HASH)) {
    const got = roleHash(tw, role);
    check(got === want, `keccak256("${role}") matches the published constant`,
      `keccak256("${role}") computed ${got}, pinned ${want}`);
  }
  // The uint88/uint80 signature is easy to get wrong as uint256; prove the two
  // differ, so a wrong guess could not silently pass.
  const right = selectorOf(tw, 'allowTokenAndSetFeeConfig(address,uint8,uint88,uint80,uint80)');
  const wrong = selectorOf(tw, 'allowTokenAndSetFeeConfig(address,uint8,uint256,uint256,uint256)');
  check(right !== wrong,
    `the uint88/uint80 signature (${right}) differs from a uint256 guess (${wrong})`,
    'the two signatures collide, so the type check proves nothing');

  console.log('\n-- transaction construction and signing');
  const PK = '0000000000000000000000000000000000000000000000000000000000000001';
  const signer = { privateKey: PK, address: tw.address.fromPrivateKey(PK) };
  const plan = buildPlan({ escrow: 'TLea6C58GyirmvcT2csY6FaRdF45WZjW95',
                           fproxy: 'TPeKaatrDGKaQEAhjD6P7MJE96ShXcZpwc' }, signer.address);

  const withPid = await rehearse(tw, plan[0], signer, 2, FIXED_BLOCK_HEADER);
  check(withPid.permissionIdStamped === 2,
    'permissionId 2 lands in raw_data.contract[0].Permission_id',
    `Permission_id came out as ${JSON.stringify(withPid.permissionIdStamped)}`);
  const withoutPid = await rehearse(tw, plan[0], signer, undefined, FIXED_BLOCK_HEADER);
  check(withoutPid.permissionIdStamped === undefined,
    'omitting permissionId leaves Permission_id absent (legacy behaviour preserved)',
    `Permission_id was ${JSON.stringify(withoutPid.permissionIdStamped)} when none was asked for`);
  check(withPid.txID !== withoutPid.txID,
    'Permission_id changes the txID, so it is covered by the signature',
    'the txID is identical with and without Permission_id -- it is NOT signed over');
  check(withPid.recovered === signer.address,
    'the signature recovers to the signing key',
    `recovered ${withPid.recovered}, expected ${signer.address}`);
  check(withPid.signatures === 1,
    'a single signature is produced', `got ${withPid.signatures} signatures`);

  // Tamper detection: if Permission_id could be edited after signing without
  // invalidating anything, the whole mechanism would be forgeable in transit.
  const tw2 = tw;
  const built = await tw2.transactionBuilder.triggerSmartContract(
    plan[0].to, plan[0].sig,
    { feeLimit: 100_000_000, callValue: 0, txLocal: true, permissionId: 2,
      blockHeader: FIXED_BLOCK_HEADER },
    [{ type: 'bytes32', value: roleHash(tw2, 'TOKEN_CONFIG_ROLE') },
     { type: 'address', value: signer.address }],
    tw2.address.toHex(signer.address)
  );
  const signedTx = await tw2.trx.sign(built.transaction, PK);
  const tampered = JSON.parse(JSON.stringify(signedTx));
  tampered.raw_data.contract[0].Permission_id = 3;
  const newTxID = tw2.utils.transaction
    .txPbToTxID(tw2.utils.transaction.txJsonToPb(tampered)).replace(/^0x/, '');
  const tamperedSigner = tw2.address.fromHex('41' + tw2.utils.ethersUtils
    .recoverAddress('0x' + newTxID, '0x' + signedTx.signature[0]).slice(2));
  check(newTxID !== signedTx.txID && tamperedSigner !== signer.address,
    'editing Permission_id after signing invalidates the signature',
    'Permission_id can be swapped after signing without breaking the signature');

  console.log('\n-- every step in the plan builds');
  for (const step of plan) {
    const r = await rehearse(tw, step, signer, 2, FIXED_BLOCK_HEADER);
    const want = selectorOf(tw, step.sig);
    check(r.selector === want && r.permissionIdStamped === 2 && r.recovered === signer.address,
      `${step.label}  selector ${r.selector}`,
      `${step.label}: selector ${r.selector} (want ${want}), Permission_id ${r.permissionIdStamped}, signer ${r.recovered}`);
  }

  // -------------------------------------------------------------------------
  // config.writeOptions is the production plumbing: it is what every
  // scripts/admin/** send site now calls. Constructing transactions correctly
  // (above) proves nothing about whether the real path reaches that code, so
  // exercise it directly, with the account read stubbed so the failure branches
  // are reachable without needing accounts that are shaped that way on chain.
  // -------------------------------------------------------------------------
  console.log('\n-- config.writeOptions, the path the admin scripts take');
  const cfg = require(path.join(SRC, 'scripts', 'config.js'));
  const SIGNER = 'TS22r3RgJdHxDp1VvkKFT1buep8usUsRxe';
  const OTHER = 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC';
  // wallet/getaccount hands back permission keys as 41-prefixed hex, NOT base58.
  // An earlier version of this stub used base58 -- which is what `curl` with
  // visible:true returns -- and so passed while the real code could never match
  // a key and rejected every valid account. The stub now uses the encoding the
  // library actually produces, and both encodings are asserted below.
  const SIGNER_HEX = '41b00ac877e1f367ecf2c0c9113c38414b84f99958';
  const OTHER_HEX = '41c0a3f4b8e0d1c2a3b4c5d6e7f8091a2b3c4d5e6f';
  const CALLABLE = '7fff1fc0033ec30f' + '00'.repeat(24);      // real mainnet bitmap: op 31 set
  const deployOnlyBuf = Buffer.alloc(32); deployOnlyBuf[3] |= (1 << 6);
  const DEPLOY_ONLY = deployOnlyBuf.toString('hex');           // op 30 set, op 31 clear

  // Only the surface config.js touches is stubbed; address encoding comes from
  // the real library, since a hand-rolled fromHex is exactly the kind of stub
  // that agrees with a buggy caller and hides the defect it should expose.
  function fakeTronWeb(account) {
    let reads = 0;
    return {
      defaultAddress: { base58: SIGNER },
      address: tw.address,
      trx: { getAccount: async () => { reads++; return account; } },
      reads: () => reads,
    };
  }
  const account = (perm) => ({
    address: '41...', owner_permission: { threshold: 2, keys: [1, 2, 3] },
    active_permission: perm ? [perm] : [],
  });
  const permission = (over = {}) => Object.assign({
    id: 2, permission_name: 'active', threshold: 1,
    operations: CALLABLE, keys: [{ address: SIGNER_HEX, weight: 1 }],
  }, over);

  const savedEnv = process.env[cfg.PERMISSION_ENV];
  async function withEnv(value, fn) {
    if (value === undefined) delete process.env[cfg.PERMISSION_ENV];
    else process.env[cfg.PERMISSION_ENV] = value;
    try { return await fn(); } finally {
      if (savedEnv === undefined) delete process.env[cfg.PERMISSION_ENV];
      else process.env[cfg.PERMISSION_ENV] = savedEnv;
    }
  }
  async function expectThrow(label, value, acct, fragment) {
    await withEnv(value, async () => {
      const tw = fakeTronWeb(acct);
      try {
        await cfg.writeOptions(tw);
        bad(`${label}: writeOptions returned instead of throwing`);
      } catch (e) {
        check(e.message.includes(fragment), `${label} -> rejected`,
          `${label}: rejected, but the message did not mention "${fragment}" (got: ${e.message})`);
      }
    });
  }

  // the default path must be untouched: no permissionId, and no account read
  await withEnv(undefined, async () => {
    const tw = fakeTronWeb(account(permission()));
    const opts = await cfg.writeOptions(tw);
    check(!('permissionId' in opts) && tw.reads() === 0,
      'unset: no permissionId added and the account is never read (legacy path unchanged)',
      `unset: got permissionId=${JSON.stringify(opts.permissionId)} after ${tw.reads()} account read(s)`);
    check(opts.feeLimit === cfg.SETTINGS.FEE_LIMIT,
      'unset: the fee limit still comes from SETTINGS',
      `unset: feeLimit was ${opts.feeLimit}`);
  });

  // the permissioned path. Wrapped, because an unexpected throw here would abort
  // the whole self-test and hide every check after it -- the run that found the
  // hex/base58 defect died at this line and never reached the encoding cases.
  await withEnv('2', async () => {
    const tw = fakeTronWeb(account(permission()));
    try {
      const opts = await cfg.writeOptions(tw);
      check(opts.permissionId === 2, 'set to 2: permissionId 2 is added to the send options',
        `set to 2: permissionId came out as ${JSON.stringify(opts.permissionId)}`);
      const before = tw.reads();
      await cfg.writeOptions(tw);
      check(tw.reads() === before, 'the permission check is cached, not re-read per transaction',
        `the account was read again (${before} -> ${tw.reads()})`);
    } catch (e) {
      bad(`set to 2: writeOptions threw on a valid account -- ${e.message}`);
    }
  });

  // The encoding of the key list must not decide the outcome. hex is what the
  // library returns; base58 is what a hand-written fixture or a visible:true
  // curl returns; both name the same account and both must be accepted.
  for (const [label, keys] of [
    ['hex key list (what wallet/getaccount returns)', [{ address: SIGNER_HEX, weight: 1 }]],
    ['base58 key list', [{ address: SIGNER, weight: 1 }]],
    ['mixed list, ours in hex', [{ address: OTHER, weight: 1 }, { address: SIGNER_HEX, weight: 1 }]],
  ]) {
    await withEnv('2', async () => {
      const tw = fakeTronWeb(account(permission({ keys, threshold: 1 })));
      try {
        const opts = await cfg.writeOptions(tw);
        check(opts.permissionId === 2, `${label} -> accepted`,
          `${label}: accepted but permissionId was ${JSON.stringify(opts.permissionId)}`);
      } catch (e) {
        bad(`${label}: rejected a valid account -- ${e.message}`);
      }
    });
  }
  // ...and a key that genuinely is not ours must still be rejected in either encoding.
  await expectThrow('signer absent, other key in hex', '2',
    account(permission({ keys: [{ address: OTHER_HEX, weight: 1 }] })), 'not among the keys');

  // every rejection branch
  await expectThrow('0 (owner permission)', '0', account(permission()), 'OWNER permission');
  await expectThrow('1 (witness permission)', '1', account(permission()), 'witness permission');
  await expectThrow('non-numeric', 'two', account(permission()), 'not a non-negative integer');
  await expectThrow('no such permission id', '9', account(permission()), 'no active permission with id 9');
  await expectThrow('account does not exist', '2', { }, 'does not exist on chain');
  await expectThrow('deploy-only permission', '2',
    account(permission({ operations: DEPLOY_ONLY })), 'TriggerSmartContract');
  await expectThrow('signer is not a listed key', '2',
    account(permission({ keys: [{ address: OTHER, weight: 1 }] })), 'not among the keys');
  await expectThrow('weight below threshold', '2',
    account(permission({ threshold: 2, keys: [{ address: SIGNER, weight: 1 }] })),
    'weight is only 1');

  // -------------------------------------------------------------------------
  // A static guard. The plumbing only works if every admin script actually goes
  // through writeOptions; a new script with a hand-rolled options object would
  // silently sign against the owner permission and be rejected on mainnet.
  // -------------------------------------------------------------------------
  console.log('\n-- no send site bypasses writeOptions');
  const scriptsDir = path.join(SRC, 'scripts');
  function walk(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else if (e.name.endsWith('.js') && e.name !== 'config.js') out.push(full);
    }
    return out;
  }
  const offenders = [];
  let sendSites = 0;
  for (const file of walk(scriptsDir)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!line.includes('.send(')) return;
      sendSites++;
      if (!line.includes('config.writeOptions')) {
        offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  check(sendSites > 0, `found ${sendSites} transaction send site(s) to check`,
    'found NO send sites -- this guard would pass no matter what, so it is broken');
  if (offenders.length) {
    bad(`${offenders.length} send site(s) bypass config.writeOptions`);
    for (const o of offenders) console.log(`            ${o}`);
  } else {
    ok(`all ${sendSites} send site(s) route through config.writeOptions`);
  }

  console.log(`\n${'='.repeat(60)}`);
  if (FAILURES.length) {
    console.log(`SELF-TEST FAILED -- ${FAILURES.length} check(s) did not pass:`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log('SELF-TEST PASSED -- the preflight machinery works.');
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  if (SELF_TEST) process.exit(await selfTest());

  const PK_VAR = NETWORK === 'mainnet' ? 'PRIVATE_KEY_MAINNET' : 'PRIVATE_KEY_SHASTA';
  const rawKey = process.env.ADMIN_PK || process.env[PK_VAR];
  if (!rawKey) {
    console.error(`No admin key. Set ADMIN_PK (what scripts/admin/** reads) or ${PK_VAR}:`);
    console.error(`  export ADMIN_PK="$(cat "\${ATUM_HOME:-$HOME/.atum}/keys/tron-${NETWORK}")"`);
    process.exit(2);
  }
  const PK = String(rawKey).trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(PK)) {
    console.error(`The admin key is not 64 hex characters (got ${PK.length}). ` +
                  `A key file with a trailing newline or a truncated paste looks like this.`);
    process.exit(2);
  }

  const tw = new TronWeb({
    fullHost: API,
    privateKey: PK,
    headers: process.env.TRON_API_KEY
      ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY }
      : undefined,
  });
  const signer = { privateKey: PK, address: tw.address.fromPrivateKey(PK) };

  const record = readDeployRecord();

  // Two env spellings, because the sibling tool in this directory grew the shorter
  // pair and an operator who exports one and runs the other should not silently get
  // the record instead of what they asked for. Canonical names match config.js's
  // field names; ESCROW / FPROXY are accepted aliases.
  const envEscrow = process.env.ESCROW_ADDRESS || process.env.ESCROW;
  const envFproxy = process.env.FULFILLMENT_PROXY_ADDRESS || process.env.FPROXY;
  // A half-set override is a mistake, not a request to fall back: it would rehearse
  // one new contract against one old one and report READY.
  if (!!envEscrow !== !!envFproxy) {
    console.error(`Only one of the address overrides is set (escrow ${envEscrow ? 'set' : 'unset'}, ` +
      `proxy ${envFproxy ? 'set' : 'unset'}).`);
    console.error('Set both or neither -- one new address against one stale one would rehearse a');
    console.error('pair that does not exist, and pass.');
    process.exit(2);
  }
  // Track WHERE each address came from rather than inferring it by comparing values:
  // an env override that happens to equal the record was being labelled "from the
  // deploy record", which is the wrong provenance for the one line whose job is
  // provenance.
  const flagEscrow = opt('--escrow', null);
  const flagFproxy = opt('--fproxy', null);
  const escrow = flagEscrow || envEscrow || (record && record.escrow);
  const fproxy = flagFproxy || envFproxy || (record && record.fproxy);
  const escrowFrom = flagEscrow ? '--escrow' : envEscrow ? 'env' : record ? 'the deploy record' : null;
  const fproxyFrom = flagFproxy ? '--fproxy' : envFproxy ? 'env' : record ? 'the deploy record' : null;
  const admin = opt('--admin', process.env.ADMIN_ADDRESS || signer.address);

  console.log(`network      : ${NETWORK}`);
  console.log(`api          : ${API}${process.env.TRON_API_KEY ? '  (api key set)' : ''}`);
  console.log(`signer       : ${signer.address}`);
  console.log(`role grantee : ${admin}${admin === signer.address ? '  (same as signer)' : ''}`);
  console.log(`mode         : REHEARSAL -- transactions are built and signed locally, never sent`);

  if (!escrow || !fproxy) {
    console.error('');
    console.error('The v4 contract addresses are not known.');
    console.error('Tron has no CREATE2, so they only exist after the deploy transaction lands.');
    console.error('Supply them once you have them:');
    console.error('  node admin-preflight.js --escrow T... --fproxy T...');
    console.error(`or let this read the deploy record written by deploy-permissioned.js at`);
    console.error(`  \${OUT:-$HOME/atum-v4-tvm-deploy}/${NETWORK}.addresses.json`);
    console.error('');
    console.error('Deliberately NOT read from scripts/config.js: its mainnet entries still name');
    console.error('the v3 pair until step 8a edits them, so rehearsing against it would pass');
    console.error('while testing the wrong contracts.');
    process.exit(2);
  }
  console.log(`escrow       : ${escrow}${escrowFrom ? `  (from ${escrowFrom})` : ''}`);
  console.log(`fproxy       : ${fproxy}${fproxyFrom ? `  (from ${fproxyFrom})` : ''}`);
  if (record) console.log(`record       : ${record.from}`);

  const rawPid = process.env.TRON_PERMISSION_ID;
  let permissionId;
  if (rawPid !== undefined && rawPid !== '') {
    if (!/^[0-9]+$/.test(String(rawPid).trim())) {
      console.error(`\nTRON_PERMISSION_ID="${rawPid}" is not a non-negative integer.`);
      process.exit(2);
    }
    permissionId = parseInt(String(rawPid).trim(), 10);
    if (permissionId === 0 || permissionId === 1) {
      console.error(`\nTRON_PERMISSION_ID=${permissionId} is the ` +
        `${permissionId === 0 ? 'owner' : 'witness'} permission. Active ids start at 2.`);
      process.exit(2);
    }
  }
  console.log(`permission   : ${permissionId === undefined
    ? 'OWNER (TRON_PERMISSION_ID unset)' : `ACTIVE id ${permissionId}`}`);

  // -- the permission itself
  if (permissionId !== undefined && !OFFLINE) {
    console.log('\n-- the active permission, read from chain');
    let account;
    try {
      account = await tw.trx.getAccount(signer.address);
    } catch (e) {
      console.error(`     could not read ${signer.address}: ${redact(e.message)}`);
      console.error('     re-run with --offline to check only what can be checked locally.');
      process.exit(2);
    }
    if (!account || !account.address) {
      bad(`${signer.address} does not exist on chain, so it has no permissions`);
    } else {
      const owner = account.owner_permission || {};
      console.log(`     owner permission threshold ${owner.threshold} over ${(owner.keys || []).length} key(s)`);
      const perm = (account.active_permission || []).find((p) => Number(p.id) === permissionId);
      if (!perm) {
        const ids = (account.active_permission || []).map((p) => p.id).join(', ') || '(none)';
        bad(`no active permission with id ${permissionId}; ids present: ${ids}`);
      } else {
        const ops = listOperations(perm.operations);
        console.log(`     permission ${permissionId} "${perm.permission_name}" threshold ${perm.threshold}, ` +
                    `${(perm.keys || []).length} key(s), ${ops.length} operation(s)`);

        check(hasOperation(perm.operations, OP_TRIGGER_SMART_CONTRACT),
          `includes TriggerSmartContract (op ${OP_TRIGGER_SMART_CONTRACT}) -- it can call contracts`,
          `does NOT include TriggerSmartContract (op ${OP_TRIGGER_SMART_CONTRACT}); ` +
          `every role grant would be rejected. Note op ${OP_CREATE_SMART_CONTRACT} ` +
          `(CreateSmartContract, ${hasOperation(perm.operations, OP_CREATE_SMART_CONTRACT) ? 'present' : 'absent'}) is a different bit`);

        const mine = (perm.keys || []).find((k) => sameTronAddress(tw, k.address, signer.address));
        if (!check(!!mine, `${signer.address} is a listed key of this permission`,
              `${signer.address} is not among this permission's keys, so it cannot sign against it`)) {
          // nothing further to say about weight
        } else {
          check(Number(mine.weight) >= Number(perm.threshold),
            `this key's weight ${mine.weight} meets the threshold ${perm.threshold} -- one signature is enough`,
            `this key's weight is ${mine.weight} but the threshold is ${perm.threshold}, ` +
            `so a single signature falls short and co-signers are required`);
        }

        // Not a gate, but the operator should know: an active permission that
        // can move value or rewrite permissions makes the owner multisig much
        // weaker than its threshold suggests.
        const notable = [
          [1, 'Transfer (can move TRX alone)'],
          [45, 'AccountPermissionUpdate (can rewrite this account\'s permissions)'],
        ].filter(([n]) => hasOperation(perm.operations, n));
        if (notable.length) {
          console.log('');
          for (const [n, why] of notable) {
            warn(`permission ${permissionId} is threshold ${perm.threshold} and includes op ${n} ${why}`);
          }
        }
      }
    }
  } else if (permissionId !== undefined) {
    warn('skipping the on-chain permission read (--offline); only local construction is checked');
  }

  // -- the transactions
  console.log('\n-- every transaction in the 8c/8d sequence, built and signed locally');
  // One header for the whole plan. Left to itself TronWeb fetches one PER
  // transaction, which is five round trips to say the same thing and enough to
  // trip TronGrid's rate limiter on a keyless run.
  let planHeader = OFFLINE ? FIXED_BLOCK_HEADER : undefined;
  if (!OFFLINE) {
    try {
      const block = await tw.trx.getCurrentBlock();
      planHeader = {
        ref_block_bytes: block.block_header.raw_data.number.toString(16).slice(-4).padStart(4, '0'),
        ref_block_hash: block.blockID.slice(16, 32),
        expiration: block.block_header.raw_data.timestamp + 60 * 1000,
        timestamp: block.block_header.raw_data.timestamp,
      };
    } catch (e) {
      warn(`could not fetch a block header (${redact(e.message)}); using a fixed one. ` +
           `Construction is still checked; only the ref_block fields are not live.`);
      planHeader = FIXED_BLOCK_HEADER;
    }
  }
  const plan = buildPlan({ escrow, fproxy }, admin);
  for (const step of plan) {
    let r;
    try {
      r = await rehearse(tw, step, signer, permissionId, planHeader);
    } catch (e) {
      bad(`${step.label}: could not build -- ${redact(e.message)}`);
      continue;
    }
    const wantSelector = selectorOf(tw, step.sig);
    const pidOk = permissionId === undefined
      ? r.permissionIdStamped === undefined
      : r.permissionIdStamped === permissionId;
    const allOk = pidOk && r.selector === wantSelector &&
                  r.recovered === signer.address && r.signatures === 1 && r.to === step.to;
    if (allOk) {
      ok(`${step.label}`);
      console.log(`            selector ${r.selector}  Permission_id ${
        r.permissionIdStamped === undefined ? '(owner)' : r.permissionIdStamped
      }  signatures ${r.signatures}  -> ${r.to}`);
    } else {
      bad(`${step.label}`);
      if (!pidOk) console.log(`            Permission_id is ${JSON.stringify(r.permissionIdStamped)}, expected ${
        permissionId === undefined ? 'absent' : permissionId}`);
      if (r.selector !== wantSelector) console.log(`            selector ${r.selector}, expected ${wantSelector}`);
      if (r.recovered !== signer.address) console.log(`            signature recovers to ${r.recovered}, expected ${signer.address}`);
      if (r.signatures !== 1) console.log(`            ${r.signatures} signatures, expected 1`);
      if (r.to !== step.to) console.log(`            addressed to ${r.to}, expected ${step.to}`);
    }
  }

  // -- verdict
  console.log(`\n${'='.repeat(60)}`);
  if (FAILURES.length) {
    console.log(`NOT READY -- ${FAILURES.length} check(s) failed:`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    console.log('\nNothing was broadcast.');
    process.exit(1);
  }
  console.log('READY -- every transaction builds, carries the intended permission, and is');
  console.log('signed by the expected key. Nothing was broadcast.');
  if (WARNINGS.length) {
    console.log(`\n${WARNINGS.length} warning(s) above are worth reading before you proceed.`);
  }
  console.log('\nTo execute for real, run the admin scripts with the permission set:');
  console.log(`  cd ${SRC}`);
  console.log(`  export ADMIN_PK=...            # the same key this rehearsed with`);
  if (permissionId !== undefined) console.log(`  export TRON_PERMISSION_ID=${permissionId}`);
  console.log(`  node scripts/admin/access-control/grant-role.js ${NETWORK} escrow            TOKEN_CONFIG_ROLE ${admin}`);
  console.log(`  node scripts/admin/access-control/grant-role.js ${NETWORK} escrow            PAUSER_ROLE       ${admin}`);
  console.log(`  node scripts/admin/access-control/grant-role.js ${NETWORK} escrow            TREASURER_ROLE    ${admin}`);
  console.log(`  node scripts/admin/access-control/grant-role.js ${NETWORK} fulfillment-proxy PAUSER_ROLE       ${admin}`);
  console.log(`  node scripts/admin/token-config/allow-token-and-set-fee-config.js \\`);
  console.log(`      ${NETWORK} ${USDT} ${TOKEN_DECIMALS} ${FEE_PERCENTAGE} ${MIN_FEE} ${MAX_FEE}`);
  console.log('');
  console.log('Those scripts read the addresses from scripts/config.js, so step 8a (editing the');
  console.log(`${NETWORK} entries to the v4 pair) has to be done first or they will target v3.`);
  process.exit(0);
})().catch((e) => {
  console.error(`\nFAILED: ${redact(e && e.message ? e.message : e)}`);
  process.exit(2);
});
