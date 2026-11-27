// Field-value checks for scripts/check-deployed-events.mjs. No I/O here, so every rule is unit
// tested in src/event-values.test.ts against real mainnet transactions.
//
// A matching payload length does not prove the IDL decodes the payload: two u64 fields swapped keep
// the length. So each money event's decoded fields are compared with what the SAME transaction
// shows independently of the IDL's event section: the token transfers the emitting instruction made
// (as the token program reports them), the balances before it, the deposit PDA it was handed, and
// its own args and accounts (the client serialized those, not the program's emit!). What one
// transaction cannot show is then pinned across the deposit's other events by crossCheck.

import { eventLayouts, programData } from './deployed-events.mjs';
import { decodeEvent, decodeInstruction } from './idl-decode.mjs';
import { findProgramAddress } from './pda.mjs';

const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

/** Every instruction, top level and inner, in execution order, each with its CPI depth. */
function executionOrder(tx) {
  const inner = new Map(tx.meta.innerInstructions.map((g) => [g.index, g.instructions]));
  return tx.transaction.message.instructions.flatMap((ix, i) => [
    { ix, depth: 1 },
    ...(inner.get(i) ?? []).map((ix) => ({ ix, depth: ix.stackHeight })),
  ]);
}

/**
 * Each instruction of `programId` the IDL declares, decoded, with the token transfers made inside
 * its CPI subtree: the inner instructions after it that run deeper than it does.
 */
function programCalls(idl, programId, tx) {
  const order = executionOrder(tx);
  const calls = [];
  order.forEach(({ ix, depth }, at) => {
    if (ix.programId !== programId || ix.parsed) return;
    const decoded = decodeInstruction(idl, ix);
    if (!decoded) return;
    const transfers = [];
    for (const next of order.slice(at + 1)) {
      if (next.depth <= depth) break;
      const { programId: p, parsed } = next.ix;
      if (
        TOKEN_PROGRAMS.has(p) &&
        (parsed?.type === 'transfer' || parsed?.type === 'transferChecked')
      ) {
        const info = parsed.info;
        transfers.push({
          source: info.source,
          destination: info.destination,
          amount: BigInt(info.tokenAmount?.amount ?? info.amount),
        });
      }
    }
    calls.push({ ...decoded, transfers });
  });
  return calls;
}

function transactionFacts(tx, programId) {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey ?? k);
  const before = new Map(
    tx.meta.preTokenBalances.map((b) => [keys[b.accountIndex], BigInt(b.uiTokenAmount.amount)]),
  );
  return { programId, balanceBefore: (account) => before.get(account) ?? 0n };
}

/**
 * A deposit_hash expectation: a PDA cannot be inverted, so the hash is checked by deriving the
 * deposit account from it and comparing with the account the instruction was handed.
 */
const derivesDeposit = (call, facts) => {
  const test = (hash) =>
    findProgramAddress([Buffer.from('deposit'), Buffer.from(hash, 'hex')], facts.programId) ===
    call.accounts.deposit;
  test.describe = `a hash whose deposit PDA is ${call.accounts.deposit}`;
  return test;
};

/** A value expectation met by either of two values. */
const either = (a, b) => {
  const test = (v) => v === a || v === b;
  test.describe = `${a} or ${b}`;
  return test;
};

const moved = (call, from, to) =>
  call.transfers
    .filter((t) => t.source === call.accounts[from] && t.destination === call.accounts[to])
    .reduce((n, t) => n + t.amount, 0n);

/**
 * Per event: the instruction that emits it, and the value each field must have given that
 * instruction's call and the transaction, or a predicate the value must satisfy. A field absent
 * here is not value-checked.
 */
const RULES = {
  Deposited: {
    instruction: 'deposit',
    expect: (call) => ({
      deposit_hash: call.args.deposit_hash,
      depositor: call.accounts.authority,
      reserver: call.args.reserver,
      releaser: call.args.releaser,
      amount: moved(call, 'authority_ata', 'escrow_ata'),
      nonce: call.args.nonce,
      issued_at: call.args.issued_at,
      deadline: call.args.deadline,
    }),
  },
  Reserved: {
    instruction: 'reserve',
    expect: (call, facts) => ({
      deposit_hash: derivesDeposit(call, facts),
      recipient: call.args.recipient,
      quote_hash: call.args.quote_hash,
      source_amount: call.args.source_amount,
    }),
  },
  Released: {
    instruction: 'release',
    expect: (call, facts) => {
      const net = moved(call, 'escrow_ata', 'recipient_ata');
      const gross = facts.balanceBefore(call.accounts.escrow_ata);
      const common = {
        deposit_hash: derivesDeposit(call, facts),
        recipient: call.accounts.recipient,
        gross_amount: gross,
        net_amount: net,
      };
      const toDepositor = moved(call, 'escrow_ata', 'depositor_ata');
      // Release pays the fee to the treasury before the surplus, and sends the surplus there too
      // when the depositor's token account refuses plain credits.
      const toTreasury = call.transfers
        .filter(
          (t) =>
            t.source === call.accounts.escrow_ata && t.destination === call.accounts.treasury_ata,
        )
        .map((t) => t.amount);
      if (toDepositor === 0n && toTreasury.length === 2) {
        const [fee, surplus] = toTreasury;
        return {
          ...common,
          intended_amount: gross - surplus,
          surplus_amount: surplus,
          fee_amount: fee,
        };
      }
      if (toDepositor === 0n && toTreasury.length === 1) {
        // The one treasury transfer is the fee, or a surplus sent there by a release with no fee.
        const [t] = toTreasury;
        return {
          ...common,
          intended_amount: either(gross, gross - t),
          surplus_amount: either(0n, t),
          fee_amount: either(t, 0n),
        };
      }
      const fee = toTreasury.reduce((n, a) => n + a, 0n);
      return {
        ...common,
        intended_amount: gross - toDepositor,
        surplus_amount: toDepositor,
        fee_amount: fee,
      };
    },
  },
  Refunded: {
    instruction: 'refund',
    expect: (call, facts) => ({
      deposit_hash: derivesDeposit(call, facts),
      depositor: call.accounts.depositor,
      amount: moved(call, 'escrow_ata', 'depositor_ata'),
    }),
  },
  Fulfilled: {
    instruction: 'fulfill',
    expect: (call) => ({
      quote_hash: call.args.quote_hash,
      to: call.accounts.to,
      token: call.accounts.mint,
      amount: moved(call, 'from_ata', 'to_ata'),
    }),
  },
  StrictFulfilled: {
    instruction: 'strict_fulfill',
    expect: (call) => ({
      quote_hash: call.args.quote_hash,
      to: call.accounts.to,
      token: call.accounts.mint,
      amount: moved(call, 'from_ata', 'to_ata'),
      nonce: call.args.nonce,
      issued_at: call.args.issued_at,
      deadline: call.args.deadline,
      // Pre-v4 only: payment_id where v4 has quote_hash, and the settler as `from`.
      payment_id: call.args.payment_id,
      from: call.accounts.settler,
    }),
  },
};

/**
 * Decode every event `programId` emitted in `tx` and compare each value-checked field with what the
 * transaction independently shows. Events are paired with their emitting instruction by order.
 */
export function checkValues(idl, programId, tx) {
  const facts = transactionFacts(tx, programId);
  const calls = programCalls(idl, programId, tx);
  // Only payloads the IDL's layout fits: a length mismatch is already a failure of the layout
  // check, and decoding it would read fields from the wrong bytes.
  const layouts = eventLayouts(idl);
  const events = programData(tx.meta.logMessages)
    .filter((d) => d.program === programId)
    .filter((d) => layouts.get(d.data.subarray(0, 8).toString('hex'))?.size === d.data.length - 8)
    .map((d) => decodeEvent(idl, d.data));
  const out = [];
  const paired = {};
  for (const event of events) {
    const rule = RULES[event.name];
    if (!rule) continue;
    const i = (paired[event.name] = (paired[event.name] ?? -1) + 1);
    const call = calls.filter((c) => c.name === rule.instruction)[i];
    if (!call) {
      const error = `no ${rule.instruction} instruction to pair it with`;
      out.push({ name: event.name, fields: event.fields, results: {}, mismatches: [], error });
      continue;
    }
    const results = {};
    const mismatches = [];
    for (const [field, want] of Object.entries(rule.expect(call, facts))) {
      // An older IDL may lack the field, or the arg it is checked against: nothing to compare.
      if (!(field in event.fields) || want === undefined) continue;
      const ok =
        typeof want === 'function' ? want(event.fields[field]) : event.fields[field] === want;
      results[field] = ok ? 'ok' : 'mismatch';
      if (!ok) {
        const expected = typeof want === 'function' ? want.describe : want;
        mismatches.push({ field, emitted: event.fields[field], expected });
      }
    }
    out.push({ name: event.name, fields: event.fields, results, mismatches });
  }
  return out;
}

const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * Pin the fields one transaction cannot show, through the same deposit's other events in the scan:
 * the fee the treasury received on release is the fee reserve emitted, which is the deposit-time
 * fee rescaled to the charge (rescale_reserved_fee: ceil(fee * source_amount / amount)); before v4,
 * reserve emitted no fee and release paid the deposit-time fee unchanged. And
 * release and refund emit the quote_hash reserve was given. Only a value already checked is used as
 * the reference. A deposit whose other events fell outside the scan leaves these fields unchecked.
 */
export function crossCheck(checked) {
  const out = checked.map((c) => ({
    ...c,
    results: { ...c.results },
    mismatches: [...c.mismatches],
  }));
  const byDeposit = (name) =>
    new Map(
      out
        .filter((c) => c.name === name && c.results.deposit_hash === 'ok')
        .map((c) => [c.fields.deposit_hash, c]),
    );
  const deposited = byDeposit('Deposited');
  const reserved = byDeposit('Reserved');
  const released = byDeposit('Released');
  const refunded = byDeposit('Refunded');
  const compare = (c, field, ok, expected) => {
    if (!(field in c.fields)) return;
    c.results[field] = ok ? 'ok' : 'mismatch';
    if (!ok) c.mismatches.push({ field, emitted: c.fields[field], expected });
  };
  // Only a field that was itself checked can be the reference for another.
  const verified = (c, ...fields) => c && fields.every((f) => c.results[f] === 'ok');

  for (const [hash, r] of reserved) {
    const release = released.get(hash);
    if (verified(release, 'fee_amount')) {
      compare(
        r,
        'fee_amount',
        r.fields.fee_amount === release.fields.fee_amount,
        release.fields.fee_amount,
      );
    }
    for (const closing of [release, refunded.get(hash)]) {
      if (closing && verified(r, 'quote_hash')) {
        compare(
          closing,
          'quote_hash',
          closing.fields.quote_hash === r.fields.quote_hash,
          r.fields.quote_hash,
        );
      }
    }
    const d = deposited.get(hash);
    if (verified(d, 'amount') && verified(r, 'fee_amount', 'source_amount')) {
      const rescaled = ceilDiv(d.fields.fee_amount * r.fields.source_amount, d.fields.amount);
      compare(
        d,
        'fee_amount',
        rescaled === r.fields.fee_amount,
        `a fee rescaling to ${r.fields.fee_amount}`,
      );
    } else if (d && !('fee_amount' in r.fields) && verified(release, 'fee_amount')) {
      // Pre-v4: reserve emitted no fee and left the deposit's alone, so release paid it as is.
      const fee = release.fields.fee_amount;
      compare(d, 'fee_amount', d.fields.fee_amount === fee, fee);
    }
  }
  return out;
}

/**
 * Per event name: how many were seen, how many of its fields were value-checked on at least one of
 * them, the fields never value-checked (length-only), and every mismatch or unpaired event with the
 * `signature` of the transaction it came from. Any mismatch or unpaired event fails the run.
 */
export function summarize(checked) {
  const events = {};
  for (const c of checked) {
    const e = (events[c.name] ??= {
      count: 0,
      seen: new Set(),
      fields: Object.keys(c.fields),
      mismatches: [],
      errors: [],
    });
    e.count++;
    for (const field of Object.keys(c.results)) e.seen.add(field);
    e.mismatches.push(...c.mismatches.map((m) => ({ ...m, signature: c.signature })));
    if (c.error) e.errors.push({ error: c.error, signature: c.signature });
  }
  let failed = false;
  for (const [name, e] of Object.entries(events)) {
    failed ||= e.mismatches.length > 0 || e.errors.length > 0;
    events[name] = {
      count: e.count,
      checked: e.seen.size,
      unchecked: e.fields.filter((f) => !e.seen.has(f)),
      mismatches: e.mismatches,
      errors: e.errors,
    };
  }
  return { failed, events };
}
