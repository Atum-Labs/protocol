import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stampEntryHeaders } from '../src/stamp.mjs';
import { generateNotices } from '../src/notices.mjs';
import { checkEntryHeaders } from '../src/check.mjs';
import { entriesForPackage, MARKER } from '../src/entries.mjs';
import { makePackage, makePnpmStore, cleanupAll, unstamped, inlinedRef } from './helpers.mjs';

afterAll(cleanupAll);

const silent = () => {};

describe('stampEntryHeaders', () => {
  it('stamps every manifest-derived entry and leaves chunks alone', () => {
    const { root, distDir } = makePackage({
      manifest: { main: 'dist/index.js', bin: { tool: './dist/cli/tool.js' } },
      dist: { 'index.js': unstamped(), 'cli/tool.js': unstamped(), 'chunk-A.js': unstamped() },
    });
    stampEntryHeaders({ pkgRoot: root, log: silent });

    expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain(MARKER);
    expect(readFileSync(join(distDir, 'cli/tool.js'), 'utf8')).toContain(MARKER);
    expect(readFileSync(join(distDir, 'chunk-A.js'), 'utf8')).not.toContain(MARKER);
  });

  it('keeps a shebang on line 1 and puts the header directly after it', () => {
    const { root, distDir } = makePackage({
      manifest: { main: 'dist/index.js', bin: { cli: './dist/cli.js' } },
      dist: { 'index.js': unstamped(), 'cli.js': '#!/usr/bin/env node\nconsole.log(1);\n' },
    });
    stampEntryHeaders({ pkgRoot: root, log: silent });

    const contents = readFileSync(join(distDir, 'cli.js'), 'utf8');
    const lines = contents.split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env node');
    expect(lines[1]).toBe('/*');
    expect(contents).toContain(MARKER);
  });

  it('is idempotent — a second run does not double-stamp', () => {
    const { root, distDir } = makePackage({ dist: { 'index.js': unstamped() } });
    stampEntryHeaders({ pkgRoot: root, log: silent });
    const once = readFileSync(join(distDir, 'index.js'), 'utf8');
    stampEntryHeaders({ pkgRoot: root, log: silent });
    const twice = readFileSync(join(distDir, 'index.js'), 'utf8');

    expect(twice).toBe(once);
    expect(twice.split(MARKER)).toHaveLength(2); // exactly one occurrence
  });

  it('throws when a manifest-declared entry file is absent from dist', () => {
    const { root } = makePackage({
      manifest: { main: 'dist/index.js', bin: { gone: './dist/cli/gone.js' } },
      dist: { 'index.js': unstamped() },
    });
    expect(() => stampEntryHeaders({ pkgRoot: root, log: silent })).toThrow();
  });

  it('refuses a manifest that advertises no runtime entrypoint', () => {
    const { root } = makePackage({ manifest: { main: undefined, types: 'dist/index.d.ts' } });
    expect(() => stampEntryHeaders({ pkgRoot: root, log: silent })).toThrow(
      /no entry files derived/,
    );
  });

  // Stamp then check is the build sequence; both must agree on the entry set.
  it('produces a tree the header check accepts', () => {
    const { root, distDir } = makePackage({
      manifest: { main: 'dist/index.js', bin: { a: './dist/cli/a.js', b: './dist/cli/b.js' } },
      dist: {
        'index.js': unstamped(),
        'cli/a.js': '#!/usr/bin/env node\n',
        'cli/b.js': unstamped(),
        'chunk-Z.js': unstamped(),
      },
    });
    stampEntryHeaders({ pkgRoot: root, log: silent });
    expect(checkEntryHeaders({ distDir, entries: entriesForPackage(root) })).toEqual([]);
  });
});

describe('generateNotices', () => {
  const NOTE = 'as dependencies of this package (for example nothing)';

  const MIT_TEXT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person';
  const LGPL_TEXT = 'GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3';
  const APACHE_TEXT = 'Apache License\nVersion 2.0, January 2004';

  // The store is passed in explicitly. Resolved from `pkgRoot` instead, a fixture
  // in a temp directory would find nothing and every component would render as
  // UNKNOWN, leaving the license, author, copyleft and Apache paths unexecuted.
  function fixture(packages) {
    const { root } = makePackage({
      dist: { 'index.js': packages.map((p) => inlinedRef(p.name, p.id)).join('') },
    });
    const { store } = makePnpmStore(packages);
    return { root, store };
  }

  const generate = (root, store) =>
    generateNotices({
      pkgRoot: root,
      displayName: '@atumlabs/fixture',
      externalDepsNote: NOTE,
      pnpmStore: store,
      log: silent,
    });

  it('resolves each component version, license and author from the store', () => {
    const { root, store } = fixture([
      {
        name: 'axios',
        id: 'axios@1.13.2',
        version: '1.13.2',
        license: 'MIT',
        licenseText: MIT_TEXT,
        author: 'Matt Zabriskie',
      },
    ]);
    const res = generate(root, store);
    const out = readFileSync(res.path, 'utf8');

    expect(res.byLicense).toEqual({ MIT: 1 });
    expect(out).toContain('axios  1.13.2   (MIT)');
    expect(out).toContain('Author: Matt Zabriskie');
    expect(out).toContain('Permission is hereby granted');
  });

  it('renders the configured header text and package name', () => {
    const { root, store } = fixture([{ name: 'axios', id: 'axios@1.13.2', licenseText: MIT_TEXT }]);
    const out = readFileSync(generate(root, store).path, 'utf8');

    expect(out).toContain('THIRD-PARTY SOFTWARE NOTICES AND INFORMATION');
    expect(out).toContain('@atumlabs/fixture');
    expect(out).toContain(NOTE);
  });

  // A notices file is mostly verbatim MIT text, which reads as an open-source license
  // unless the header says otherwise. Each clause is asserted separately so a reword
  // that quietly drops one fails here rather than at legal review. Matched against
  // whitespace-collapsed output, so re-wrapping the paragraph is not a test failure.
  it('states that the package is Apache-2.0 and that these notices are not its license', () => {
    const { root, store } = fixture([{ name: 'axios', id: 'axios@1.13.2', licenseText: MIT_TEXT }]);
    const prose = readFileSync(generate(root, store).path, 'utf8').replace(/\s+/g, ' ');

    expect(prose).toContain('@atumlabs/fixture is licensed under the Apache License, Version 2.0');
    expect(prose).toContain('as stated in the package-root LICENSE file');
    expect(prose).toContain('THIS file is not that license');
    expect(prose).toContain('apply only to those third-party components');
    expect(prose).toContain('do not modify the Apache-2.0 license governing this package');
  });

  it('counts components and agrees singular with plural', () => {
    const one = fixture([{ name: 'axios', id: 'axios@1.13.2', licenseText: MIT_TEXT }]);
    expect(readFileSync(generate(one.root, one.store).path, 'utf8')).toContain(
      'LICENSE SUMMARY (1 component)',
    );

    const two = fixture([
      { name: 'axios', id: 'axios@1.13.2', licenseText: MIT_TEXT },
      { name: 'bs58', id: 'bs58@6.0.0', licenseText: MIT_TEXT },
    ]);
    expect(readFileSync(generate(two.root, two.store).path, 'utf8')).toContain(
      'LICENSE SUMMARY (2 components)',
    );
  });

  // A copyleft component statically bundled into an Apache-2.0 package is a
  // licensing conflict, so it has to be impossible to miss in the generated file.
  it('raises an attention block for a copyleft component', () => {
    const { root, store } = fixture([
      {
        name: 'rpc-websockets',
        id: 'rpc-websockets@7.0.0',
        version: '7.0.0',
        license: 'LGPL-3.0',
        licenseText: LGPL_TEXT,
      },
    ]);
    const out = readFileSync(generate(root, store).path, 'utf8');

    expect(out).toContain('!! ATTENTION — COPYLEFT COMPONENT(S), review before distribution:');
    expect(out).toContain('rpc-websockets 7.0.0 (LGPL-3.0)');
    expect(out).toContain('Do NOT publish until reviewed.');
  });

  it('raises no attention block when every component is permissive', () => {
    const { root, store } = fixture([{ name: 'axios', id: 'axios@1.13.2', licenseText: MIT_TEXT }]);
    expect(readFileSync(generate(root, store).path, 'utf8')).not.toContain('ATTENTION');
  });

  it('reminds the reader to retain the NOTICE text for Apache components', () => {
    const { root, store } = fixture([
      { name: 'long', id: 'long@5.2.3', license: 'Apache-2.0', licenseText: APACHE_TEXT },
    ]);
    const out = readFileSync(generate(root, store).path, 'utf8');
    expect(out).toContain('Apache-2.0 component(s): long');
    expect(out).toContain('retain the NOTICE text where provided');
  });

  // A package that declares no license still has to be attributed, with its terms
  // identified from the license text rather than silently reported as unknown.
  it('identifies a license from its text when the manifest declares none', () => {
    const { root } = makePackage({ dist: { 'index.js': inlinedRef('mystery', 'mystery@1.0.0') } });
    const { store } = makePnpmStore([
      { name: 'mystery', id: 'mystery@1.0.0', license: '', licenseText: MIT_TEXT },
    ]);
    expect(generate(root, store).byLicense).toEqual({ MIT: 1 });
  });

  it('marks a component UNKNOWN and says so when nothing can be resolved', () => {
    const { root } = makePackage({ dist: { 'index.js': inlinedRef('ghost', 'ghost@9.9.9') } });
    const { store } = makePnpmStore([]);
    const res = generate(root, store);

    expect(res.byLicense).toEqual({ UNKNOWN: 1 });
    expect(readFileSync(res.path, 'utf8')).toContain(
      'No license file is distributed inside this package',
    );
  });

  it('is reproducible — regenerating twice yields identical bytes', () => {
    const { root, store } = fixture([
      { name: 'axios', id: 'axios@1.13.2', licenseText: MIT_TEXT },
      { name: 'bs58', id: 'bs58@6.0.0', licenseText: MIT_TEXT },
    ]);
    const first = readFileSync(generate(root, store).path, 'utf8');
    const second = readFileSync(generate(root, store).path, 'utf8');
    expect(second).toBe(first);
  });

  it('lists packages alphabetically so the diff is stable across builds', () => {
    const { root, store } = fixture([
      { name: 'zod', id: 'zod@3.25.0', licenseText: MIT_TEXT },
      { name: 'axios', id: 'axios@1.13.2', licenseText: MIT_TEXT },
      { name: 'bs58', id: 'bs58@6.0.0', licenseText: MIT_TEXT },
    ]);
    const out = readFileSync(generate(root, store).path, 'utf8');
    const order = ['axios', 'bs58', 'zod'].map((n) => out.indexOf(`\n${n}  `));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('produces attribution that the completeness check accepts', () => {
    const { root, store } = fixture([
      { name: 'axios', id: 'axios@1.13.2', licenseText: MIT_TEXT },
      { name: 'bs58', id: 'bs58@6.0.0', licenseText: MIT_TEXT },
    ]);
    const notices = readFileSync(generate(root, store).path, 'utf8');
    // The completeness check anchors each package name at the start of a line.
    for (const name of ['axios', 'bs58']) {
      expect(new RegExp('^' + name + '\\s', 'm').test(notices)).toBe(true);
    }
  });
});
