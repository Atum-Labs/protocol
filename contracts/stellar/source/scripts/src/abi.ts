/**
 * Contract call signatures and their ScVal encoding.
 *
 * The argument lists below are written down here and PINNED to the Rust source by abi.test.ts, which
 * parses the escrow and proxy `src/lib.rs` and `contracts/escrow/src/types.rs` and fails on any drift in
 * names, order or types. abi.wasm.test.ts additionally compares them against the spec of the compiled
 * wasm (`stellar contract build`, CLI v30), so the tables here are checked against both the source and
 * the built contract.
 */
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

/** [argument name, Rust type] in declaration order, `env: Env` omitted. */
export type Signature = readonly (readonly [name: string, rustType: string])[];

export const ESCROW_FUNCTIONS = {
  __constructor: [
    ['default_admin', 'Address'],
    ['admin_delay_secs', 'u32'],
  ],
  grant_role: [
    ['role', 'Role'],
    ['account', 'Address'],
  ],
  has_role: [
    ['role', 'Role'],
    ['account', 'Address'],
  ],
  allow_token_and_set_fee_config: [
    ['caller', 'Address'],
    ['token', 'Address'],
    ['decimals', 'u32'],
    ['fee_percentage_6', 'u32'],
    ['min_fee_6', 'u64'],
    ['max_fee_6', 'u64'],
  ],
  set_token_fee_config: [
    ['caller', 'Address'],
    ['token', 'Address'],
    ['fee_percentage_6', 'u32'],
    ['min_fee_6', 'u64'],
    ['max_fee_6', 'u64'],
  ],
  get_token_config: [['token', 'Address']],
  get_allowed_tokens: [],
  default_admin_delay: [],
  is_token_allowed: [['token', 'Address']],
  determine_fee: [
    ['amount', 'i128'],
    ['config', 'TokenConfig'],
  ],
  create_delegate: [
    ['depositor', 'Address'],
    ['token', 'Address'],
    ['delegate_signer', 'BytesN<32>'],
    ['capacity', 'i128'],
    ['max_transfer_size', 'i128'],
    ['expiration', 'u64'],
  ],
  deposit: [['input', 'DepositInput']],
  release: [
    ['witness', 'ReleaseWitness'],
    ['signature', 'BytesN<64>'],
  ],
  refund: [
    ['witness', 'RefundWitness'],
    ['signature', 'BytesN<64>'],
  ],
  revoke_delegate: [
    ['depositor', 'Address'],
    ['token', 'Address'],
  ],
  pause: [['caller', 'Address']],
  unpause: [['caller', 'Address']],
  paused: [],
  get_delegate: [
    ['depositor', 'Address'],
    ['token', 'Address'],
  ],
  get_deposit_hash: [['deposit_id', 'BytesN<32>']],
  get_fee_revenue: [['token', 'Address']],
  extend_deposit_ttl: [['deposit_id', 'BytesN<32>']],
  default_admin: [],
} as const satisfies Record<string, Signature>;

export const PROXY_FUNCTIONS = {
  __constructor: [
    ['default_admin', 'Address'],
    ['pauser', 'Address'],
    ['delay_seconds', 'u32'],
  ],
  fulfill: [
    ['settler', 'Address'],
    ['quote_hash', 'BytesN<32>'],
    ['to', 'Address'],
    ['token', 'Address'],
    ['amount', 'i128'],
    ['deadline', 'u64'],
    ['nonce', 'u64'],
  ],
  strict_fulfill: [
    ['settler', 'Address'],
    ['quote_hash', 'BytesN<32>'],
    ['to', 'Address'],
    ['token', 'Address'],
    ['amount', 'i128'],
    ['deadline', 'u64'],
    ['nonce', 'u64'],
  ],
  authorize_fulfillment: [
    ['settler', 'Address'],
    ['quote_hash', 'BytesN<32>'],
    ['authorization_hash', 'BytesN<32>'],
  ],
  pause: [],
  unpause: [],
  is_strictly_fulfilled: [
    ['quote_hash', 'BytesN<32>'],
    ['to', 'Address'],
    ['token', 'Address'],
    ['amount', 'i128'],
  ],
  default_admin: [],
  pauser: [],
  is_paused: [],
  default_admin_delay: [],
  settler_allowlist_enforced: [],
} as const satisfies Record<string, Signature>;

/**
 * SEP-41 token functions the smoke script calls. Pinned to the SEP-41 text, not to a Rust file in
 * this repo: the test token is whatever the operator supplies.
 */
export const TOKEN_FUNCTIONS = {
  approve: [
    ['from', 'Address'],
    ['spender', 'Address'],
    ['amount', 'i128'],
    ['expiration_ledger', 'u32'],
  ],
  balance: [['id', 'Address']],
} as const satisfies Record<string, Signature>;

/** `#[contracttype]` structs from contracts/escrow/src/types.rs that this tooling builds. */
export const STRUCTS = {
  DepositWitness: [
    ['deposit_request_hash', 'BytesN<32>'],
    ['destination', 'String'],
    ['reserver', 'BytesN<32>'],
    ['releaser', 'BytesN<32>'],
  ],
  ReserveWitness: [
    ['deposit_id', 'BytesN<32>'],
    ['quote_hash', 'BytesN<32>'],
    ['settler', 'Address'],
    ['source_amount', 'i128'],
  ],
  DepositInput: [
    ['depositor', 'Address'],
    ['token', 'Address'],
    ['amount', 'i128'],
    ['deposit_witness', 'DepositWitness'],
    ['nonce', 'u64'],
    ['issued_at', 'u64'],
    ['deadline', 'u64'],
    ['delegate_signature', 'BytesN<64>'],
    ['reserve_witness', 'ReserveWitness'],
    ['reserve_signature', 'BytesN<64>'],
  ],
  ReleaseWitness: [
    ['deposit_id', 'BytesN<32>'],
    ['quote_hash', 'BytesN<32>'],
    ['deposit_request_hash', 'BytesN<32>'],
    ['destination_hash', 'BytesN<32>'],
    ['depositor', 'Address'],
    ['token', 'Address'],
    ['amount', 'i128'],
    ['fee_amount', 'i128'],
    ['reserver', 'BytesN<32>'],
    ['releaser', 'BytesN<32>'],
    ['settler', 'Address'],
  ],
  RefundWitness: [
    ['deposit_id', 'BytesN<32>'],
    ['quote_hash', 'BytesN<32>'],
    ['deposit_request_hash', 'BytesN<32>'],
    ['destination_hash', 'BytesN<32>'],
    ['depositor', 'Address'],
    ['token', 'Address'],
    ['amount', 'i128'],
    ['fee_amount', 'i128'],
    ['reserver', 'BytesN<32>'],
    ['releaser', 'BytesN<32>'],
    ['settler', 'Address'],
  ],
  TokenConfig: [
    ['fee_percentage_6', 'u32'],
    ['max_fee_6', 'u64'],
    ['min_fee_6', 'u64'],
    ['token_decimals', 'u32'],
  ],
} as const satisfies Record<string, Signature>;

/** Unit variants of `enum Role` in types.rs */
export const ROLES = ['Pauser', 'Treasurer', 'TokenConfig'] as const;
export type RoleName = (typeof ROLES)[number];

/** A JS value for a Soroban argument; structs are plain objects keyed by Rust field name. */
export type ArgValue =
  string | number | bigint | boolean | Uint8Array | { [field: string]: ArgValue };

function bytesN(value: ArgValue, n: number, what: string): xdr.ScVal {
  if (!(value instanceof Uint8Array) || value.length !== n) {
    throw new TypeError(`${what}: expected ${n} bytes`);
  }
  return xdr.ScVal.scvBytes(Buffer.from(value));
}

function intOf(value: ArgValue, what: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`${what}: expected an integer`);
}

function uint(value: ArgValue, bits: 32 | 64, what: string): bigint {
  const v = intOf(value, what);
  if (v < 0n || v >= 1n << BigInt(bits)) throw new RangeError(`${what}: out of u${bits} range`);
  return v;
}

/** Encode one value as the Rust type `rustType`. */
export function encodeValue(rustType: string, value: ArgValue, what = rustType): xdr.ScVal {
  switch (rustType) {
    case 'Address':
      if (typeof value !== 'string') throw new TypeError(`${what}: expected a strkey`);
      return new Address(value).toScVal();
    case 'u32':
      return xdr.ScVal.scvU32(Number(uint(value, 32, what)));
    case 'u64':
      return nativeToScVal(uint(value, 64, what), { type: 'u64' });
    case 'i128': {
      const v = intOf(value, what);
      if (v < -(1n << 127n) || v >= 1n << 127n) throw new RangeError(`${what}: out of i128 range`);
      return nativeToScVal(v, { type: 'i128' });
    }
    case 'bool':
      if (typeof value !== 'boolean') throw new TypeError(`${what}: expected a boolean`);
      return xdr.ScVal.scvBool(value);
    case 'BytesN<32>':
      return bytesN(value, 32, what);
    case 'BytesN<64>':
      return bytesN(value, 64, what);
    case 'String':
      if (typeof value !== 'string') throw new TypeError(`${what}: expected a string`);
      return xdr.ScVal.scvString(value);
    case 'Role': {
      if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) {
        throw new TypeError(`${what}: expected one of ${ROLES.join(', ')}`);
      }
      // A unit variant of a #[contracttype] enum is a one-element vec holding its name as a symbol
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(value)]);
    }
    default: {
      const fields = (STRUCTS as Record<string, Signature>)[rustType];
      if (fields === undefined) throw new Error(`no encoder for Rust type ${rustType}`);
      if (typeof value !== 'object' || value instanceof Uint8Array) {
        throw new TypeError(`${what}: expected an object`);
      }
      const given = Object.keys(value).sort();
      const want = fields.map(([n]) => n).sort();
      if (given.join(',') !== want.join(',')) {
        throw new TypeError(
          `${what}: fields [${given.join(', ')}] do not match [${want.join(', ')}]`,
        );
      }
      // #[contracttype] structs are maps keyed by field symbol, sorted by key
      const entries = [...fields]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(
          ([name, ty]) =>
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol(name),
              val: encodeValue(ty, value[name] as ArgValue, `${what}.${name}`),
            }),
        );
      return xdr.ScVal.scvMap(entries);
    }
  }
}

/** Encode the argument list of `fn` from `sig`, by position. */
export function encodeArgs(sig: Signature, values: readonly ArgValue[], fn: string): xdr.ScVal[] {
  if (values.length !== sig.length) {
    throw new TypeError(`${fn}: expected ${sig.length} arguments, got ${values.length}`);
  }
  return sig.map(([name, ty], i) => encodeValue(ty, values[i] as ArgValue, `${fn}.${name}`));
}

export function escrowArgs<F extends keyof typeof ESCROW_FUNCTIONS>(
  fn: F,
  ...values: ArgValue[]
): xdr.ScVal[] {
  return encodeArgs(ESCROW_FUNCTIONS[fn], values, `escrow.${fn}`);
}

export function proxyArgs<F extends keyof typeof PROXY_FUNCTIONS>(
  fn: F,
  ...values: ArgValue[]
): xdr.ScVal[] {
  return encodeArgs(PROXY_FUNCTIONS[fn], values, `proxy.${fn}`);
}

export function tokenArgs<F extends keyof typeof TOKEN_FUNCTIONS>(
  fn: F,
  ...values: ArgValue[]
): xdr.ScVal[] {
  return encodeArgs(TOKEN_FUNCTIONS[fn], values, `token.${fn}`);
}
