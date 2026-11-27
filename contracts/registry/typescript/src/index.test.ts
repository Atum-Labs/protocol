import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAIN_FILES, type Chain, type Signature, load, parseEnvList } from './index';

const registryDir = resolve(__dirname, '../..');

// domainKey mirrors registry_test.go: "svm:<n>" for the raw hash scheme, "svm:<n>/<scheme>" otherwise,
// "stellar:<n>" on Stellar.
function domainKey(s: Signature): string {
  if (s.stellarDomainVersion) return `stellar:${s.stellarDomainVersion}`;
  if (s.svmDomainVersion) {
    return `svm:${s.svmDomainVersion}` + (s.svmMessage ? `/${s.svmMessage}` : '');
  }
  return `${s.eip712Name}:${s.eip712Version}`;
}

describe('bundled chain files', () => {
  it('are exactly the files in chains/', () => {
    const onDisk = readdirSync(resolve(registryDir, 'chains')).filter((f) => f.endsWith('.json')).sort();
    expect(Object.keys(CHAIN_FILES).sort()).toEqual(onDisk);
    for (const f of onDisk) {
      expect(CHAIN_FILES[f]).toEqual(JSON.parse(readFileSync(resolve(registryDir, 'chains', f), 'utf8')));
    }
  });

  it('rebuild published.txt line for line', () => {
    const r = load();
    const rebuilt = r
      .chains()
      .flatMap((c) => r.chain(c)!.versions.map((v) => [c, v.id, v.escrow, domainKey(v.signature)].join(' ')));
    const published = readFileSync(resolve(registryDir, 'published.txt'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(rebuilt.sort()).toEqual(published.sort());
  });
});

describe('domainKey', () => {
  it.each([
    [{ svmDomainVersion: 5 }, 'svm:5'],
    [{ svmDomainVersion: 5, svmMessage: '' }, 'svm:5'],
    [{ svmDomainVersion: 6, svmMessage: 'text' }, 'svm:6/text'],
    [{ stellarDomainVersion: 2 }, 'stellar:2'],
    [{ eip712Name: 'Escrow', eip712Version: '3' }, 'Escrow:3'],
  ])('%o -> %s', (s, want) => {
    expect(domainKey(s)).toBe(want);
  });
});

describe('versionOfEscrow', () => {
  const r = load();
  const tempoV4 = '0x815d450F443466d52D3c1fB7a57D74D463D1E6F0';
  const sol = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const solEscrow = '5BD9UAUCRCg6Chv6CS5k4sBHGd7CciWpng9u7iJxJFjx';
  it.each([
    ['EVM exact', 'eip155:4217', tempoV4, 'v4'],
    ['EVM lower case', 'eip155:4217', tempoV4.toLowerCase(), 'v4'],
    ['EVM second version', 'eip155:4217', '0xedaD6a9846c79A64449603e95F8c77fd5A46881b', 'v5'],
    ['EVM chain id upper case', 'EIP155:4217', tempoV4, 'v4'],
    ['EVM escrow of another chain', 'eip155:42161', '0xedaD6a9846c79A64449603e95F8c77fd5A46881b', undefined],
    ['EVM proxy is not an escrow', 'eip155:4217', '0xA8F40Ed7437BCB6bF264832369e8364b80B06c83', undefined],
    ['Tron exact', 'tron:mainnet', 'TYj48kPL31aMpJfm2LKi96e9hEfVKGmv5Y', 'v4'],
    ['Tron case changed', 'tron:mainnet', 'tyj48kpl31ampjfm2lki96e9hefvkgmv5y', undefined],
    ['Solana exact', sol, solEscrow, 'v4'],
    ['Solana address lower case', sol, solEscrow.toLowerCase(), undefined],
    ['Solana chain id lower case', sol.toLowerCase(), solEscrow, 'v4'],
    ['unknown chain', 'eip155:999999', tempoV4, undefined],
    ['empty chain', '', tempoV4, undefined],
    ['empty address', 'eip155:4217', '', undefined],
  ])('%s', (_name, chain, addr, want) => {
    expect(r.versionOfEscrow(chain, addr)?.id).toBe(want);
  });
});

describe('chain lookup', () => {
  const r = load();
  const sol = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  it.each([
    [sol, sol],
    [sol.toLowerCase(), sol],
    [sol.toUpperCase(), sol],
    ['EIP155:1', 'eip155:1'],
    ['eip155:999999', undefined],
  ])('%s -> %s', (input, want) => {
    expect(r.chain(input)?.chain).toBe(want);
  });

  it('refuses two chains equal but for case', () => {
    const c = (chain: string): Chain => ({ chain, name: 'n', mainnet: true, versions: [] });
    expect(() => load({ 'solana_AbC.json': c('solana:AbC'), 'solana_abc.json': c('solana:abc') })).toThrow('only in case');
  });

  it('refuses a file named for another chain', () => {
    expect(() => load({ 'eip155_2.json': { chain: 'eip155:1', name: 'n', mainnet: true, versions: [] } })).toThrow(
      'want file eip155_1.json',
    );
  });
});

describe('allowed', () => {
  const r = load();
  // The list keeps the registry's mixed case chain ids; services look chains up lower case.
  const list = parseEnvList('eip155:4217=v5,v4;solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp=v4;tron:mainnet=v4');
  it.each([
    ['EVM, list order kept', 'eip155:4217', 'v5,v4'],
    ['EVM, upper case', 'EIP155:4217', 'v5,v4'],
    ['Solana, exact', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'v4'],
    ['Solana, lower case', 'solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp', 'v4'],
    ['Tron, upper case', 'TRON:MAINNET', 'v4'],
    ['registry chain not in the list', 'eip155:1', ''],
    ['chain not in the registry', 'eip155:999999', ''],
  ])('%s', (_name, chain, want) => {
    expect(r.allowed(list, chain).map((v) => v.id).join(',')).toBe(want);
  });
});

describe('parseEnvList', () => {
  it.each([
    ['', {}],
    ['  ', {}],
    ['eip155:4217=v4,v5', { 'eip155:4217': ['v4', 'v5'] }],
    [' eip155:1 = v4 ; tron:mainnet=v4; ', { 'eip155:1': ['v4'], 'tron:mainnet': ['v4'] }],
  ])('%j', (input, want) => {
    expect(Object.fromEntries(parseEnvList(input))).toEqual(want);
  });

  it.each([
    ['eip155:1', 'want chain=id'],
    ['=v4', 'want chain=id'],
    [' =v4', 'want chain=id'],
    ['eip155:1=', 'empty version id'],
    ['eip155:1=v4,,v5', 'empty version id'],
    ['eip155:1=v4,v4', 'listed twice'],
    ['eip155:1=v4;eip155:1=v5', 'listed twice'],
  ])('%j throws', (input, want) => {
    expect(() => parseEnvList(input)).toThrow(want);
  });
});
