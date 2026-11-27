#!/usr/bin/env node
/**
 * Check the committed IDLs against what the DEPLOYED programs actually emit.
 *
 * check-idl.sh proves the committed IDL matches a local Anchor build. It cannot see the deployed
 * program: the pre-v4 mainnet escrow ran an older build than its IDL described, and every Released
 * it emitted was 32 bytes short of the IDL with check-idl green. This reads transactions of each
 * program in deployments-v4.json, attributes their event logs to the emitting program, and checks
 * two things:
 *
 *   - Layout: every event's discriminator is in the IDL and its payload length is the IDL's.
 *   - Values: the money events (Deposited, Reserved, Released, Refunded, Fulfilled,
 *     StrictFulfilled) decoded with the IDL agree with what the transaction shows independently --
 *     the token transfers, the balances, the deposit PDA, the instruction's args and accounts --
 *     and with the same deposit's other events in the scan. A length match alone would pass two
 *     swapped u64 fields.
 *
 * It reports every event the IDL declares: OK, MISMATCH, or UNVERIFIED when the transactions read
 * held none. It exits 1 on any layout or value mismatch, an unknown discriminator, a REQUIRED event
 * left UNVERIFIED, or no events at all: a check that compared nothing is not a pass. A money-event
 * field no transaction let it check is listed as length-only; the other events are layout-only.
 *
 * Program ids come from deployments-v4.json, NOT from the IDL's `address`: that is the crate's
 * declare_id!, and the served v4 programs were deployed under their own keypairs per cluster.
 *
 *   node scripts/check-deployed-events.mjs [--cluster mainnet|devnet] [--limit N] [--rpc URL]
 *       [--require Event,...] [--signature SIG]...
 *   node scripts/check-deployed-events.mjs --program <id> --idl <path>   # one program, any IDL
 *
 * --limit counts back from the newest transaction and pages past the RPC's 1000 per call.
 * --signature adds a transaction outside that window, e.g. the only refund a cluster ever made, so
 * a rare event can still be compared. It must be on the cluster being checked; one the RPC cannot
 * find fails the run. --require replaces the default required events (the accounting
 * events v4 mainnet has emitted); each name applies to the programs whose IDL declares it.
 *
 * Needs network access, so it is not part of `pnpm test`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkEvents, coverage, eventLayouts, programData } from './lib/deployed-events.mjs';
import { checkValues, crossCheck, summarize } from './lib/event-values.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const idlDir = join(here, '..', 'src', 'generated');
const deployments = join(here, '..', '..', '..', '..', 'deployments-v4.json');

const DEFAULT_RPC = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
};
// The served v4 escrow's deposit takes the destination string, which src/generated no longer does,
// so the escrow decodes with the idl-history/v4 snapshot of that program.
const IDL_BY_CONTRACT = {
  Escrow: join(here, '..', 'idl-history', 'v4', 'escrow.json'),
  FulfillmentProxy: join(idlDir, 'fulfillment_proxy.json'),
};
// The accounting events v4 mainnet has actually emitted. Refunded and Fulfilled never have, so
// requiring them would fail every mainnet run; they are reported, and --signature can cover them.
const DEFAULT_REQUIRED = {
  Escrow: ['Deposited', 'Reserved', 'Released'],
  FulfillmentProxy: ['StrictFulfilled'],
};
const PAGE = 1000;
// Public RPCs rate-limit hard; more parallel fetches mostly buy more 429s.
const CONCURRENCY = 2;

const { values: args } = parseArgs({
  options: {
    cluster: { type: 'string', default: 'mainnet' },
    limit: { type: 'string', default: '100' },
    rpc: { type: 'string' },
    program: { type: 'string' },
    idl: { type: 'string' },
    require: { type: 'string' },
    signature: { type: 'string', multiple: true, default: [] },
  },
});
if (!(args.cluster in DEFAULT_RPC))
  throw new Error(`--cluster must be one of ${Object.keys(DEFAULT_RPC)}`);
if (Boolean(args.program) !== Boolean(args.idl)) throw new Error('--program and --idl go together');
const rpcUrl = args.rpc ?? process.env.SOLANA_RPC_URL ?? DEFAULT_RPC[args.cluster];
const limit = Number(args.limit);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    // Public RPCs signal rate limiting either way: HTTP 429, or HTTP 200 with a 429 error body.
    const body = res.ok ? await res.json() : undefined;
    if ((res.status === 429 || body?.error?.code === 429) && attempt < 12) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await sleep(retryAfter || Math.min(30_000, 1000 * 2 ** attempt));
      continue;
    }
    if (!body) throw new Error(`${method}: HTTP ${res.status}`);
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
}

/** The newest `limit` signatures of `program`, paging with `before` past the per-call cap. */
async function signaturesOf(program) {
  const out = [];
  let before;
  while (out.length < limit) {
    const page = await rpc('getSignaturesForAddress', [
      program,
      { limit: Math.min(PAGE, limit - out.length), before },
    ]);
    out.push(...page);
    if (page.length === 0 || page.length < PAGE) break;
    before = page.at(-1).signature;
  }
  return out;
}

/** jsonParsed, so inner token transfers arrive decoded for the value checks. */
async function transactions(signatures) {
  const txs = new Array(signatures.length);
  let next = 0;
  const worker = async () => {
    while (next < signatures.length) {
      const i = next++;
      txs[i] = await rpc('getTransaction', [
        signatures[i],
        { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' },
      ]);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return txs.map((tx, i) => ({ signature: signatures[i], tx }));
}

function targets() {
  if (args.program) {
    return [
      { label: args.program, program: args.program, idlPath: resolve(args.idl), defaults: [] },
    ];
  }
  const entry = Object.values(JSON.parse(readFileSync(deployments, 'utf8'))).find(
    (e) => e.mainnet === (args.cluster === 'mainnet'),
  );
  return Object.entries(IDL_BY_CONTRACT).map(([contract, idlPath]) => ({
    label: `${entry.name} ${contract}`,
    program: entry.contracts[contract],
    idlPath,
    defaults: DEFAULT_REQUIRED[contract],
  }));
}

const show = (v) => (typeof v === 'bigint' ? v.toString() : v);

const all = targets().map((t) => ({ ...t, idl: JSON.parse(readFileSync(t.idlPath, 'utf8')) }));
const requested = args.require
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (requested) {
  const declared = new Set(all.flatMap((t) => t.idl.events.map((e) => e.name)));
  const nowhere = requested.filter((name) => !declared.has(name));
  if (nowhere.length > 0) throw new Error(`--require: not an event of any checked IDL: ${nowhere}`);
}

let failed = false;
for (const { label, program, idlPath, idl, defaults } of all) {
  const layouts = eventLayouts(idl);
  const declared = new Set([...layouts.values()].map((l) => l.name));
  const required = requested ? requested.filter((name) => declared.has(name)) : defaults;

  const recent = (await signaturesOf(program)).filter((s) => !s.err).map((s) => s.signature);
  const signatures = [...new Set([...recent, ...args.signature])];
  const txs = await transactions(signatures);

  const payloads = [];
  const valued = [];
  for (const { signature, tx } of txs) {
    if (!tx || tx.meta?.err) continue;
    for (const d of programData(tx.meta.logMessages ?? [])) {
      if (d.program === program) payloads.push(d.data);
    }
    valued.push(...checkValues(idl, program, tx).map((c) => ({ ...c, signature })));
  }
  const checked = checkEvents(layouts, payloads);
  const cover = coverage(layouts, checked, required);
  const values = summarize(crossCheck(valued));

  console.log(`${label} (${program}) vs ${idlPath}: ${txs.length} transactions`);
  // A --signature the RPC cannot find (a typo, or another cluster's) would otherwise drop out of
  // the scan silently, and the event it was passed to cover would read as merely unverified.
  const missing = args.signature.filter((sig) => !txs.find((t) => t.signature === sig)?.tx);
  for (const sig of missing) console.log(`  NOT FOUND  --signature ${sig} on ${rpcUrl}`);
  if (missing.length > 0) failed = true;
  for (const { name, status: layout, count } of cover.rows) {
    const v = values.events[name];
    // The row is the event's verdict: a layout that fits but values that do not is still drift.
    const status = v && (v.mismatches.length > 0 || v.errors.length > 0) ? 'MISMATCH' : layout;
    const fields = v ? `  values: ${v.checked}/${v.checked + v.unchecked.length} fields` : '';
    const req = required.includes(name) ? ' (required)' : '';
    console.log(`  ${status.padEnd(10)} ${name}${count ? ` x${count}` : ''}${req}${fields}`);
  }
  for (const m of checked.mismatched) {
    console.log(
      `  LENGTH     ${m.name} x${m.count}: IDL says ${m.idl} bytes, program emitted ${m.chain}`,
    );
  }
  for (const u of checked.unknown) {
    console.log(
      `  UNKNOWN    discriminator ${u.discriminator} x${u.count} (${u.chain} bytes), not in the IDL`,
    );
  }
  for (const [name, v] of Object.entries(values.events)) {
    for (const m of v.mismatches) {
      console.log(
        `  VALUE      ${name}.${m.field}: emitted ${show(m.emitted)}, expected ${show(m.expected)} (${m.signature})`,
      );
    }
    for (const e of v.errors) console.log(`  UNPAIRED   ${name}: ${e.error} (${e.signature})`);
    if (v.unchecked.length > 0) console.log(`  length-only ${name}: ${v.unchecked.join(', ')}`);
  }
  if (cover.failed || values.failed) failed = true;
  if (payloads.length === 0) {
    console.log('  NOTHING VERIFIED: no events from this program in the transactions read');
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
