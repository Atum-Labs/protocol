#!/usr/bin/env node
'use strict';

/**
 * sync-config-addresses.js -- point scripts/config.js at the pair that was just
 * deployed, reading the addresses from the deploy record rather than from you.
 *
 * WHY
 *
 * Tron has no CREATE2, so the v4 addresses are not knowable until the deploy
 * transaction lands, and step 8a used to say "set OLD_ESCROW=<address currently in
 * config.js>, NEW_ESCROW=<newly deployed>" and sed one for the other. Two ways that
 * goes wrong. The addresses are transcribed by hand, and one wrong base58 character
 * is a checksum failure at best and a valid-looking address that silently does
 * nothing at worst. And a bare `sed s/old/new/` is not scoped to a network: the
 * mainnet and shasta blocks sit in the same file, next to PERMIT2 and USDT entries
 * that must NOT change.
 *
 * The two drivers also record their results differently, in different encodings:
 *
 *   permissioned  {"escrow": {"address": "TYj48k..."}, "fulfillmentProxy": {...}}
 *   tronbox       {"Escrow": "41897930b6...", "FulfillmentProxy": "414e790a37..."}
 *
 * so "read the record" means handling both shapes AND converting 41-hex to base58 --
 * which is the one thing the guide is emphatic you should not do by eye.
 *
 * Usage:
 *   NETWORK=mainnet node sync-config-addresses.js            # show the change, write nothing
 *   NETWORK=mainnet node sync-config-addresses.js --write    # apply it
 *
 * Env:
 *   NETWORK    mainnet | shasta                  (default mainnet)
 *   OUT        deploy-record directory           (default ~/atum-v4-tvm-deploy)
 *   SRC_DIR    the tronbox project               (default: the tree beside this script)
 *   ESCROW_ADDRESS / FULFILLMENT_PROXY_ADDRESS   override the record entirely, for a
 *                     pair you have on hand. ESCROW / FPROXY are accepted aliases;
 *                     set both or neither.
 *
 * Exit codes: 0 nothing to do or written, 1 refused, 2 could not run.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const HERE = __dirname;
const SRC = process.env.SRC_DIR
  ? path.resolve(process.env.SRC_DIR)
  : path.resolve(HERE, '../source');

let TronWeb;
try {
  ({ TronWeb } = createRequire(path.join(SRC, 'package.json'))('tronweb'));
} catch (e) {
  console.error(`cannot load tronweb from ${SRC}/node_modules`);
  console.error(`  run: (cd ${SRC} && pnpm install --ignore-workspace)`);
  process.exit(2);
}

const WRITE = process.argv.includes('--write');
const NETWORK = (process.env.NETWORK || 'mainnet').toLowerCase();
if (!['mainnet', 'shasta'].includes(NETWORK)) {
  console.error(`NETWORK must be mainnet or shasta, got "${NETWORK}"`);
  process.exit(2);
}

const CONFIG = path.join(SRC, 'scripts', 'config.js');
const OUT = process.env.OUT || path.join(process.env.HOME || '', 'atum-v4-tvm-deploy');
const REC = path.join(OUT, `${NETWORK}.addresses.json`);

// Accept either driver's shape, and either encoding. A 41-prefixed hex string is
// converted with the library; base58 is validated by round-tripping it, so a
// mistyped character fails here rather than becoming a live misconfiguration.
function toBase58(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label}: not a string`);
  const v = value.trim();
  if (/^41[0-9a-fA-F]{40}$/.test(v)) return TronWeb.address.fromHex(v);
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v)) {
    // Round-trip rather than trust the shape. base58check carries a double-SHA256
    // checksum, so one wrong character is caught here -- and tronweb signals that by
    // throwing a bare "Invalid address provided", which names neither the field nor
    // the value and is useless in a list of two addresses.
    let hex;
    try { hex = TronWeb.address.toHex(v); }
    catch (e) {
      throw new Error(`${label}: "${v}" fails its base58check checksum ` +
        `(one mistyped character does this). Copy it, do not retype it.`);
    }
    if (!/^41[0-9a-fA-F]{40}$/.test(hex) || TronWeb.address.fromHex(hex) !== v) {
      throw new Error(`${label}: "${v}" does not round-trip through hex, so it is not a ` +
        `valid Tron address however much it looks like one.`);
    }
    return v;
  }
  throw new Error(`${label}: "${v}" is neither 41-hex nor a T-prefixed base58 address`);
}

function fromRecord() {
  // Accept both spellings -- the sibling admin-preflight.js documents the longer
  // pair -- and treat a half-set override as an error. Requiring both and otherwise
  // falling through to the record silently ignored what the operator asked for.
  const envEscrow = process.env.ESCROW_ADDRESS || process.env.ESCROW;
  const envFproxy = process.env.FULFILLMENT_PROXY_ADDRESS || process.env.FPROXY;
  if (!!envEscrow !== !!envFproxy) {
    throw new Error(
      `only one address override is set (escrow ${envEscrow ? 'set' : 'unset'}, ` +
      `proxy ${envFproxy ? 'set' : 'unset'}). Set both or neither: writing one new ` +
      `address beside one stale one is worse than writing neither.`
    );
  }
  if (envEscrow && envFproxy) {
    return { escrow: envEscrow, fproxy: envFproxy, from: 'ESCROW_ADDRESS / FULFILLMENT_PROXY_ADDRESS env' };
  }
  if (!fs.existsSync(REC)) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(REC, 'utf8')); }
  catch (e) { throw new Error(`${REC} is not readable JSON: ${e.message}`); }
  const pick = (...keys) => {
    for (const k of keys) {
      const v = j[k];
      if (typeof v === 'string' && v) return v;
      if (v && typeof v === 'object' && v.address) return v.address;
    }
    return null;
  };
  const escrow = pick('escrow', 'Escrow');
  const fproxy = pick('fulfillmentProxy', 'FulfillmentProxy');
  if (!escrow || !fproxy) {
    throw new Error(`${REC} has no recognisable Escrow / FulfillmentProxy entry. ` +
      `Keys present: ${Object.keys(j).join(', ') || '(none)'}`);
  }
  return { escrow, fproxy, from: REC };
}

// Scope every edit to the target network's own block. The file holds one block per
// network, each with its own PERMIT2_ADDRESS and USDT_ADDRESS that must survive
// untouched -- an unscoped substitution is how you update mainnet and silently
// rewrite shasta, or clobber a Permit2 address that was never redeployed.
function locateBlock(text, network) {
  const head = new RegExp(`(^|\\n)\\s*${network}\\s*:\\s*\\{`);
  const m = head.exec(text);
  if (!m) throw new Error(`could not find a "${network}:" block in ${CONFIG}`);
  let i = text.indexOf('{', m.index);
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}') { depth--; if (depth === 0) return { start: i, end: k + 1 }; }
  }
  throw new Error(`the "${network}:" block in ${CONFIG} is not brace-balanced`);
}

function replaceField(block, field, value) {
  const re = new RegExp(`(${field}\\s*:\\s*')([^']*)(')`, 'g');
  const found = [...block.matchAll(re)];
  if (found.length !== 1) {
    throw new Error(`expected exactly one ${field} in the ${NETWORK} block, found ${found.length}`);
  }
  const old = found[0][2];
  return { block: block.replace(re, `$1${value}$3`), old };
}

(() => {
  if (!fs.existsSync(CONFIG)) {
    console.error(`${CONFIG} not found. Is SRC_DIR right?`);
    process.exit(2);
  }

  let rec;
  try { rec = fromRecord(); } catch (e) { console.error(`REFUSING: ${e.message}`); process.exit(1); }
  if (!rec) {
    console.error(`No deploy record at ${REC}, and ESCROW / FPROXY are not set.`);
    console.error('Tron addresses are not predictable, so there is nothing to read. Either run the');
    console.error('deploy (which writes that file), or pass the pair explicitly:');
    console.error(`  ESCROW=T... FPROXY=T... NETWORK=${NETWORK} node sync-config-addresses.js`);
    process.exit(2);
  }

  let escrow, fproxy;
  try {
    escrow = toBase58(rec.escrow, 'Escrow');
    fproxy = toBase58(rec.fproxy, 'FulfillmentProxy');
  } catch (e) {
    console.error(`REFUSING: ${e.message}`);
    process.exit(1);
  }

  console.log(`network : ${NETWORK}`);
  console.log(`config  : ${CONFIG}`);
  console.log(`source  : ${rec.from}`);
  if (rec.escrow !== escrow || rec.fproxy !== fproxy) {
    console.log('          (record holds 41-hex; converted to base58 with the library, not by eye)');
  }
  console.log('');

  const text = fs.readFileSync(CONFIG, 'utf8');
  let span, block, oldEscrow, oldProxy;
  try {
    span = locateBlock(text, NETWORK);
    block = text.slice(span.start, span.end);
    let r = replaceField(block, 'ESCROW_ADDRESS', escrow);
    block = r.block; oldEscrow = r.old;
    r = replaceField(block, 'FULFILLMENT_PROXY_ADDRESS', fproxy);
    block = r.block; oldProxy = r.old;
  } catch (e) {
    console.error(`REFUSING: ${e.message}`);
    console.error('Nothing was changed. Edit by hand rather than forcing this.');
    process.exit(1);
  }

  const rows = [
    ['ESCROW_ADDRESS', oldEscrow, escrow],
    ['FULFILLMENT_PROXY_ADDRESS', oldProxy, fproxy],
  ];
  let changes = 0;
  for (const [field, from, to] of rows) {
    if (from === to) {
      console.log(`  ok      ${field}\n            already ${to}`);
    } else {
      changes++;
      console.log(`  change  ${field}\n            from ${from}\n            to   ${to}`);
    }
  }

  // Untouched by construction -- the block is edited field by field, not substituted
  // wholesale -- but say so, because "did it eat my Permit2 address" is the first
  // question anyone sensibly asks of a tool that rewrites a config block.
  const others = [...block.matchAll(/(PERMIT2_ADDRESS|USDT_ADDRESS)\s*:\s*'([^']*)'/g)];
  if (others.length) {
    console.log('');
    for (const o of others) console.log(`  kept    ${o[1]} = ${o[2]}`);
  }

  if (changes === 0) {
    console.log('\nNothing to do.');
    process.exit(0);
  }

  if (!WRITE) {
    console.log(`\n${changes} field(s) would change. Nothing written. Re-run with --write to apply.`);
    process.exit(0);
  }

  const updated = text.slice(0, span.start) + block + text.slice(span.end);
  fs.writeFileSync(`${CONFIG}.bak`, text);
  fs.writeFileSync(CONFIG, updated);

  // Read it back and confirm, rather than trusting the write. Also confirm the OTHER
  // network's block is byte-identical: an unscoped edit is the failure mode here, and
  // it is invisible unless something checks.
  const after = fs.readFileSync(CONFIG, 'utf8');
  const other = NETWORK === 'mainnet' ? 'shasta' : 'mainnet';
  let ok = true;
  for (const [field, , to] of rows) {
    const b = after.slice(...Object.values(locateBlock(after, NETWORK)).slice(0, 2));
    if (!new RegExp(`${field}\\s*:\\s*'${to}'`).test(b)) {
      console.error(`  VERIFY FAILED: ${field} does not read back as ${to}`);
      ok = false;
    }
  }
  try {
    const beforeOther = text.slice(...[locateBlock(text, other).start, locateBlock(text, other).end]);
    const afterOther = after.slice(...[locateBlock(after, other).start, locateBlock(after, other).end]);
    if (beforeOther !== afterOther) {
      console.error(`  VERIFY FAILED: the ${other} block changed, which it must not have`);
      ok = false;
    }
  } catch (e) {
    console.log(`  note: could not compare the ${other} block (${e.message})`);
  }

  if (!ok) {
    fs.writeFileSync(CONFIG, text);
    console.error('\nRolled back. config.js is as it was.');
    process.exit(1);
  }

  console.log(`\nWritten. Backup at ${CONFIG}.bak`);
  console.log(`Verified: both fields read back, and the ${other} block is unchanged.`);
  console.log(`Review before continuing:  git diff -- ${CONFIG}`);
  process.exit(0);
})();
