import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  firstAmbiguousMember,
  firstAmbiguousMemberIn,
  foldMemberName,
  InvalidJsonError,
  MAX_JSON_DEPTH,
} from './json-members.js';
import { SIMPLE_FOLD_PAIRS } from './simple-fold.gen.js';

// The same vectors the Go suite reads, so both languages refuse exactly the same documents.
const vectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../conformance/json-member-vectors.json'), 'utf8'),
) as {
  ambiguous: Array<{ name: string; document: string; want: string | null }>;
  invalid: Array<{ name: string; document: string; detailContains?: string }>;
  scoped: Array<{ name: string; document: string; read: string[]; want: string | null }>;
  scopedInvalid: Array<{ name: string; document: string; read: string[]; detailContains?: string }>;
};

// Mirrors the Go TestFirstAmbiguousMemberIn_SharedVectors.
describe('firstAmbiguousMemberIn', () => {
  it.each(vectors.scoped.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(firstAmbiguousMemberIn(c.document, c.read)).toBe(c.want ?? undefined);
  });

  it.each(vectors.scopedInvalid.map((c) => [c.name, c] as const))('refuses %s', (_name, c) => {
    const scan = () => firstAmbiguousMemberIn(c.document, c.read);
    expect(scan).toThrow(InvalidJsonError);
    if (c.detailContains !== undefined) expect(scan).toThrow(c.detailContains);
  });
});

describe('firstAmbiguousMember', () => {
  it.each(vectors.ambiguous.map((c) => [c.name, c.document, c.want] as const))(
    '%s',
    (_name, document, want) => {
      expect(firstAmbiguousMember(document)).toBe(want ?? undefined);
    },
  );

  // Titled by name, since a depth vector's document is 20 KB. Where the vector names the reason,
  // any other refusal fails: a depth vector must be refused for its depth. Mirrors the Go
  // TestFirstAmbiguousMember_SharedVectors.
  it.each(vectors.invalid.map((c) => [c.name, c] as const))('refuses %s', (_name, c) => {
    const scan = () => firstAmbiguousMember(c.document);
    expect(scan).toThrow(InvalidJsonError);
    if (c.detailContains !== undefined) expect(scan).toThrow(c.detailContains);
  });

  it('carries no two identical names', () => {
    const names = [
      ...vectors.ambiguous,
      ...vectors.invalid,
      ...vectors.scoped,
      ...vectors.scopedInvalid,
    ].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // A raw lone surrogate cannot travel as UTF-8, so Go only ever sees U+FFFD in its place.
  it('reads a raw lone surrogate as U+FFFD', () => {
    const high = String.fromCharCode(0xd800);
    const replacement = String.fromCharCode(0xfffd);
    expect(firstAmbiguousMember(`{"${high}":1,"${replacement}":2}`)).toBe(`$.${replacement}`);
  });

  it('carries no two identical documents', () => {
    const documents = [
      ...vectors.ambiguous,
      ...vectors.invalid,
      ...vectors.scoped,
      ...vectors.scopedInvalid,
    ].map((c) => c.document);
    expect(new Set(documents).size).toBe(documents.length);
  });

  describe("refuses exactly the nesting Go's encoding/json refuses", () => {
    const shapes: Record<string, (depth: number) => string> = {
      arrays: (d) => '['.repeat(d) + ']'.repeat(d),
      objects: (d) => '{"a":'.repeat(d) + '1' + '}'.repeat(d),
      'inside a context': (d) => '{"@context":' + '['.repeat(d - 1) + ']'.repeat(d - 1) + '}',
    };
    it.each(Object.entries(shapes))('%s', (_name, shape) => {
      expect(firstAmbiguousMember(shape(MAX_JSON_DEPTH))).toBeUndefined();
      expect(() => firstAmbiguousMember(shape(MAX_JSON_DEPTH + 1))).toThrow(/levels deep/);
    });
  });

  it('reports the full path of a twin at the depth limit', () => {
    const depth = MAX_JSON_DEPTH - 1;
    const document = '['.repeat(depth) + '{"k":1,"K":2}' + ']'.repeat(depth);
    expect(firstAmbiguousMember(document)).toBe('$' + '[0]'.repeat(depth) + '.K');
  });
});

describe('foldMemberName', () => {
  it('maps a whole name, astral characters included, onto one representative', () => {
    expect(foldMemberName('Account')).toBe(foldMemberName('aCCOUNT'));
    expect(foldMemberName(String.fromCharCode(0x17f, 0x212a))).toBe(foldMemberName('sk'));
    expect(foldMemberName('\u{10428}')).toBe(foldMemberName('\u{10400}'));
    expect(foldMemberName('a')).not.toBe(foldMemberName('b'));
  });

  // The table is generated from Go. The engine's own simple case folding (the `iu` regex flag) is an
  // independent implementation, so every pair in the table must also match there.
  it("folds only pairs the JavaScript engine's simple case folding also equates", () => {
    expect(SIMPLE_FOLD_PAIRS.length % 2).toBe(0);
    let previous = -1;
    for (let i = 0; i < SIMPLE_FOLD_PAIRS.length; i += 2) {
      const codePoint = SIMPLE_FOLD_PAIRS[i]!;
      const least = SIMPLE_FOLD_PAIRS[i + 1]!;
      expect(codePoint).toBeGreaterThan(previous);
      expect(least).toBeLessThan(codePoint);
      previous = codePoint;
      expect(
        new RegExp(`^\\u{${codePoint.toString(16)}}$`, 'iu').test(String.fromCodePoint(least)),
      ).toBe(true);
      expect(foldMemberName(String.fromCodePoint(least))).toBe(String.fromCodePoint(least));
    }
  });
});
