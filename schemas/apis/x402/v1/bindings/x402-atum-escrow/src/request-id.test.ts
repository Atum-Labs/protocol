/**
 * The atum-escrow `request_id` recipe: identity is (page, identifier, account), and the page is the
 * resource string the resource server publishes in `extra.atumResource`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import type { PaymentRequirements } from '@x402/core/types';
import { deterministicFullRequestId } from '@atum-labs/payment-request-sender-auth';
import {
  ATUM_RESOURCE_EXTRA_KEY,
  ATUM_RESOURCE_MAX_LENGTH,
  atumEscrowRequestId,
  atumEscrowCanonicalQuery,
  atumEscrowResource,
  hasAtumResource,
  requireAtumResource,
  utf8ByteLength,
} from './request-id';

const ID = 'pay_order_4711_a1b2c3d4';
const EVM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

interface Vector {
  name: string;
  identifier: string;
  account: string;
  method: string;
  path: string;
  queryParams: unknown;
  query: string;
  resource: string;
  request_id: string;
}
const vectors = (
  JSON.parse(
    readFileSync(new URL('../test-vectors/request-id-resource.json', import.meta.url), 'utf8'),
  ) as { cases: Vector[] }
).cases;

describe('atumEscrowRequestId', () => {
  it('gives the same identifier on different pages different ids', () => {
    expect(atumEscrowRequestId(ID, EVM, 'GET /a')).not.toBe(atumEscrowRequestId(ID, EVM, 'GET /b'));
    expect(atumEscrowRequestId(ID, EVM, 'GET /a')).not.toBe(
      atumEscrowRequestId(ID, EVM, 'POST /a'),
    );
  });

  it('reproduces the same id for the same page, identifier and account', () => {
    expect(atumEscrowRequestId(ID, EVM, 'GET /a?x=1')).toBe(
      atumEscrowRequestId(ID, EVM, 'GET /a?x=1'),
    );
  });

  it('anchors on the identifier and the keccak256 of the page', () => {
    const hash = ethers.keccak256(ethers.toUtf8Bytes('GET /a')).slice(2);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(atumEscrowRequestId(ID, EVM, 'GET /a')).toBe(
      deterministicFullRequestId({ anchor: `${ID}:${hash}`, account: EVM, prefix: 'req_x402_' }),
    );
    expect(atumEscrowRequestId(ID, EVM, 'GET /a')).toMatch(/^req_x402_[0-9a-f]{64}$/);
  });

  it('refuses an empty page or identifier', () => {
    expect(() => atumEscrowRequestId(ID, EVM, '')).toThrow(/paid resource is required/);
    expect(() => atumEscrowRequestId('', EVM, 'GET /a')).toThrow(/identifier is required/);
  });
});

describe('atumEscrowResource', () => {
  it('joins the upper-cased method, the path as given and the query', () => {
    expect(atumEscrowResource('get', '/a/b', '?x=1&y=%20')).toBe('GET /a/b?x=1&y=%20');
    expect(atumEscrowResource('GET', '/a', '')).toBe('GET /a');
  });

  it('does not parse or normalize anything', () => {
    expect(atumEscrowResource('GET', '/a/../b', '')).toBe('GET /a/../b');
    expect(atumEscrowResource('GET', '/caf%C3%A9', '')).toBe('GET /caf%C3%A9');
  });
});

describe('atumEscrowCanonicalQuery', () => {
  it('is empty for a query with no keys', () => {
    expect(atumEscrowCanonicalQuery({})).toBe('');
  });

  it('sorts object keys recursively and keeps array order', () => {
    expect(atumEscrowCanonicalQuery({ b: ['2', '1'], a: { z: '1', y: ['x', 'w'] } })).toBe(
      '?{"a":{"y":["x","w"],"z":"1"},"b":["2","1"]}',
    );
  });

  it('reads null-prototype objects and skips undefined members', () => {
    const q = Object.assign(Object.create(null) as Record<string, unknown>, {
      hasOwnProperty: 'x',
      gone: undefined,
    });
    expect(atumEscrowCanonicalQuery(q)).toBe('?{"hasOwnProperty":"x"}');
  });

  it.each([[null], ['a=1'], [['a']]])('refuses a parsed query of %j', (params) => {
    expect(() => atumEscrowCanonicalQuery(params)).toThrow(/must be an object/);
  });

  it('refuses values JSON cannot represent', () => {
    expect(() => atumEscrowCanonicalQuery({ f: () => 1 })).toThrow(/cannot serialize/);
    expect(() => atumEscrowCanonicalQuery({ n: Number.NaN })).toThrow(/cannot serialize/);
  });
});

describe('hasAtumResource', () => {
  it('sees an own key only', () => {
    expect(hasAtumResource({ extra: { atumResource: 'GET /a' } })).toBe(true);
    expect(hasAtumResource({ extra: {} })).toBe(false);
    expect(hasAtumResource({ extra: Object.create({ atumResource: 'GET /a' }) })).toBe(false);
  });
});

describe('requireAtumResource', () => {
  const withExtra = (extra: Record<string, unknown> | undefined) =>
    ({ extra }) as unknown as PaymentRequirements;

  it('returns the published page', () => {
    expect(requireAtumResource(withExtra({ [ATUM_RESOURCE_EXTRA_KEY]: 'GET /a' }))).toBe('GET /a');
  });

  it('accepts a non-ASCII page of exactly 2048 UTF-8 bytes', () => {
    const page = `GET /${'é'.repeat(1021)}a`;
    expect(new TextEncoder().encode(page).length).toBe(ATUM_RESOURCE_MAX_LENGTH);
    expect(requireAtumResource(withExtra({ atumResource: page }))).toBe(page);
  });

  it.each([
    ['missing', {}],
    ['no extra at all', undefined],
    ['empty', { atumResource: '' }],
    ['not a string', { atumResource: 42 }],
    ['too long', { atumResource: 'G'.repeat(ATUM_RESOURCE_MAX_LENGTH + 1) }],
    [
      'over 2048 UTF-8 bytes though under 2048 characters',
      { atumResource: `GET /${'é'.repeat(1022)}` },
    ],
  ])('refuses a requirement whose page is %s', (_label, extra) => {
    expect(() => requireAtumResource(withExtra(extra))).toThrow(/extra\.atumResource/);
  });
});

describe('shared cross-language vectors (test-vectors/request-id-resource.json)', () => {
  it('covers EVM and Solana accounts, a query, a POST and encoded paths', () => {
    expect(vectors.some((v) => v.path.includes('%'))).toBe(true);
    expect(vectors.length).toBeGreaterThanOrEqual(6);
    expect(vectors.some((v) => v.account.startsWith('0x'))).toBe(true);
    expect(vectors.some((v) => !v.account.startsWith('0x'))).toBe(true);
    expect(vectors.some((v) => v.resource.includes('?'))).toBe(true);
    expect(vectors.some((v) => v.resource.startsWith('POST '))).toBe(true);
    expect(vectors.some((v) => v.query.includes('[') && v.query.includes(':{'))).toBe(true);
    expect(vectors.some((v) => utf8ByteLength(v.resource) === ATUM_RESOURCE_MAX_LENGTH)).toBe(true);
    expect(vectors.some((v) => v.resource.includes('\u2028'))).toBe(true);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(atumEscrowCanonicalQuery(v.queryParams)).toBe(v.query);
    expect(atumEscrowResource(v.method, v.path, v.query)).toBe(v.resource);
    expect(atumEscrowRequestId(v.identifier, v.account, v.resource)).toBe(v.request_id);
  });
});
