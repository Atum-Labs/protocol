import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { checkEntryHeaders } from '../src/check.mjs';
import { entriesForPackage } from '../src/entries.mjs';
import { makePackage, cleanupAll, stamped, unstamped, writeFile } from './helpers.mjs';

afterAll(cleanupAll);

// Both directions are enforced: an entry point must carry the notice, and a
// dependency chunk must not.
describe('checkEntryHeaders', () => {
  it('passes when every entry is stamped and every chunk is not', () => {
    const { distDir } = makePackage({
      dist: {
        'index.js': stamped(),
        'cli/send-payment.js': stamped('#!/usr/bin/env node\n'),
        'chunk-ABC123.js': unstamped('// third-party bundle\n'),
      },
    });
    expect(checkEntryHeaders({ distDir, entries: ['index.js', 'cli/send-payment.js'] })).toEqual(
      [],
    );
  });

  it('fails when an entry is missing the header', () => {
    const { distDir } = makePackage({
      dist: { 'index.js': stamped(), 'cli/new-tool.js': unstamped() },
    });
    const failures = checkEntryHeaders({ distDir, entries: ['index.js', 'cli/new-tool.js'] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('missing the Apache-2.0 header');
    expect(failures[0]).toContain('cli/new-tool.js');
  });

  it('fails when a dependency chunk carries the header', () => {
    const { distDir } = makePackage({
      dist: { 'index.js': stamped(), 'chunk-XYZ.js': stamped('// bundled axios\n') },
    });
    const failures = checkEntryHeaders({ distDir, entries: ['index.js'] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('non-entry file carries the Apache-2.0 header');
    expect(failures[0]).toContain('chunk-XYZ.js');
  });

  it('fails when a manifest-declared entry is absent from dist', () => {
    const { distDir } = makePackage({ dist: { 'index.js': stamped() } });
    const failures = checkEntryHeaders({ distDir, entries: ['index.js', 'cli/renamed.js'] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('missing from dist');
  });

  it('reports every offending file, not just the first', () => {
    const { distDir } = makePackage({
      dist: {
        'index.js': unstamped(),
        'client.js': unstamped(),
        'chunk-A.js': stamped(),
      },
    });
    const failures = checkEntryHeaders({ distDir, entries: ['index.js', 'client.js'] });
    expect(failures).toHaveLength(3);
  });

  // Adding a bin without stamping it must fail the check, caught through the
  // manifest rather than a hand-maintained list.
  it('catches an added-but-unstamped bin end to end, through manifest derivation', () => {
    const { root, distDir } = makePackage({
      manifest: { main: 'dist/index.js', bin: { existing: './dist/cli/existing.js' } },
      dist: { 'index.js': stamped(), 'cli/existing.js': stamped() },
    });
    expect(checkEntryHeaders({ distDir, entries: entriesForPackage(root) })).toEqual([]);

    // A fifth CLI gets added to the manifest and built, but not stamped.
    writeFile(
      root,
      'package.json',
      JSON.stringify(
        {
          name: '@atum-labs/fixture',
          version: '1.0.0',
          main: 'dist/index.js',
          license: 'Apache-2.0',
          bin: { existing: './dist/cli/existing.js', added: './dist/cli/added.js' },
        },
        null,
        2,
      ),
    );
    writeFile(root, join('dist', 'cli/added.js'), unstamped());

    const failures = checkEntryHeaders({ distDir, entries: entriesForPackage(root) });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('cli/added.js');
  });
});
