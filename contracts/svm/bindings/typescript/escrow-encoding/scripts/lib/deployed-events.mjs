// Pure helpers for scripts/check-deployed-events.mjs. No I/O here, so every rule is unit tested in
// src/deployed-events.test.ts.

const PRIMITIVE_SIZES = {
  bool: 1,
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  u128: 16,
  i128: 16,
  pubkey: 32,
};

/** Map of hex discriminator -> { name, size } for every event in an Anchor IDL. */
export function eventLayouts(idl) {
  const types = new Map((idl.types ?? []).map((t) => [t.name, t]));
  const sizeOf = (type, path) => {
    if (typeof type === 'string' && type in PRIMITIVE_SIZES) return PRIMITIVE_SIZES[type];
    if (type.array) return sizeOf(type.array[0], path) * type.array[1];
    if (type.defined) {
      return types
        .get(type.defined.name)
        .type.fields.reduce((n, f) => n + sizeOf(f.type, `${path}.${f.name}`), 0);
    }
    throw new Error(
      `${path}: ${JSON.stringify(type)} has no fixed size, so this event's payload length cannot be ` +
        'checked against the IDL. Teach the check to decode it before relying on it.',
    );
  };
  return new Map(
    idl.events.map((e) => [
      Buffer.from(e.discriminator).toString('hex'),
      { name: e.name, size: sizeOf({ defined: { name: e.name } }, e.name) },
    ]),
  );
}

const INVOKE = /^Program (\S+) invoke \[\d+\]$/;
const EXIT = /^Program (\S+) (success|failed)/;
const DATA = 'Program data: ';

/**
 * The `Program data:` payloads of one transaction's log, each attributed to the innermost program
 * executing when it was written. Anchor's emit! writes events this way, and a FulfillmentProxy
 * transaction CPIs into the escrow, so both programs' events share one log.
 */
export function programData(logMessages) {
  const stack = [];
  const out = [];
  for (const line of logMessages) {
    const invoke = INVOKE.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
    } else if (EXIT.test(line)) {
      stack.pop();
    } else if (line.startsWith(DATA) && stack.length > 0) {
      out.push({ program: stack.at(-1), data: Buffer.from(line.slice(DATA.length), 'base64') });
    }
  }
  return out;
}

/**
 * Compare one program's event payloads (discriminator + body) against its IDL layouts. Matches are
 * counted per event; a known discriminator with the wrong body length, and a discriminator the IDL
 * does not declare, are both drift between the committed IDL and the deployed program.
 */
export function checkEvents(layouts, payloads) {
  const matched = {};
  const mismatched = new Map();
  const unknown = new Map();
  for (const payload of payloads) {
    const discriminator = payload.subarray(0, 8).toString('hex');
    const chain = payload.length - 8;
    const layout = layouts.get(discriminator);
    if (!layout) {
      const key = `${discriminator}:${chain}`;
      const u = unknown.get(key) ?? { discriminator, chain, count: 0 };
      u.count++;
      unknown.set(key, u);
    } else if (layout.size === chain) {
      matched[layout.name] = (matched[layout.name] ?? 0) + 1;
    } else {
      const key = `${layout.name}:${chain}`;
      const m = mismatched.get(key) ?? { name: layout.name, idl: layout.size, chain, count: 0 };
      m.count++;
      mismatched.set(key, m);
    }
  }
  return { matched, mismatched: [...mismatched.values()], unknown: [...unknown.values()] };
}

/** One row per event the IDL declares, so an event the window never contained reads as unverified. */
export function coverage(layouts, checked, required) {
  const declared = new Set([...layouts.values()].map((l) => l.name));
  const undeclared = required.filter((name) => !declared.has(name));
  if (undeclared.length > 0)
    throw new Error(`required events not in the IDL: ${undeclared.join(', ')}`);
  const rows = [...layouts.values()].map(({ name }) => {
    const drifted = checked.mismatched
      .filter((m) => m.name === name)
      .reduce((n, m) => n + m.count, 0);
    const count = (checked.matched[name] ?? 0) + drifted;
    const status = drifted > 0 ? 'MISMATCH' : count > 0 ? 'OK' : 'UNVERIFIED';
    return { name, status, count };
  });
  const failed =
    checked.unknown.length > 0 ||
    rows.some(
      (r) => r.status === 'MISMATCH' || (r.status === 'UNVERIFIED' && required.includes(r.name)),
    );
  return { rows, failed };
}
