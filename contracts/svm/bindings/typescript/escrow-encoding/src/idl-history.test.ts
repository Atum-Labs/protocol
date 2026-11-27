import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// idl-history/v4/escrow.json is src/generated/escrow.json as of the v4 program, byte for byte.
// It is a snapshot, never refreshed from a build, so a newer program cannot rewrite how v4 decodes.
describe('idl-history/v4', () => {
  it('escrow.json is the frozen v4 IDL', () => {
    const raw = readFileSync(resolve(__dirname, '../idl-history/v4/escrow.json'));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(
      'a8c1cc3d00bd4400a4446198bb3cb76cadb725d39db7d27e147f27c1ab541ccf',
    );
  });
});

// idl-history/v5/escrow.json is the v5 escrow IDL (escrow-text-v1), which consumers pick for a v5
// escrow so a later source change can't rewrite how live v5 instructions are built. Until v5 deploys
// it also equals src/generated: a source change then updates both deliberately. Once v5 is deployed,
// a change to its interface is a new program and a new version, and this snapshot stays.
describe('idl-history/v5', () => {
  const raw = readFileSync(resolve(__dirname, '../idl-history/v5/escrow.json'));

  it('escrow.json is the frozen v5 IDL', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(
      '33319cb797036d9e38b06403212a9fc11800ed4462241b2d5930f2f87c49e17d',
    );
  });

  it('equals the current source IDL until v5 deploys', () => {
    expect(raw.equals(readFileSync(resolve(__dirname, 'generated/escrow.json')))).toBe(true);
  });
});
