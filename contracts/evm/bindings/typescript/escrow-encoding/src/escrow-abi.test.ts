/**
 * Ties escrow-abi.ts to the compiler-emitted ABI at contracts/evm/source/generated/abi/Escrow.json:
 * every declared fragment must be structurally identical, recursively through nested tuple
 * components (`internalType` is a compiler annotation and is ignored).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ESCROW_V3_ABI_JSON } from './escrow-abi';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_ABI_PATH = resolve(__dirname, '../../../../source/generated/abi/Escrow.json');

interface AbiParam {
  name: string;
  type: string;
  internalType?: string;
  components?: AbiParam[];
}
interface AbiFunction {
  type: string;
  name: string;
  inputs: AbiParam[];
  outputs: AbiParam[];
  stateMutability: string;
}

/** A missing or unreadable ABI throws — the guard fails closed, it never skips. */
const generated = JSON.parse(readFileSync(GENERATED_ABI_PATH, 'utf8')) as AbiFunction[];

/** {name, type, components} only — `internalType` is a compiler annotation. */
function normalizeParam(p: AbiParam): Record<string, unknown> {
  return {
    name: p.name,
    type: p.type,
    ...(p.components ? { components: p.components.map(normalizeParam) } : {}),
  };
}

function normalizeFunction(f: AbiFunction): Record<string, unknown> {
  return {
    name: f.name,
    inputs: f.inputs.map(normalizeParam),
    outputs: (f.outputs ?? []).map(normalizeParam),
    stateMutability: f.stateMutability,
  };
}

function generatedFunction(name: string): AbiFunction {
  const matches = generated.filter((f) => f.type === 'function' && f.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly ONE function named ${name} in ${GENERATED_ABI_PATH}, found ${matches.length}. ` +
        'Zero means the contract renamed or removed it and this fragment is dead; more than one ' +
        'means it is overloaded and the fragment needs its signature, not just its name.',
    );
  }
  return matches[0];
}

describe('ESCROW_V3_ABI_JSON matches the compiler-emitted Escrow ABI', () => {
  const declared = ESCROW_V3_ABI_JSON as unknown as AbiFunction[];

  it('the generated ABI is loaded and non-trivial', () => {
    // Guards against every assertion below passing vacuously over an empty file.
    expect(generated.filter((f) => f.type === 'function').length).toBeGreaterThan(20);
  });

  it.each(declared.map((f) => f.name))('%s is structurally identical to source', (name) => {
    const mine = declared.find((f) => f.name === name)!;
    expect(normalizeFunction(mine)).toEqual(normalizeFunction(generatedFunction(name)));
  });

  it('every declared fragment is a function the contract still has', () => {
    for (const f of declared) {
      expect(f.type).toBe('function');
      expect(() => generatedFunction(f.name)).not.toThrow();
    }
  });

  // The declared subset, asserted so a fragment is added deliberately.
  it('declares the deposit, refund and read subset', () => {
    expect(declared.map((f) => f.name).sort()).toEqual([
      'deposit',
      'getDepositHash',
      'i_permit2',
      'refund',
    ]);
    expect(declared.map((f) => f.name)).not.toContain('release');
  });
});
