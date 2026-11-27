import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from './index';
import { SVM_MESSAGES, loadWithOverlay } from './overlay';

const registryDir = resolve(__dirname, '../..');

function writeOverlay(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-overlay-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const localnetV4 = JSON.stringify({
  chain: 'solana:localnet',
  name: 'Solana Localnet',
  mainnet: false,
  versions: [
    {
      id: 'v4',
      source: 's',
      escrow: 'CFKUVjrHDt1cXXzHMTCbHj5NxFZjtCqxxTc2k61gry7R',
      fulfillmentProxies: ['FLNuCtE9w1qsyr2wjDSf1BCy7KCR6pvnVYht2KaY2dAn'],
      signature: { svmDomainVersion: 5 },
    },
  ],
});

describe('loadWithOverlay', () => {
  it('adds a chain and leaves the bundled ones as they are', () => {
    const r = loadWithOverlay(
      writeOverlay({ 'solana_localnet.json': localnetV4, 'README.md': 'not a chain file' }),
    );
    expect(
      r.versionOfEscrow('solana:localnet', 'CFKUVjrHDt1cXXzHMTCbHj5NxFZjtCqxxTc2k61gry7R')?.id,
    ).toBe('v4');
    expect(r.chain('SOLANA:LOCALNET')).toBeDefined();
    const bundled = load();
    expect(bundled.chain('solana:localnet')).toBeUndefined();
    for (const c of bundled.chains()) expect(r.chain(c)).toEqual(bundled.chain(c));
    expect(r.chains()).toHaveLength(bundled.chains().length + 1);
  });

  it('loads the bundled registry for an empty dir', () => {
    expect(loadWithOverlay('').chains()).toEqual(load().chains());
  });

  it.each([
    [
      'same chain id',
      'solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1.json',
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    ],
    [
      'chain id other case',
      'solana_etwtrabzayq6imfeykouru166vu2xqa1.json',
      'solana:etwtrabzayq6imfeykouru166vu2xqa1',
    ],
  ])('refuses an embedded chain (%s)', (_, file, chain) => {
    const body = localnetV4.replace('"solana:localnet"', JSON.stringify(chain));
    expect(() => loadWithOverlay(writeOverlay({ [file]: body }))).toThrow('may only add chains');
  });

  it.each([
    [
      'file name differs from chain',
      { 'solana_other.json': localnetV4 },
      'want file solana_localnet.json',
    ],
    [
      'unknown field',
      {
        'solana_localnet.json': localnetV4.replace('"mainnet":false', '"mainnet":false,"extra":1'),
      },
      'unknown field',
    ],
    [
      'no versions',
      {
        'solana_localnet.json':
          '{"chain":"solana:localnet","name":"n","mainnet":false,"versions":[]}',
      },
      'at least one version',
    ],
    [
      'EVM domain on Solana',
      {
        'solana_localnet.json': localnetV4.replace(
          '{"svmDomainVersion":5}',
          '{"eip712Name":"Escrow","eip712Version":"3"}',
        ),
      },
      'needs svmDomainVersion',
    ],
    [
      'unknown message scheme',
      {
        'solana_localnet.json': localnetV4.replace(
          '{"svmDomainVersion":5}',
          '{"svmDomainVersion":5,"svmMessage":"no-such-scheme"}',
        ),
      },
      'not a known message scheme',
    ],
    [
      'broken JSON',
      { 'solana_localnet.json': localnetV4.slice(0, 20) },
      'registry solana_localnet.json',
    ],
  ])('validates files (%s)', (_, files, want) => {
    expect(() => loadWithOverlay(writeOverlay(files as Record<string, string>))).toThrow(want);
  });

  it('refuses a directory that does not exist', () => {
    expect(() => loadWithOverlay(join(tmpdir(), 'registry-overlay-missing-dir'))).toThrow();
  });

  it('loads overlays/localnet with the docker localnet program ids', () => {
    const r = loadWithOverlay(resolve(registryDir, 'overlays/localnet'));
    const sh = readFileSync(resolve(registryDir, '../svm/docker/accounts.sh'), 'utf8');
    const ids = Object.fromEntries(
      [...sh.matchAll(/^(LOCAL_\w+_PROGRAM_ID)="(\w+)"/gm)].map((m) => [m[1], m[2]]),
    );
    const c = r.chain('solana:localnet')!;
    expect(
      c.versions.map((v) => [v.id, v.escrow, v.fulfillmentProxies, v.signature.svmMessage ?? '']),
    ).toEqual([
      ['v4', ids.LOCAL_ESCROW_PROGRAM_ID, [ids.LOCAL_FULFILLMENT_PROXY_PROGRAM_ID], ''],
      [
        'v5',
        ids.LOCAL_ESCROW_V5_PROGRAM_ID,
        [ids.LOCAL_FULFILLMENT_PROXY_PROGRAM_ID],
        'escrow-text-v1',
      ],
    ]);
  });
});

// SVM_MESSAGES is exactly the svm escrow encoding's MESSAGE_SCHEMES, read from its source so the
// registry stays dependency free.
it('accepts exactly the svm escrow encoding message schemes', () => {
  const src = resolve(__dirname, '../../../svm/bindings/typescript/escrow-encoding/src/scheme.ts');
  const text = readFileSync(src, 'utf8');
  const consts = new Map<string, string>();
  for (const m of text.matchAll(/^export const (SCHEME_\w+): MessageScheme = '([^']*)';$/gm)) {
    consts.set(m[1], m[2]);
  }
  const list = /export const MESSAGE_SCHEMES: readonly MessageScheme\[\] = \[([^\]]*)\]/.exec(text);
  expect(list, `${src}: MESSAGE_SCHEMES not found`).not.toBeNull();
  const want = list![1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .map((name) => {
      expect(consts.has(name), `MESSAGE_SCHEMES names ${name}, not a scheme constant`).toBe(true);
      return consts.get(name)!;
    });
  expect(want.length).toBeGreaterThan(0);
  expect([...SVM_MESSAGES].sort()).toEqual([...new Set(want)].sort());
});
