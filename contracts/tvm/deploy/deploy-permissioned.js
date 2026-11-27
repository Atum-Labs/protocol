#!/usr/bin/env node
/**
 * Deploy the v4 Tron contracts from an account whose OWNER permission needs more signatures than
 * we have, by naming an ACTIVE permission that does not.
 *
 * Why this exists. tronbox signs against permission_id 0 (owner) and has no way to select another
 * -- grep the repo for permission_id: nothing. An account whose owner permission is 2-of-3 is
 * therefore undeployable with tronbox, even when its own active permission is threshold 1 and
 * includes CreateSmartContract. That is exactly the shape of the v4 mainnet admin, so the choice
 * was to change the admin or to build this. Keeping the admin means v4's defaultAdmin matches what
 * is already live, with no role migration and nobody else signing.
 *
 * What it does NOT do: it does not replace tronbox for shasta or nile, where the deployer is
 * threshold 1 and `tronbox migrate` is simpler and better tested. Use this only where a
 * permission_id is actually required.
 *
 *   node deploy-permissioned.js --dry            # build + sign + report, broadcast NOTHING
 *   node deploy-permissioned.js --broadcast      # really deploy
 *
 * Environment:
 *   PRIVATE_KEY_MAINNET   bare 64-hex, no 0x     (required; never logged)
 *   TRON_RPC_URL          default https://api.trongrid.io
 *   TRON_API_KEY          sent as TRON-PRO-API-KEY; TronGrid rate-limits hard without it
 *   PERMISSION_ID         default 2
 *   DEFAULT_ADMIN         defaults to the deployer, matching the tronbox migration
 *   FEE_LIMIT             default 15000000000 sun (15,000 TRX, the chain maximum)
 *   USER_FEE_PERCENTAGE   default 100  (mainnet value from tronbox-config.js)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// tronweb lives in contracts/tvm/source/node_modules, and this script lives in contracts/tvm/deploy.
// Node resolves modules by walking UP from the requiring file, never sideways, so a bare
// require('tronweb') fails here with MODULE_NOT_FOUND. Resolve it from the source tree explicitly.
// deploy.sh resolves the source tree from the CWD and validates that tree. If this
// script recomputed the path from its own location the two could differ, so the
// artifact deployed would not be the artifact that was checked -- and the operator
// would see deploy.sh name one tree while the bytecode came from another. SRC_DIR
// is how deploy.sh tells us which tree it validated.
const SRC = process.env.SRC_DIR
  ? path.resolve(process.env.SRC_DIR)
  : path.resolve(__dirname, '../source');
let TronWeb;
try {
  ({ TronWeb } = createRequire(path.join(SRC, 'package.json'))('tronweb'));
} catch (e) {
  console.error(`cannot load tronweb from ${SRC}/node_modules`);
  console.error(`  run: (cd ${SRC} && pnpm install --ignore-workspace)`);
  process.exit(1);
}

// tronweb constructs two of its multiSign errors as `privateKey + ' has no
// permission to sign'` (lib/trx.js:493 and :496) -- the key IS the message. So
// printing e.message raw writes a live mainnet private key to stdout, in exactly
// the failure someone pastes into a chat to ask what went wrong. Scrub any 64-hex
// run from everything this script prints, rather than tracking which library
// version happens to do it.
function redact(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/(?:0x)?[0-9a-fA-F]{64}/g, '<redacted-64-hex>');
}

const MODE = process.argv.includes('--broadcast') ? 'broadcast'
           : process.argv.includes('--dry') ? 'dry' : null;
if (!MODE) {
  console.error('usage: deploy-permissioned.js --dry | --broadcast');
  process.exit(2);
}

const RPC = process.env.TRON_RPC_URL || 'https://api.trongrid.io';
const PERMISSION_ID = Number(process.env.PERMISSION_ID || 2);
const FEE_LIMIT = Number(process.env.FEE_LIMIT || 15000000000);
const USER_FEE_PERCENTAGE = Number(process.env.USER_FEE_PERCENTAGE || 100);

const PK = (process.env.PRIVATE_KEY_MAINNET || '').trim().replace(/^0x/i, '');
if (!/^[0-9a-fA-F]{64}$/.test(PK)) {
  console.error('PRIVATE_KEY_MAINNET must be 64 hex characters (no 0x). Not set, or malformed.');
  process.exit(1);
}

// Mainnet constants. Deliberately duplicated from scripts/config.js rather than imported: that
// module require()s the Permit2 ABI out of node_modules and cannot load in a bare checkout, and
// this script must work with nothing but tronweb installed.
const PERMIT2 = process.env.PERMIT2_ADDRESS || 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m';
const USDT    = process.env.USDT_ADDRESS    || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const headers = process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {};
const tronWeb = new TronWeb({ fullHost: RPC, headers, privateKey: PK });

function artifact(name) {
  const p = path.join(SRC, 'build/contracts', `${name}.json`);
  if (!fs.existsSync(p)) {
    console.error(`missing ${p} — run: (cd ${SRC} && npx tronbox compile)`);
    process.exit(1);
  }
  const a = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!a.bytecode || a.bytecode.length < 10) {
    console.error(`${name}.json has no bytecode`);
    process.exit(1);
  }
  return a;
}

// The witness typehashes the widened escrow must pin, and the pre-widening ones it
// must NOT. Checked HERE as well as in deploy.sh: this script can be run directly, and deploying a
// contract that pins the old shape reverts every deposit at signature verification with nothing
// failing at deploy time.
const MUST_HAVE = [
  ['DepositWitness', '49bfb2c307c3a420'],
  ['ReserveWitness', '231586e09714868d'],
  ['ReleaseWitness', '7b53386f16fef70a'],
  ['RefundWitness',  '3b5d88b266408664'],
];
const MUST_NOT = [
  ['V1 DepositWitness', 'bcc7a43f42a7faf5'],
  ['V1 ReserveWitness', '64c29c15f679cf6b'],
];
function assertWidened(bytecodeHex) {
  const bc = bytecodeHex.toLowerCase();
  let bad = 0;
  for (const [n, h] of MUST_HAVE) {
    const ok = bc.includes(h);
    console.log(`     ${ok ? 'ok  ' : 'FAIL'} ${n} ${ok ? 'present' : 'MISSING'}`);
    if (!ok) bad++;
  }
  for (const [n, h] of MUST_NOT) {
    const ok = !bc.includes(h);
    console.log(`     ${ok ? 'ok  ' : 'FAIL'} ${n} ${ok ? 'absent as expected' : 'PRESENT — pre-widening shape'}`);
    if (!ok) bad++;
  }
  if (bad) {
    console.error('\nREFUSING: the compiled escrow does not pin the widened witness typehashes.');
    console.error('Deploying it would revert every deposit at signature verification, and nothing');
    console.error('would fail at deploy time. Rebuild from the v4 source.');
    process.exit(1);
  }
}

async function deployOne(name, parameters) {
  const a = artifact(name);
  const tx = await tronWeb.transactionBuilder.createSmartContract({
    abi: a.abi,
    bytecode: a.bytecode,
    feeLimit: FEE_LIMIT,
    callValue: 0,
    userFeePercentage: USER_FEE_PERCENTAGE,
    originEnergyLimit: 1e7,
    parameters,
    name,
  }, tronWeb.defaultAddress.hex);

  // permissionId is the whole point. multiSign stamps Permission_id on the contract and signs with
  // the key; with the default 0 the network checks it against the OWNER threshold and rejects a
  // lone signature.
  const signed = await tronWeb.trx.multiSign(tx, PK, PERMISSION_ID);
  const sigs = (signed.signature || []).length;
  const stampedId = signed.raw_data?.contract?.[0]?.Permission_id;
  console.log(`     signatures ${sigs}   Permission_id ${stampedId === undefined ? '0 (owner)' : stampedId}`);
  if (stampedId !== PERMISSION_ID) {
    console.error(`\nREFUSING: Permission_id came out as ${stampedId}, expected ${PERMISSION_ID}.`);
    console.error('Broadcasting would be checked against the owner threshold and rejected.');
    process.exit(1);
  }

  const predicted = tronWeb.address.fromHex(signed.contract_address);
  if (MODE === 'dry') {
    // Tron has no CREATE2. The contract address derives from the txID, i.e. from raw_data --
    // which carries ref_block_bytes, ref_block_hash, timestamp and expiration. Two dry runs
    // seconds apart therefore yield two different addresses, and NEITHER is the address a real
    // broadcast will produce. Do not let this read as a prediction: writing it into config is a
    // silent, plausible-looking mistake that only shows up as calls to an empty account.
    console.log(`     signed OK, Permission_id stamped — nothing broadcast`);
    console.log(`     this run's address would have been ${predicted}`);
    console.log(`     NOT a prediction: Tron addresses come from the txID, so a real broadcast`);
    console.log(`     produces a DIFFERENT one. Take the address from the broadcast, never here.`);
    return { name, address: predicted, broadcast: false };
  }
  const res = await tronWeb.trx.sendRawTransaction(signed);
  if (!res.result) {
    // The txID is ours, computed locally, and is public data -- print it before the
    // redacted payload, because redact() masks any 64-hex run and would otherwise
    // swallow the one identifier needed to look this up on a block explorer.
    console.error(`     txID (unbroadcast or rejected): ${signed.txID}`);
    console.error(`     BROADCAST FAILED: ${redact(JSON.stringify(res)).slice(0, 400)}`);
    console.error('     (64-hex runs above are masked: tronweb puts the signing key in some');
    console.error('      error messages, so nothing on this path is printed raw.)');
    process.exit(1);
  }
  console.log(`     txid ${res.txid}`);
  console.log(`     deployed at ${predicted}`);
  return { name, address: predicted, txid: res.txid, broadcast: true };
}

(async () => {
  const deployer = tronWeb.address.fromPrivateKey(PK);
  if (!deployer) { console.error('could not derive an address from PRIVATE_KEY_MAINNET'); process.exit(1); }
  const admin = process.env.DEFAULT_ADMIN || deployer;

  console.log(`mode          : ${MODE === 'broadcast' ? 'BROADCAST — real transactions' : 'DRY — nothing is sent'}`);
  console.log(`rpc           : ${RPC}${process.env.TRON_API_KEY ? '  (api key set)' : '  (NO api key — expect rate limiting)'}`);
  console.log(`deployer      : ${deployer}`);
  console.log(`defaultAdmin  : ${admin}${admin === deployer ? '  (same as deployer)' : '  (DIFFERENT from deployer)'}`);
  console.log(`permission_id : ${PERMISSION_ID}`);
  // Provenance of the bytecode about to be deployed. Without this the operator can
  // only see the tree deploy.sh resolved, which is not necessarily this one.
  console.log(`source tree   : ${SRC}${process.env.SRC_DIR ? '  (from SRC_DIR)' : '  (beside this script)'}`);
  console.log(`feeLimit      : ${(FEE_LIMIT / 1e6).toLocaleString()} TRX   userFeePercentage ${USER_FEE_PERCENTAGE}`);

  // Confirm the account actually grants what we are about to claim, rather than discovering it
  // in a broadcast rejection.
  const acct = await tronWeb.trx.getAccount(deployer);
  const ap = (acct.active_permission || []).find(p => p.id === PERMISSION_ID);
  if (!ap) {
    console.error(`\nREFUSING: ${deployer} has no active permission with id ${PERMISSION_ID}.`);
    process.exit(1);
  }
  const ops = Buffer.from(ap.operations || '', 'hex');
  const can = t => (ops[t >> 3] >> (t & 7)) & 1;
  console.log(`permission    : id=${ap.id} threshold=${ap.threshold} CreateSmartContract=${!!can(30)}`);
  if (ap.threshold > 1) {
    console.error(`\nREFUSING: active permission ${PERMISSION_ID} needs ${ap.threshold} signatures; this script signs once.`);
    process.exit(1);
  }
  // Being listed on the permission is separate from the permission existing.
  // wallet/getaccount returns these keys as 41-prefixed HEX while `deployer` is
  // base58, so compare canonically -- a raw === is always false and would reject
  // every valid account while printing that same key back.
  const norm = (a) => (/^41[0-9a-fA-F]{40}$/.test(a || '') ? tronWeb.address.fromHex(a) : a);
  const mine = (ap.keys || []).find((k) => norm(k.address) === deployer);
  if (!mine) {
    console.error(`\nREFUSING: ${deployer} is not among the keys of active permission ` +
      `${PERMISSION_ID} (keys: ${(ap.keys || []).map((k) => norm(k.address)).join(', ') || 'none'}).`);
    process.exit(1);
  }
  if (Number(mine.weight) < Number(ap.threshold)) {
    console.error(`\nREFUSING: this key's weight ${mine.weight} is below permission ` +
      `${PERMISSION_ID}'s threshold ${ap.threshold}; one signature cannot satisfy it.`);
    process.exit(1);
  }
  if (!can(30)) {
    console.error(`\nREFUSING: active permission ${PERMISSION_ID} does not include CreateSmartContract.`);
    process.exit(1);
  }
  const bal = (await tronWeb.trx.getBalance(deployer)) / 1e6;
  console.log(`balance       : ${bal.toLocaleString()} TRX`);

  console.log('\n-- widened-witness gate (compiled artifact)');
  assertWidened(artifact('Escrow').bytecode);

  if (MODE === 'broadcast') {
    const readline = require('readline');
    // existsSync is not a usable terminal test -- /dev/tty exists in contexts where
    // opening it fails -- so try to open it and let that be the answer.
    try { fs.closeSync(fs.openSync('/dev/tty', 'r')); }
    catch (e) {
      console.error('\nBROADCAST needs a terminal to confirm, and /dev/tty could not be opened.');
      console.error(`  ${redact(e.message)}`);
      process.exit(1);
    }
    // Keep references: rl.close() closes the INTERFACE, not these streams, and an
    // open /dev/tty read stream keeps the event loop alive indefinitely. That is why
    // the first real mainnet broadcast appeared to hang after printing its summary --
    // every transaction had landed and been recorded, and node simply would not exit.
    const ttyIn = fs.createReadStream('/dev/tty');
    const ttyOut = fs.createWriteStream('/dev/tty');
    const rl = readline.createInterface({ input: ttyIn, output: ttyOut });
    const ans = await new Promise(r => rl.question(`\nType the deployer address to confirm broadcasting: `, r));
    rl.close();
    ttyIn.destroy();
    ttyOut.end();
    if (ans.trim() !== deployer) { console.error('aborted'); process.exit(1); }
  }

  // Write the record the moment each contract lands. Tron has no CREATE2, so an
  // address nobody wrote down is recoverable only by hunting the transaction --
  // and recording after BOTH deploys means an Escrow that succeeds followed by a
  // FulfillmentProxy that fails (out of energy, say) loses the Escrow address.
  const out = process.env.OUT || `${process.env.HOME}/atum-v4-tvm-deploy`;
  const rec = path.join(out, 'mainnet.addresses.json');
  const record = { network: 'mainnet', deployer, admin, permissionId: PERMISSION_ID };
  function persist() {
    if (MODE !== 'broadcast') return;
    try {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(rec, JSON.stringify(record, null, 2));
    } catch (e) {
      console.error(`     WARNING: could not write ${rec}: ${redact(e.message)}`);
      console.error('     Copy the address printed above by hand before doing anything else.');
    }
  }

  console.log('\n-- Escrow');
  const esc = await deployOne('Escrow', [PERMIT2, USDT, admin]);
  record.escrow = esc; persist();
  console.log('\n-- FulfillmentProxy');
  const fp = await deployOne('FulfillmentProxy', [admin]);
  record.fulfillmentProxy = fp; persist();

  console.log('\n=====================================');
  if (MODE === 'broadcast') {
    console.log(`Escrow            ${esc.address}`);
    console.log(`FulfillmentProxy  ${fp.address}`);
  } else {
    console.log('No addresses to report — see above for why Tron cannot predict them.');
  }
  console.log('=====================================');
  if (MODE === 'broadcast') {
    console.log(`recorded  : ${rec}`);
    console.log('\nNext: update scripts/config.js with these base58 addresses, then grant the three');
    console.log('remaining roles (Step 8c). Those are TriggerSmartContract calls, so they need');
    console.log(`permission_id ${PERMISSION_ID} too.`);
  } else {
    console.log('\nDRY RUN — nothing was broadcast. Re-run with --broadcast to deploy.');
  }

  // Exit explicitly. Everything above has completed and been written; anything still
  // holding the event loop open (keep-alive sockets on TronWeb's HTTP agent, a tty
  // stream) is not work, and a process that has finished but will not exit reads as a
  // hang -- which after a real broadcast invites someone to re-run it.
  process.exit(0);
})().catch(e => {
  const msg = redact(e && e.message ? e.message : e);
  console.error(`\nFAILED: ${msg}`);
  // A bare "Request failed with status code 429" says nothing about what to do,
  // and it is the single most likely failure on a keyless run: TronGrid throttles
  // anonymous requests to ~3 rps and this script makes several reads per contract.
  if (/\b429\b|rate.?limit|too many requests/i.test(String(msg))) {
    console.error('');
    console.error('That is TronGrid rate limiting, not a bad endpoint or a bad key.');
    if (!process.env.TRON_API_KEY) {
      console.error('TRON_API_KEY is not set. Set it and retry:');
      console.error('  export TRON_API_KEY=<your TronGrid API key>');
    } else {
      console.error('TRON_API_KEY is set, so the key is over quota or the runs are too close');
      console.error('together. Wait a few seconds and retry.');
    }
    console.error('Nothing was broadcast.');
  }
  process.exit(1);
});
