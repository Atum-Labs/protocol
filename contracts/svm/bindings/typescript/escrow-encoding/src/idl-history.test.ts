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
