/**
 * Second pin for src/abi.ts: the compiled contract spec. Runs only when a wasm and the `stellar`
 * CLI are both present (so CI without a build passes, and a machine with one checks the real
 * artefact). abi.test.ts, which reads the Rust source, always runs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ESCROW_FUNCTIONS, PROXY_FUNCTIONS, ROLES, STRUCTS, type Signature } from './abi.js';

const here = dirname(fileURLToPath(import.meta.url));
const release = resolve(here, '../../target/wasm32v1-none/release');

type SpecType =
  string | { bytes_n: { n: number } } | { udt: { name: string } } | Record<string, unknown>;
interface Entry {
  function_v0?: { name: string; inputs: { name: string; type: SpecType }[] };
  udt_struct_v0?: { name: string; fields: { name: string; type: SpecType }[] };
  udt_union_v0?: { name: string; cases: Record<string, { name: string }>[] };
}

function rustType(t: SpecType): string {
  if (typeof t === 'string') return t === 'string' ? 'String' : t === 'address' ? 'Address' : t;
  if ('bytes_n' in t) return `BytesN<${(t.bytes_n as { n: number }).n}>`;
  if ('udt' in t) return (t.udt as { name: string }).name;
  throw new Error(`unmapped spec type ${JSON.stringify(t)}`);
}

function spec(wasm: string): Entry[] | undefined {
  if (!existsSync(wasm)) return undefined;
  try {
    const out = execFileSync(
      'stellar',
      ['contract', 'info', 'interface', '--wasm', wasm, '--output', 'json'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return JSON.parse(out) as Entry[];
  } catch {
    return undefined;
  }
}

const pairs = (s: Signature) => s.map(([n, t]) => [n, t]);

describe('abi matches the compiled contract spec (skipped without a wasm + stellar CLI)', () => {
  const escrow = spec(resolve(release, 'escrow.wasm'));
  const proxy = spec(resolve(release, 'fulfillment_proxy.wasm'));
  const fns = (entries: Entry[]) =>
    Object.fromEntries(
      entries.flatMap((e) =>
        e.function_v0
          ? [[e.function_v0.name, e.function_v0.inputs.map((i) => [i.name, rustType(i.type)])]]
          : [],
      ),
    );

  it.skipIf(escrow === undefined)('escrow functions', () => {
    const f = fns(escrow as Entry[]);
    for (const [name, sig] of Object.entries(ESCROW_FUNCTIONS)) {
      expect(f[name], `wasm has no ${name}`).toBeDefined();
      expect(pairs(sig)).toEqual(f[name]);
    }
  });

  it.skipIf(escrow === undefined)('structs and Role', () => {
    const entries = escrow as Entry[];
    for (const [name, fields] of Object.entries(STRUCTS)) {
      const s = entries.find((e) => e.udt_struct_v0?.name === name)?.udt_struct_v0;
      expect(s, `wasm has no struct ${name}`).toBeDefined();
      // The compiled spec lists struct fields sorted by name; the Rust source keeps declaration order
      const byName = (x: unknown[][]) =>
        [...x].sort((l, r) => String(l[0]).localeCompare(String(r[0])));
      expect(byName(pairs(fields))).toEqual(
        byName(s?.fields.map((x) => [x.name, rustType(x.type)]) ?? []),
      );
    }
    const role = entries.find((e) => e.udt_union_v0?.name === 'Role')?.udt_union_v0;
    expect(role?.cases.map((c) => Object.values(c)[0]?.name)).toEqual([...ROLES]);
  });

  it.skipIf(proxy === undefined)('proxy functions', () => {
    const f = fns(proxy as Entry[]);
    for (const [name, sig] of Object.entries(PROXY_FUNCTIONS)) {
      expect(f[name], `wasm has no ${name}`).toBeDefined();
      expect(pairs(sig)).toEqual(f[name]);
    }
  });
});
