#!/usr/bin/env node
// Audit whether every v4 contract deployment has its SOURCE verified on that chain's primary
// block explorer, and write the record (CORE-2124).
//
//   node contracts/deploy/check-explorer-verification.mjs            # report to stdout
//   node contracts/deploy/check-explorer-verification.mjs --write    # also write the record files
//   node contracts/deploy/check-explorer-verification.mjs --warn-only # never exit non-zero (CI)
//
// THREE STATES, NOT TWO. `verified`, `unverified`, and `unknown` are distinct, and `unknown` is
// never folded into either. A run that could not reach an explorer and a run that reached it and
// was told "no source here" mean opposite things, and collapsing them produces the failure this
// whole ticket exists to prevent: a clean-looking record that checked nothing. Same reason
// verify-all.sh reserves exit 2 for stages that could not run.
//
// Exit codes (unless --warn-only):
//   0  every row was checked, and every checked row is verified
//   1  at least one row was checked and is NOT verified
//   2  nothing is known-unverified, but at least one row could not be checked
//
// Reads only. It never submits anything to an explorer; publishing source is a separate step.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));        // contracts/deploy
const CONTRACTS = join(HERE, '..');                          // contracts
const VMS = ['evm', 'tvm', 'svm'];

// Canonical Uniswap Permit2, deployed and verified by Uniswap at the same address everywhere.
// Not our source, so not our verification obligation; excluded rather than reported unverified.
const THIRD_PARTY = /^permit2$/i;

const read = (p) => JSON.parse(readFileSync(join(CONTRACTS, p), 'utf8'));

/** One row of the audit: a single contract address on a single chain. */
function rows() {
  const explorers = read('explorers.json');
  const out = [];
  for (const vm of VMS) {
    const deployments = read(`${vm}/deployments-v4.json`);
    for (const [chainKey, chain] of Object.entries(deployments)) {
      const explorer = explorers[vm]?.[chainKey];
      // A deployment with no map entry is an ERROR, not an omission: it means a chain was added
      // and silently escaped the audit. This is the check the CI workflow exists to run.
      if (explorer === undefined) {
        out.push({ vm, chainKey, chainName: chain.name, mainnet: !!chain.mainnet, contract: '*',
                   address: '*', state: 'unknown',
                   reason: `no entry in explorers.json for ${vm}/${chainKey} — a chain was added without being mapped` });
        continue;
      }
      const control = Object.entries(chain.contracts ?? {}).find(([n]) => THIRD_PARTY.test(n))?.[1];
      for (const [contract, address] of Object.entries(chain.contracts ?? chain.programs ?? {})) {
        if (THIRD_PARTY.test(contract)) continue;
        if (control) out.controls ??= {};
        out.push({ vm, chainKey, chainName: chain.name, mainnet: !!chain.mainnet,
                   contract, address, explorer, control });
      }
    }
  }
  return out;
}

async function getJSON(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    // The status alone is not the answer. Sourcify reports "this address has no source" as a 404
    // carrying a JSON body, so a 404 with a body is a VERDICT while a 404 with an HTML body is a
    // broken endpoint. Hand both up and let the probe decide.
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = undefined; }
    return { status: res.status, body, raw: text.slice(0, 200) };
  } catch (e) {
    return { error: e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(t);
  }
}

// --- per-mechanism probes -----------------------------------------------------------------
// Each returns { state, detail } and NEVER throws: an unreachable explorer is `unknown`, which
// is the whole point of the three-state design.

// PREFERRED. Etherscan recompiles and compares bytecode itself, so unlike Sourcify it does not
// depend on the CBOR metadata foundry.toml strips -- it is the only one of the three that can
// report a full match for us, and it is the explorer people actually open.
//
// One V2 key covers 14 of our 16 chains. Without the key Etherscan answers
// {status:"0", message:"NOTOK", result:"Missing/Invalid API Key"} for EVERY address, which is
// exactly the shape that would read as "nothing is verified" -- the same trap the retired
// Sourcify route sprang. So a missing or rejected key is could-not-check, never unverified.
let lastEtherscanCall = 0;
async function viaEtherscan(row) {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return { state: 'unknown', detail: 'etherscan: ETHERSCAN_API_KEY not set' };
  // The free tier refuses above a few calls a second. Pace them: a refusal is not an answer, and
  // one that arrives as "rate limit reached" is worth avoiding rather than merely classifying.
  const wait = 350 - (Date.now() - lastEtherscanCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastEtherscanCall = Date.now();
  const url = `https://api.etherscan.io/v2/api?chainid=${row.chainKey}&module=contract` +
              `&action=getsourcecode&address=${row.address}&apikey=${key}`;
  const { status, body, error } = await getJSON(url);
  if (error) return { state: 'unknown', detail: `etherscan unreachable: ${error}` };
  if (status !== 200) return { state: 'unknown', detail: `etherscan: HTTP ${status}` };
  if (body?.status === '0') {
    const why = String(body.result ?? body.message ?? '');
    // "No data found" is a verdict about the address; anything else is about our request.
    if (/no data found|not verified/i.test(why)) return { state: 'unverified', detail: 'etherscan: no source' };
    return { state: 'unknown', detail: `etherscan declined: ${why.slice(0, 90)}` };
  }
  const entry = Array.isArray(body?.result) ? body.result[0] : undefined;
  if (!entry) return { state: 'unknown', detail: 'etherscan: unrecognised response shape' };
  // An unverified address still returns a row, with SourceCode empty.
  if (entry.SourceCode && String(entry.SourceCode).trim() !== '') {
    return { state: 'verified', detail: `etherscan: ${entry.ContractName || 'source'} verified` };
  }
  return { state: 'unverified', detail: 'etherscan: no source' };
}

// Keyless fallback. Per-chain instances; 11 of our 16 chains have one.
async function viaBlockscout(row, check) {
  const { status, body, error } = await getJSON(`${check.api}/api/v2/smart-contracts/${row.address}`);
  if (error) return { state: 'unknown', detail: `blockscout unreachable: ${error}` };
  if (status === 404) return { state: 'unverified', detail: 'blockscout: no source' };
  if (status !== 200) return { state: 'unknown', detail: `blockscout: HTTP ${status}` };
  if (body?.source_code) return { state: 'verified', detail: 'blockscout: source verified' };
  return { state: 'unverified', detail: 'blockscout: no source' };
}

const SOURCIFY = (chainId, address) => `https://sourcify.dev/server/v2/contract/${chainId}/${address}`;

async function viaSourcify(row, _check) {
  const { status, body, error } = await getJSON(SOURCIFY(row.chainKey, row.address));
  if (error) return { state: 'unknown', detail: `sourcify unreachable: ${error}` };
  // A 404 whose body parses is Sourcify saying "nothing verified here" -- a verdict. A 404 with
  // no JSON body is a wrong or retired endpoint, which is how the legacy check-all-by-addresses
  // route failed: it 404'd on EVERY address, and read as 28 unverified contracts.
  if (status === 404 && body === undefined) {
    return { state: 'unknown', detail: 'sourcify: endpoint returned 404 with no JSON body — route may have changed' };
  }
  if (status !== 200 && status !== 404) return { state: 'unknown', detail: `sourcify: HTTP ${status}` };
  const match = body?.match ?? null;
  if (match === 'match' || match === 'exact_match') return { state: 'verified', detail: `sourcify: ${match}` };
  // Expected outcome for our contracts. foundry.toml strips the metadata a full match needs
  // (bytecode_hash=none, cbor_metadata=false), and that cannot change without moving every
  // CREATE2 address. Recorded as what it is rather than as a bare "verified".
  if (match === 'partial_match' || match === 'partial') {
    return { state: 'verified', detail: 'sourcify: partial match (metadata stripped by design)' };
  }
  if (match === null) return { state: 'unverified', detail: 'sourcify: no source' };
  return { state: 'unknown', detail: `sourcify: unrecognised match ${JSON.stringify(match)}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function viaTronscan(row, check) {
  const url = `${check.api}/api/contract?contract=${row.address}`;
  let { status, body, error } = await getJSON(url);
  // Tronscan rate-limits an unkeyed caller. A 429 is the explorer declining to answer, not an
  // answer, so back off once before recording it as could-not-check.
  if (status === 429) { await sleep(3000); ({ status, body, error } = await getJSON(url)); }
  if (error) return { state: 'unknown', detail: `tronscan unreachable: ${error}` };
  if (status === 429) return { state: 'unknown', detail: 'tronscan: rate limited after one retry' };
  if (status !== 200) return { state: 'unknown', detail: `tronscan: HTTP ${status}` };
  const entry = body?.data?.[0];
  if (!entry) return { state: 'unknown', detail: 'tronscan: no contract record returned' };
  // Tronscan has spelled this several ways; accept any it has used and report anything else as
  // unknown rather than guessing a default.
  const verified = entry.verify_status ?? entry.isVerified ?? entry.verified ?? entry.verifyStatus;
  if (verified === 1 || verified === true || verified === '1') return { state: 'verified', detail: 'tronscan: source verified' };
  if (verified === 0 || verified === false || verified === '0') return { state: 'unverified', detail: 'tronscan: no source' };
  return { state: 'unknown', detail: `tronscan: no recognised verification field (saw ${JSON.stringify(Object.keys(entry).slice(0, 12))})` };
}

async function viaOsec(row, _check) {
  // Solana has no Etherscan-style source verification. The equivalent is a VERIFIED BUILD in the
  // OtterSec registry, which Solana Explorer and SolanaFM surface. A different guarantee -- that
  // a published repo+commit rebuilds to the deployed bytes -- and labelled as such.
  const { status, body, error } = await getJSON(`https://verify.osec.io/status/${row.address}`);
  if (error) return { state: 'unknown', detail: `osec registry unreachable: ${error}` };
  if (status !== 200 && body === undefined) return { state: 'unknown', detail: `osec: HTTP ${status}` };
  const verified = body?.is_verified ?? body?.status?.is_verified ?? body?.verified;
  if (verified === true) return { state: 'verified', detail: 'osec: verified build' };
  if (verified === false) return { state: 'unverified', detail: 'osec: no verified build' };
  return { state: 'unknown', detail: `osec: unrecognised response ${JSON.stringify(body).slice(0, 120)}` };
}

const PROBES = { etherscan: viaEtherscan, sourcify: viaSourcify, blockscout: viaBlockscout, tronscan: viaTronscan, osec: viaOsec };

// Is the probe itself working on this chain?
//
// Permit2 is deployed and verified by Uniswap at the same address on every chain we use, and
// deployments-v4.json already records it, so it is a free known-good control. This exists
// because the first version of this script pointed at a retired Sourcify route that answered 404
// for EVERY address: all 28 EVM rows read "unverified", which is indistinguishable from a real
// finding and would have produced a false gap list. A positive result cannot be manufactured by a
// broken endpoint, so `verified` is always trusted; a NEGATIVE result is only trusted when the
// control on that same chain comes back verified.
const controlCache = new Map();
async function controlVerified(row, check) {
  if (!row.control) return { ok: null, detail: 'no control contract recorded for this chain' };
  const key = `${row.vm}/${row.chainKey}/${check.via}`;
  if (!controlCache.has(key)) {
    controlCache.set(key, await PROBES[check.via]({ ...row, address: row.control }, check));
  }
  const r = controlCache.get(key);
  return { ok: r.state === 'verified', detail: r.detail };   // detail already names its probe
}

async function probe(row) {
  if (row.state === 'unknown') return row;                       // already an error from rows()
  const checks = row.explorer.checks ?? [];
  if (checks.length === 0) {
    return { ...row, state: 'unknown', detail: row.explorer.note ?? 'no explorer identified for this chain' };
  }

  // Walk the map's preference order and STOP at the first verified answer. A contract verified
  // on any of them is visible to whoever looks there, so the audit reports where it is actually
  // visible rather than insisting on one explorer.
  const attempts = [];
  for (const check of checks) {
    const fn = PROBES[check.via];
    if (!fn) { attempts.push({ via: check.via, state: 'unknown', detail: 'no probe implemented' }); continue; }
    const r = await fn(row, check);
    attempts.push({ via: check.via, ...r });
    if (r.state === 'verified') return { ...row, state: 'verified', detail: r.detail, attempts };
  }

  // Nothing said verified. A gap requires EVERY configured verifier to have given a definitive
  // negative -- not merely one of them.
  //
  // Anything less and we do not know. If the preferred explorer could not answer (rate limited,
  // no key, unreachable) then a "no source" from a keyless fallback settles nothing: the question
  // is whether the source is visible where people look, and that is the explorer we failed to
  // reach. This bit me for real -- three rows were submitted to Etherscan successfully and then
  // reported as gaps, because Etherscan rate-limited the AUDIT while Sourcify and Blockscout
  // truthfully said they had no copy.
  const negatives = attempts.filter((a) => a.state === 'unverified');
  const summary = attempts.map((a) => a.detail).join('; ');
  if (negatives.length !== attempts.length) {
    return { ...row, state: 'unknown', attempts,
             detail: `${summary} — not every verifier gave a definitive answer, so this is not reported as a gap` };
  }

  // And a definitive negative is only trusted where the control proves that probe works on this
  // chain. Checked against the FIRST probe that returned a negative, through the same code path.
  const via = checks.find((c) => c.via === negatives[0].via);
  const control = await controlVerified(row, via);
  if (control.ok === false) {
    return { ...row, state: 'unknown', attempts,
             detail: `${summary} — but the control contract on this chain also reads unverified ` +
                     `(${control.detail}), so the probe is unproven here and this is not reported as a gap` };
  }
  return { ...row, state: 'unverified', detail: summary, attempts };
}

// --- record rendering ---------------------------------------------------------------------

const ICON = { verified: 'yes', unverified: 'NO', unknown: '?' };

function markdown(results, stampedAt) {
  const line = (r) =>
    `| ${r.vm.toUpperCase()} | ${r.chainName ?? r.chainKey} | ${r.mainnet ? 'mainnet' : 'testnet'} | ` +
    `${r.contract} | \`${r.address}\` | ${r.explorer?.name ?? '—'} | ${ICON[r.state]} | ${r.detail ?? r.reason ?? ''} |`;
  const counts = results.reduce((a, r) => ((a[r.state] = (a[r.state] ?? 0) + 1), a), {});
  return `# Explorer source verification — v4 deployments

Generated by \`contracts/deploy/check-explorer-verification.mjs\`. Do not hand-edit; re-run it.

Stamped: ${stampedAt}

**${counts.verified ?? 0} verified · ${counts.unverified ?? 0} unverified · ${counts.unknown ?? 0} could not be checked**

\`?\` means the audit could not reach a verdict, which is NOT the same as unverified. The reason
is in the last column.

Permit2 is excluded throughout: it is canonical Uniswap, deployed and verified by Uniswap at the
same address on every chain, and is not our source to verify.

On EVM chains a "partial match" is the expected best outcome. \`foundry.toml\` sets
\`bytecode_hash = "none"\` and \`cbor_metadata = false\`, so the metadata Sourcify needs for a full
match is absent from the deployed bytecode. That is deliberate and cannot be changed: the
metadata is part of the initcode, so restoring it would move every CREATE2 address.

| VM | Chain | Net | Contract | Address | Explorer | Verified | Detail |
|---|---|---|---|---|---|---|---|
${results.map(line).join('\n')}
`;
}

function csv(results) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['vm', 'chain', 'network', 'contract', 'address', 'explorer', 'explorer_url', 'state', 'detail'];
  return [head.join(','), ...results.map((r) => [
    r.vm, r.chainName ?? r.chainKey, r.mainnet ? 'mainnet' : 'testnet', r.contract, r.address,
    r.explorer?.name ?? '', r.explorer?.url ?? '', r.state, r.detail ?? r.reason ?? '',
  ].map(esc).join(','))].join('\n') + '\n';
}

// --- main ---------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const warnOnly = argv.includes('--warn-only');
// Stamped from the environment where one is given, so a regenerated record diffs on content
// rather than on the clock.
const stampedAt = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  : new Date().toISOString();

const all = rows();
const results = [];
for (const r of all) results.push(await probe(r));       // serial: these are public, unkeyed APIs

const counts = results.reduce((a, r) => ((a[r.state] = (a[r.state] ?? 0) + 1), a), {});
for (const r of results) {
  if (r.state !== 'verified') {
    const where = `${r.vm}/${r.chainName ?? r.chainKey} ${r.contract} ${r.address}`;
    const msg = `${r.state === 'unverified' ? 'UNVERIFIED' : 'COULD NOT CHECK'}: ${where} — ${r.detail ?? r.reason}`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `  ${msg}`);
  }
}
console.log(`\n  ${counts.verified ?? 0} verified · ${counts.unverified ?? 0} unverified · ${counts.unknown ?? 0} could not be checked  (of ${results.length} rows)`);

if (write) {
  writeFileSync(join(CONTRACTS, 'EXPLORER-VERIFICATION.md'), markdown(results, stampedAt));
  writeFileSync(join(CONTRACTS, 'explorer-verification.json'),
    JSON.stringify({ stampedAt, counts, rows: results.map(({ explorer, ...r }) => ({ ...r, explorerName: explorer?.name ?? null })) }, null, 2) + '\n');
  writeFileSync(join(CONTRACTS, 'explorer-verification.csv'), csv(results));
  console.log('  wrote EXPLORER-VERIFICATION.md, explorer-verification.json, explorer-verification.csv');
}

if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(results, stampedAt), { flag: 'a' });
}

if (warnOnly) process.exit(0);
if (counts.unverified) process.exit(1);
if (counts.unknown) process.exit(2);
process.exit(0);
