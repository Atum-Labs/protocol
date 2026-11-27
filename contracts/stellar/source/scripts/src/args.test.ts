import { StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { UsageError, parseDeployArgs, parseTokenSpec } from './args.js';
import { NetworkGuardError } from './networks.js';

const C = StrKey.encodeContract(Buffer.alloc(32, 9));
const G = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 5));
const wasms = ['--escrow-wasm', 'e.wasm', '--proxy-wasm', 'p.wasm'];

describe('deploy args', () => {
  it('parses a testnet deploy with defaults', () => {
    const a = parseDeployArgs(['deploy', '--network', 'testnet', ...wasms]);
    expect(a).toMatchObject({
      command: 'deploy',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      dryRun: false,
      adminDelaySecs: 1,
      proxyDelaySecs: 1,
      saltTag: 'v1',
      tokens: [],
    });
    expect(a.admin).toBeUndefined(); // resolved to the deployer later
  });

  it('defaults the command to deploy', () => {
    expect(parseDeployArgs(['--network', 'testnet', ...wasms]).command).toBe('deploy');
  });

  it('takes role holders as parameters', () => {
    const a = parseDeployArgs([
      '--network',
      'testnet',
      ...wasms,
      '--admin',
      G,
      '--pauser',
      G,
      '--treasurer',
      G,
      '--token-config',
      G,
      '--proxy-admin',
      G,
      '--proxy-pauser',
      G,
    ]);
    expect(a).toMatchObject({
      admin: G,
      pauser: G,
      treasurer: G,
      tokenConfig: G,
      proxyAdmin: G,
      proxyPauser: G,
    });
  });

  it('rejects a role holder that is not a G address', () => {
    expect(() => parseDeployArgs(['--network', 'testnet', ...wasms, '--admin', C])).toThrow(
      /G\.\.\. account/,
    );
  });

  it('requires both wasm paths to deploy (no build step is assumed)', () => {
    expect(() => parseDeployArgs(['--network', 'testnet', '--escrow-wasm', 'e.wasm'])).toThrow(
      /no build step/,
    );
  });

  it('does not need wasm for extend-ttl', () => {
    expect(parseDeployArgs(['extend-ttl', '--network', 'testnet']).command).toBe('extend-ttl');
  });

  it('refuses a secret on argv', () => {
    expect(() => parseDeployArgs(['--network', 'testnet', ...wasms, '--secret', 'SABC'])).toThrow(
      UsageError,
    );
    expect(() => parseDeployArgs(['--network', 'testnet', ...wasms, '--secret=SABC'])).toThrow(
      UsageError,
    );
  });

  it('requires an explicit RPC for mainnet', () => {
    expect(() => parseDeployArgs(['--network', 'mainnet', ...wasms])).toThrow(
      /--rpc-url is required/,
    );
  });

  it('rejects unknown networks and flags', () => {
    expect(() => parseDeployArgs(['--network', 'futurenet', ...wasms])).toThrow(NetworkGuardError);
    expect(() => parseDeployArgs(['--network', 'testnet', ...wasms, '--friendbot'])).toThrow(
      UsageError,
    );
  });

  it('allows --deployer-address only with --dry-run', () => {
    expect(() =>
      parseDeployArgs(['--network', 'testnet', ...wasms, '--deployer-address', G]),
    ).toThrow(/only valid with --dry-run/);
    expect(
      parseDeployArgs(['--network', 'testnet', ...wasms, '--dry-run', '--deployer-address', G])
        .deployerAddress,
    ).toBe(G);
  });

  it('refuses both key sources', () => {
    expect(() =>
      parseDeployArgs([
        '--network',
        'testnet',
        ...wasms,
        '--secret-env',
        'A',
        '--keychain-item',
        'B',
      ]),
    ).toThrow(/only one/);
  });

  it('collects repeated --token', () => {
    const a = parseDeployArgs([
      '--network',
      'testnet',
      ...wasms,
      '--token',
      `${C}:7:1000000`,
      '--token',
      `${C}:6:0`,
    ]);
    expect(a.tokens).toHaveLength(2);
  });

  it('rejects non-numeric delays', () => {
    expect(() =>
      parseDeployArgs(['--network', 'testnet', ...wasms, '--admin-delay-secs', '-1']),
    ).toThrow(UsageError);
  });
});

describe('token spec', () => {
  it('parses decimals, percentage and optional bounds', () => {
    expect(parseTokenSpec(`${C}:7:1000000:5000000:50000000`)).toEqual({
      contract: C,
      decimals: 7,
      feePercentage6: 1_000_000,
      minFee6: 5_000_000n,
      maxFee6: 50_000_000n,
    });
    expect(parseTokenSpec(`${C}:7:0`)).toMatchObject({ minFee6: 0n, maxFee6: 0n });
  });

  it.each([
    ['not a contract', `${G}:7:1`, /contract id/],
    ['zero decimals', `${C}:0:1`, /decimals must be/],
    ['19 decimals', `${C}:19:1`, /decimals must be/],
    ['over 100 percent', `${C}:7:100000001`, /exceeds/],
    ['min above max', `${C}:7:1:9:3`, /min fee is above max/],
    ['max with zero percentage', `${C}:7:0:0:3`, /non-zero percentage/],
    ['too few parts', `${C}:7`, /expected/],
    ['negative', `${C}:7:-1`, /non-negative/],
    ['u64 overflow', `${C}:7:1:0:18446744073709551616`, /u64/],
  ])('rejects %s', (_n, spec, re) => {
    expect(() => parseTokenSpec(spec)).toThrow(re);
  });
});
