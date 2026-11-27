// Borsh decoding driven by an Anchor IDL, for scripts/check-deployed-events.mjs. No I/O here, so
// every rule is unit tested in src/idl-decode.test.ts.
//
// Values are normalized so they compare with ===: pubkeys as base58, byte arrays as hex, 64-bit
// and wider integers as bigint.

import bs58 from 'bs58';

const INTS = {
  u8: [1, false],
  i8: [1, true],
  u16: [2, false],
  i16: [2, true],
  u32: [4, false],
  i32: [4, true],
  u64: [8, false],
  i64: [8, true],
  u128: [16, false],
  i128: [16, true],
};

function readInt(bytes, signed) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  if (signed && bytes[bytes.length - 1] & 0x80) v -= 1n << BigInt(bytes.length * 8);
  return bytes.length >= 8 ? v : Number(v);
}

function reader(buf, types) {
  let at = 0;
  // Every read goes through here, so data shorter than the layout throws instead of decoding junk.
  const take = (n) => {
    if (at + n > buf.length)
      throw new RangeError(`data ends at byte ${buf.length}, before ${at + n}`);
    const bytes = buf.subarray(at, at + n);
    at += n;
    return bytes;
  };
  const read = (type) => {
    if (typeof type === 'string' && type in INTS) {
      const [size, signed] = INTS[type];
      return readInt(take(size), signed);
    }
    if (type === 'bool') return take(1)[0] !== 0;
    if (type === 'pubkey') return bs58.encode(take(32));
    if (type === 'string') return take(take(4).readUInt32LE(0)).toString('utf8');
    if (type.array && type.array[0] === 'u8') return take(type.array[1]).toString('hex');
    if (type.defined) return readFields(types.get(type.defined.name).type.fields);
    throw new Error(`cannot decode ${JSON.stringify(type)}`);
  };
  const readFields = (fields) => Object.fromEntries(fields.map((f) => [f.name, read(f.type)]));
  return { readFields };
}

/** The event a `Program data:` payload (discriminator + body) carries, or null if the IDL has none. */
export function decodeEvent(idl, payload) {
  const discriminator = payload.subarray(0, 8);
  const event = idl.events.find((e) => Buffer.from(e.discriminator).equals(discriminator));
  if (!event) return null;
  const types = new Map(idl.types.map((t) => [t.name, t]));
  const { readFields } = reader(payload.subarray(8), types);
  return { name: event.name, fields: readFields(types.get(event.name).type.fields) };
}

/**
 * A program instruction from a `jsonParsed` transaction (base58 data, resolved account addresses),
 * with its accounts named by the IDL and its args decoded, or null if the IDL does not declare it
 * or its data ends before the IDL's args do (an instruction from an older client).
 */
export function decodeInstruction(idl, ix) {
  const data = Buffer.from(bs58.decode(ix.data));
  const discriminator = data.subarray(0, 8);
  const decl = idl.instructions.find((i) => Buffer.from(i.discriminator).equals(discriminator));
  if (!decl) return null;
  const { readFields } = reader(data.subarray(8), new Map(idl.types.map((t) => [t.name, t])));
  let args;
  try {
    args = readFields(decl.args);
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
  return {
    name: decl.name,
    accounts: Object.fromEntries(decl.accounts.map((a, i) => [a.name, ix.accounts[i]])),
    args,
  };
}
