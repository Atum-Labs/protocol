/**
 * Pins src/abi.ts to the Rust source: every function this tooling calls must have exactly the
 * argument names, order and types the contract declares, and every struct it builds must have
 * exactly the contract's fields. If the contract changes, this fails before a transaction does.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Address, StrKey, scValToNative } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  ESCROW_FUNCTIONS,
  PROXY_FUNCTIONS,
  ROLES,
  STRUCTS,
  TOKEN_FUNCTIONS,
  encodeValue,
  escrowArgs,
  proxyArgs,
  tokenArgs,
  type Signature,
} from './abi.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, '../../contracts', rel), 'utf8');

const stripComments = (s: string) => s.replace(/\/\/.*$/gm, '');

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    if (ch === '>' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map((p) => p.trim()).filter((p) => p !== '');
}

function pair(p: string): [string, string] {
  const i = p.indexOf(':');
  return [
    p.slice(0, i).trim(),
    p
      .slice(i + 1)
      .replace(/\s+/g, ' ')
      .trim(),
  ];
}

/** Public functions of a lib.rs: name -> [argName, type][] with `env: Env` dropped */
function parseFunctions(src: string): Record<string, [string, string][]> {
  const text = stripComments(src);
  const out: Record<string, [string, string][]> = {};
  for (const m of text.matchAll(/pub fn (\w+)\s*\(/g)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    while (depth > 0) {
      if (text[i] === '(') depth++;
      if (text[i] === ')') depth--;
      i++;
    }
    const params = splitTopLevel(text.slice(start, i - 1))
      .map(pair)
      .filter(([n, t]) => !((n === 'env' || n === '_env') && t === 'Env'));
    out[m[1] as string] = params;
  }
  return out;
}

function parseStructs(src: string): Record<string, [string, string][]> {
  const text = stripComments(src);
  const out: Record<string, [string, string][]> = {};
  for (const m of text.matchAll(/pub struct (\w+)\s*\{([^}]*)\}/g)) {
    out[m[1] as string] = splitTopLevel(m[2] as string).map((f) => pair(f.replace(/^pub\s+/, '')));
  }
  return out;
}

const asPairs = (s: Signature) => s.map(([n, t]) => [n, t]);

describe('abi matches the Rust source', () => {
  const escrowFns = parseFunctions(read('escrow/src/lib.rs'));
  const proxyFns = parseFunctions(read('fulfillment_proxy/src/lib.rs'));
  const structs = parseStructs(read('escrow/src/types.rs'));

  it('sanity: the parser found the contracts', () => {
    expect(Object.keys(escrowFns)).toContain('__constructor');
    expect(Object.keys(escrowFns)).toContain('deposit');
    expect(Object.keys(proxyFns)).toContain('__constructor');
  });

  it.each(Object.entries(ESCROW_FUNCTIONS))('escrow.%s', (name, sig) => {
    expect(escrowFns[name], `escrow has no pub fn ${name}`).toBeDefined();
    expect(asPairs(sig)).toEqual(escrowFns[name]);
  });

  it.each(Object.entries(PROXY_FUNCTIONS))('proxy.%s', (name, sig) => {
    expect(proxyFns[name], `proxy has no pub fn ${name}`).toBeDefined();
    expect(asPairs(sig)).toEqual(proxyFns[name]);
  });

  it.each(Object.entries(STRUCTS))(
    'struct %s has the contract fields in the contract order',
    (name, fields) => {
      expect(structs[name], `types.rs has no struct ${name}`).toBeDefined();
      expect(asPairs(fields)).toEqual(structs[name]);
    },
  );

  it('Role has exactly the unit variants listed', () => {
    const m = stripComments(read('escrow/src/types.rs')).match(/pub enum Role\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(splitTopLevel(m?.[1] ?? '')).toEqual([...ROLES]);
  });

  it('the constructors are exactly what the issue says', () => {
    // proxy: (admin, pauser, delay); escrow: (default_admin, admin_delay_secs)
    expect(escrowFns.__constructor).toEqual([
      ['default_admin', 'Address'],
      ['admin_delay_secs', 'u32'],
    ]);
    expect(proxyFns.__constructor).toEqual([
      ['default_admin', 'Address'],
      ['pauser', 'Address'],
      ['delay_seconds', 'u32'],
    ]);
  });

  it('SEP-41 token calls keep the standard order', () => {
    expect(asPairs(TOKEN_FUNCTIONS.approve).map(([n]) => n)).toEqual([
      'from',
      'spender',
      'amount',
      'expiration_ledger',
    ]);
  });
});

const G = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const G2 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const C = StrKey.encodeContract(Buffer.alloc(32, 3));

describe('encoding', () => {
  it('encodes the escrow constructor as (Address, u32) in order', () => {
    const args = escrowArgs('__constructor', G, 86_400);
    expect(args.map((a) => a.type)).toEqual(['scvAddress', 'scvU32']);
    expect(Address.fromScVal(args[0] as never).toString()).toBe(G);
    expect(scValToNative(args[1] as never)).toBe(86_400);
  });

  it('encodes the proxy constructor as (admin, pauser, delay), admin first', () => {
    const args = proxyArgs('__constructor', G, G2, 7);
    expect(args.map((a) => a.type)).toEqual(['scvAddress', 'scvAddress', 'scvU32']);
    expect(Address.fromScVal(args[0] as never).toString()).toBe(G);
    expect(Address.fromScVal(args[1] as never).toString()).toBe(G2);
    expect(scValToNative(args[2] as never)).toBe(7);
  });

  it('encodes allow_token_and_set_fee_config in the contract order with u32/u64 widths', () => {
    const args = escrowArgs('allow_token_and_set_fee_config', G, C, 7, 1_000_000, 5n, 9n);
    expect(args.map((a) => a.type)).toEqual([
      'scvAddress',
      'scvAddress',
      'scvU32',
      'scvU32',
      'scvU64',
      'scvU64',
    ]);
  });

  it('encodes a role as a one-element vec holding the variant symbol', () => {
    const [role] = escrowArgs('grant_role', 'TokenConfig', G);
    expect(role?.type).toBe('scvVec');
    expect(scValToNative(role as never)).toEqual(['TokenConfig']);
  });

  it('rejects an unknown role', () => {
    expect(() => escrowArgs('grant_role', 'Root', G)).toThrow(/expected one of/);
  });

  it('encodes i128 including values past 2^64', () => {
    const v = 10n ** 30n;
    expect(scValToNative(encodeValue('i128', v))).toBe(v);
    expect(scValToNative(encodeValue('i128', -5n))).toBe(-5n);
    expect(() => encodeValue('i128', 1n << 127n)).toThrow(RangeError);
  });

  it('rejects out-of-range and mistyped values', () => {
    expect(() => encodeValue('u32', 2 ** 32)).toThrow(RangeError);
    expect(() => encodeValue('u32', -1)).toThrow(RangeError);
    expect(() => encodeValue('u64', 1n << 64n)).toThrow(RangeError);
    expect(() => encodeValue('BytesN<32>', new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => encodeValue('BytesN<64>', new Uint8Array(32))).toThrow(/64 bytes/);
    expect(() => encodeValue('Address', 5)).toThrow(TypeError);
  });

  it('rejects the wrong number of arguments', () => {
    expect(() => escrowArgs('__constructor', G)).toThrow(/expected 2 arguments, got 1/);
  });

  it('encodes a struct as a map with symbol keys sorted, and round-trips', () => {
    const cfg = { fee_percentage_6: 5, max_fee_6: 9n, min_fee_6: 1n, token_decimals: 7 };
    const sc = encodeValue('TokenConfig', cfg);
    expect(sc.type).toBe('scvMap');
    // scValToNative preserves entry order, so this is the on-wire (sorted) key order
    const keys = Object.keys(scValToNative(sc) as Record<string, unknown>);
    expect(keys).toEqual(['fee_percentage_6', 'max_fee_6', 'min_fee_6', 'token_decimals']);
    expect(scValToNative(sc)).toEqual(cfg);
  });

  it('rejects a struct with a missing or extra field', () => {
    expect(() => encodeValue('TokenConfig', { fee_percentage_6: 1 })).toThrow(/do not match/);
    expect(() =>
      encodeValue('TokenConfig', {
        fee_percentage_6: 1,
        max_fee_6: 0,
        min_fee_6: 0,
        token_decimals: 7,
        extra: 1,
      }),
    ).toThrow(/do not match/);
  });

  it('token.approve takes (from, spender, amount, expiration_ledger u32)', () => {
    const args = tokenArgs('approve', G, C, 100n, 12345);
    expect(args.map((a) => a.type)).toEqual(['scvAddress', 'scvAddress', 'scvI128', 'scvU32']);
  });
});
