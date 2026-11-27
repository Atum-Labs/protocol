import { describe, it, expect } from 'vitest';
import { hexlify } from 'ethers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CommitmentError } from './commitment-rules.js';
import * as index from './index.js';
import {
  daysFromCivil,
  depositRequestHashV2,
  depositRequestPreimageV2,
  readDepositRequest,
  REQUEST_SHAPE,
  v2FieldLength,
} from './deposit-request-v2.js';

// The shared vectors, read from the conformance directory rather than a copy, so this suite and the
// Go suite are pinned to the same bytes. If a case fails, reconcile the implementations against the
// vector; do not edit the expectation to match the code.
const VECTORS_PATH = resolve(
  __dirname,
  '../../../../conformance/deposit-request-hash-v2-vectors.json',
);

interface GoldenVector {
  name: string;
  request: string;
  preimage: string;
  want: string;
  wantV1: string;
}
interface RefusedVector {
  name: string;
  request: string;
  detail: string;
}
interface ReencodedVector {
  golden: string;
  path: string;
  request: string;
}
interface ReencodedGap {
  golden: string;
  path: string;
  reason: string;
}
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
  golden: GoldenVector[];
  refused: RefusedVector[];
  reencoded: ReencodedVector[];
  reencodedGaps: ReencodedGap[];
};

describe('depositRequestHash v2 matches the Go implementation byte-for-byte', () => {
  it('has golden and refused vectors', () => {
    // An empty fixture would make every assertion below vacuously pass.
    expect(vectors.golden.length).toBeGreaterThan(0);
    expect(vectors.refused.length).toBeGreaterThan(0);
  });

  for (const c of vectors.golden) {
    it(`hashes ${c.name}`, () => {
      const read = readDepositRequest(c.request);
      expect(hexlify(depositRequestPreimageV2(read.terms)!)).toBe(c.preimage);
      expect(read.depositRequestHashV2).toBe(c.want);
      expect(read.depositRequestHashV1).toBe(c.wantV1);
      expect(depositRequestHashV2(c.request)).toBe(c.want);
    });
  }
});

describe('readDepositRequest refuses exactly what the Go implementation refuses', () => {
  for (const c of vectors.refused) {
    it(`refuses ${c.name}`, () => {
      let refusal: unknown;
      try {
        readDepositRequest(c.request);
      } catch (e) {
        refusal = e;
      }
      expect(refusal).toBeInstanceOf(CommitmentError);
      const { result } = refusal as CommitmentError;
      expect(result.outcome).toBe('request_malformed');
      expect(result.detail).toBe(c.detail);
      expect(() => depositRequestHashV2(c.request)).toThrow(CommitmentError);
    });
  }
});

/** The subtrees v2 never hashes, so the reader does not walk them. */
const OPAQUE_REQUEST_MEMBERS = [
  'presentation',
  'proof',
  'verifiableCredential',
  'originator_auth',
  'sender_auth',
  'settler_auth_required',
];

type Shape = typeof REQUEST_SHAPE;
type SchemaNode = Record<string, unknown>;

/** Renders a shape canonically, members in code point order (every schema name is ASCII). */
function describeShape(s: Shape): string {
  if (s.opaque) return 'opaque';
  if (s.members === undefined && s.elems === undefined) return 'scalar';
  let out = '';
  if (s.members !== undefined) {
    const names = Object.keys(s.members).sort();
    out += `{${names.map((n) => `${n}:${describeShape(s.members![n]!)}`).join(',')}}`;
  }
  if (s.elems !== undefined) out += `[${describeShape(s.elems)}]`;
  return out;
}

/**
 * REQUEST_SHAPE must be exactly the PaymentRequest schema outside the opaque subtrees, so a member
 * added to or removed from schema.json fails here instead of being refused, or allowed, silently.
 * Mirrors the Go TestRequestShapeMatchesSchema.
 */
describe('REQUEST_SHAPE', () => {
  it('matches schema.json outside the opaque subtrees', () => {
    const schema = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../schema.json'), 'utf8'),
    ) as SchemaNode;
    const defs = schema['$defs'] as Record<string, SchemaNode>;
    const shapeOf = (input: SchemaNode): Shape => {
      const ref = input['$ref'];
      const node = typeof ref === 'string' ? defs[ref.replace('#/$defs/', '')]! : input;
      let shape: Shape = {};
      // A union allows what any of its branches allows.
      for (const key of ['oneOf', 'anyOf']) {
        for (const branch of (node[key] as SchemaNode[] | undefined) ?? []) {
          const b = shapeOf(branch);
          if (b.members !== undefined) shape = { ...shape, members: b.members };
          if (b.elems !== undefined) shape = { ...shape, elems: b.elems };
        }
      }
      const properties = node['properties'] as Record<string, SchemaNode> | undefined;
      if (properties !== undefined)
        shape = {
          ...shape,
          members: Object.fromEntries(
            Object.entries(properties).map(([name, child]) => [name, shapeOf(child)]),
          ),
        };
      const items = node['items'] as SchemaNode | undefined;
      if (items !== undefined) shape = { ...shape, elems: shapeOf(items) };
      return shape;
    };
    const want = shapeOf(schema);
    const members = { ...want.members };
    for (const name of OPAQUE_REQUEST_MEMBERS) {
      expect(members, `opaque member ${name} is in the schema`).toHaveProperty(name);
      members[name] = { opaque: true };
    }
    expect(describeShape(REQUEST_SHAPE)).toBe(describeShape({ members }));
  });
});

/**
 * daysFromCivil must agree with the platform calendar on every day it can be asked about: the
 * arithmetic, not a date parser, decides the instant v2 commits. Mirrors the Go
 * TestDaysFromCivilMatchesTimeDate.
 */
describe('daysFromCivil', () => {
  it('matches Date on every day of years 0 to 9999', () => {
    const day = new Date(0);
    day.setUTCFullYear(0, 0, 1);
    for (; day.getUTCFullYear() <= 9999; day.setUTCDate(day.getUTCDate() + 1)) {
      const got = daysFromCivil(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
      const want = Math.floor(day.getTime() / 86_400_000);
      if (got !== want) expect.fail(`daysFromCivil(${day.toISOString()}) = ${got}, want ${want}`);
    }
  });
});

describe('the package index', () => {
  it('exports the v2 reader, its hash and the executor roles', () => {
    expect(index.readDepositRequest).toBe(readDepositRequest);
    expect(index.depositRequestHashV2).toBe(depositRequestHashV2);
    expect([index.EXECUTOR_SETTLER, index.EXECUTOR_ORIGINATOR]).toEqual([0x00, 0x01]);
  });
});

/**
 * A request may nest as deep as `MAX_JSON_DEPTH`, or carry a very large array, where the schema has
 * a scalar. Each is refused like any other wrong type, not with a stack overflow. Built here rather
 * than stored in the shared vectors to keep that file reviewable. Mirrors the Go
 * TestReadDepositRequestRefusesDeepAndWideValues.
 */
describe('readDepositRequest on deep and wide values', () => {
  const base = vectors.golden[0]!.request;
  const cases = {
    'nested 9990 deep': '['.repeat(9990) + ']'.repeat(9990),
    '200000 elements wide': `[${Array(200000).fill('0').join(',')}]`,
  };
  for (const [name, value] of Object.entries(cases)) {
    it(`refuses an array ${name} at a scalar position`, () => {
      const request = `${base.slice(0, -1)},"quote_selector":${value}}`;
      let refusal: unknown;
      try {
        readDepositRequest(request);
      } catch (e) {
        refusal = e;
      }
      expect(refusal).toBeInstanceOf(CommitmentError);
      expect((refusal as CommitmentError).result.detail).toBe(
        'the payment request is not readable: quote_selector is not a string',
      );
    });
  }
});

/**
 * v2 must not change under an honest re-encode between the payer and a reader. Each row is a golden
 * request as one such path re-encoded it. Mirrors the Go
 * TestDepositRequestHashV2IsInvariantUnderReencodes.
 */
describe('depositRequestHash v2 under honest re-encodes', () => {
  /**
   * Every golden carries exactly one row per re-encode path, unless `reencodedGaps` names that pair
   * with the reason the path never re-encodes it, and then it carries none. Mirrors the Go
   * TestDepositRequestHashV2ReencodesEveryGolden.
   */
  it('has one row per golden and path, except the named gaps', () => {
    const paths = ['go-schemajson', 'settler-zod-jcs', 'postgres-jsonb'];
    const key = (golden: string, path: string) => JSON.stringify([path, golden]);
    const expected = new Set<string>();
    for (const g of vectors.golden) for (const path of paths) expected.add(key(g.name, path));
    for (const gap of vectors.reencodedGaps) {
      expect(gap.reason, `reason for ${key(gap.golden, gap.path)}`).not.toBe('');
      expect(expected.delete(key(gap.golden, gap.path)), `gap ${key(gap.golden, gap.path)}`).toBe(
        true,
      );
    }
    expect(vectors.reencoded.map((c) => key(c.golden, c.path)).sort()).toEqual(
      [...expected].sort(),
    );
  });
  const golden = new Map(vectors.golden.map((g) => [g.name, g]));
  for (const c of vectors.reencoded) {
    it(`keeps v1 and v2 for ${c.golden} through ${c.path}`, () => {
      const g = golden.get(c.golden);
      expect(g, `golden vector ${c.golden}`).toBeDefined();
      const read = readDepositRequest(c.request);
      expect(read.depositRequestHashV1).toBe(g!.wantV1);
      expect(read.depositRequestHashV2).toBe(g!.want);
    });
  }
});

/**
 * A field's length prefix is a uint32, so a field it cannot count is refused, never wrapped into a
 * shorter prefix that another request could share. Mirrors the Go
 * TestV2FieldLengthRefusesWhatAUint32CannotCount.
 */
describe('v2FieldLength', () => {
  it('counts up to 2^32-1 and refuses beyond', () => {
    expect(v2FieldLength(0xffffffff)).toBe(0xffffffff);
    expect(v2FieldLength(0x100000000)).toBeUndefined();
  });
});
