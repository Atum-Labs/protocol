import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { firstAmbiguousMember, firstAmbiguousMemberIn, InvalidJsonError } from './json-members.js';
import { verifyRequestCommitment } from './commitment.js';
import { CommitmentError } from './commitment-rules.js';

// Seeded mutations of the shared vectors, so a failure reproduces. Mirrors the Go fuzz targets.
const CONFORMANCE = resolve(__dirname, '../../../../conformance');
const members = JSON.parse(
  readFileSync(`${CONFORMANCE}/json-member-vectors.json`, 'utf8'),
) as Record<string, unknown>;
const requests = JSON.parse(readFileSync(`${CONFORMANCE}/verify-json-vectors.json`, 'utf8')) as {
  vectors: Array<{ request: string }>;
};
// Every section of the member vectors, so a new section seeds the mutations too.
const SEEDS = [
  ...Object.values(members)
    .filter((section): section is Array<{ document: string }> => Array.isArray(section))
    .flatMap((section) => section.map((v) => v.document)),
  ...requests.vectors.map((v) => v.request),
];
const READ = ['source', 'destination', 'request_id', 'sender_auth'];
const ALPHABET = [
  '{',
  '}',
  '[',
  ']',
  ':',
  ',',
  '"',
  '\\',
  ' ',
  'a',
  'A',
  '0',
  '-',
  'e',
  'n',
  '\u017f', // long s, folds to s
  'K',
  '\u212a', // Kelvin sign, folds to k
  '\ud800',
];

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutations(count: number): string[] {
  const random = mulberry32(0x5eed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let text = pick(SEEDS);
    for (let edits = 1 + Math.floor(random() * 3); edits > 0; edits--) {
      const at = Math.floor(random() * (text.length + 1));
      const cut = Math.floor(random() * 3);
      text = text.slice(0, at) + (random() < 0.8 ? pick(ALPHABET) : '') + text.slice(at + cut);
    }
    out.push(text);
  }
  return out;
}

// Sized to finish well inside the time limit on a slow CI runner; the Go fuzz targets explore further.
const MUTATIONS = 5000;
const TIME_LIMIT_MS = 30_000;

describe('JSON scanner and request check under mutation', { timeout: TIME_LIMIT_MS }, () => {
  const inputs = mutations(MUTATIONS);

  it('the scanner throws only InvalidJsonError and passes only valid JSON', () => {
    for (const text of inputs) {
      let path: string | undefined;
      try {
        path = firstAmbiguousMember(text);
      } catch (e) {
        expect(e, text).toBeInstanceOf(InvalidJsonError);
        continue;
      }
      if (path === undefined) expect(() => JSON.parse(text), text).not.toThrow();
    }
  });

  // The scoped scan refuses only what the full scan refuses, and inside a read member it reports
  // exactly what the full scan reports. Mirrors the Go FuzzFirstAmbiguousMemberIn.
  it('the scoped scan agrees with the full scan', () => {
    const scan = (run: () => string | undefined) => {
      try {
        return { path: run(), invalid: false };
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidJsonError);
        return { path: undefined, invalid: true };
      }
    };
    for (const text of inputs) {
      const full = scan(() => firstAmbiguousMember(text));
      const scoped = scan(() => firstAmbiguousMemberIn(text, READ));
      if (full.invalid) expect(scoped.invalid, text).toBe(true);
      if (scoped.invalid || scoped.path !== undefined) {
        expect(full.invalid || full.path !== undefined, text).toBe(true);
      }
      if (full.invalid) continue; // a malformed text could close the wrapper early
      const wrapped = `{"Read":${text}}`;
      expect(
        scan(() => firstAmbiguousMemberIn(wrapped, ['read'])),
        text,
      ).toEqual(scan(() => firstAmbiguousMember(wrapped)));
    }
  });

  it('the request check throws only CommitmentError', () => {
    const domain = {
      escrowProgramId: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
      clusterId: 'devnet',
      domainVersion: 5,
    };
    for (const text of inputs) {
      try {
        expect(verifyRequestCommitment(text, domain).outcome, text).toBe('verified');
      } catch (e) {
        expect(e, text).toBeInstanceOf(CommitmentError);
      }
    }
  });
});
