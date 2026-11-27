import { describe, expect, it } from 'vitest';
import {
  MAINNET_ALLOWLIST_ENV,
  NETWORKS,
  NetworkGuardError,
  assertMainnetCustody,
  MIN_MAINNET_ADMIN_DELAY_SECS,
  assertMainnetKeySource,
  assertNetworkAllowed,
  assertRpcMatchesNetwork,
  resolveNetwork,
} from './networks.js';

const base = { iKnowThisIsMainnet: false, env: {} as Record<string, string | undefined> };

describe('network guard', () => {
  it('lets testnet and local through with no flags', () => {
    expect(() => assertNetworkAllowed({ ...base, network: NETWORKS.testnet })).not.toThrow();
    expect(() => assertNetworkAllowed({ ...base, network: NETWORKS.local })).not.toThrow();
  });

  it('refuses mainnet with no flag', () => {
    expect(() => assertNetworkAllowed({ ...base, network: NETWORKS.mainnet })).toThrow(
      NetworkGuardError,
    );
  });

  it('refuses mainnet with the flag but no allowlist', () => {
    expect(() =>
      assertNetworkAllowed({
        ...base,
        network: NETWORKS.mainnet,
        iKnowThisIsMainnet: true,
        environment: 'production-mainnet',
      }),
    ).toThrow(/ATUM_STELLAR_MAINNET_ALLOWLIST/);
  });

  it('refuses mainnet with the allowlist but no flag', () => {
    expect(() =>
      assertNetworkAllowed({
        ...base,
        network: NETWORKS.mainnet,
        environment: 'production-mainnet',
        env: { [MAINNET_ALLOWLIST_ENV]: 'production-mainnet' },
      }),
    ).toThrow(NetworkGuardError);
  });

  it('refuses an environment that is not a mainnet environment, even if allowlisted', () => {
    expect(() =>
      assertNetworkAllowed({
        ...base,
        network: NETWORKS.mainnet,
        iKnowThisIsMainnet: true,
        environment: 'staging-testnet',
        env: { [MAINNET_ALLOWLIST_ENV]: 'staging-testnet' },
      }),
    ).toThrow(/--environment must be one of/);
  });

  it('refuses when the allowlist names a different environment', () => {
    expect(() =>
      assertNetworkAllowed({
        ...base,
        network: NETWORKS.mainnet,
        iKnowThisIsMainnet: true,
        environment: 'production-mainnet',
        env: { [MAINNET_ALLOWLIST_ENV]: 'staging-mainnet' },
      }),
    ).toThrow(/does not list/);
  });

  it('passes only with flag + environment + allowlist', () => {
    expect(() =>
      assertNetworkAllowed({
        ...base,
        network: NETWORKS.mainnet,
        iKnowThisIsMainnet: true,
        environment: 'staging-mainnet',
        env: { [MAINNET_ALLOWLIST_ENV]: ' production-mainnet , staging-mainnet' },
      }),
    ).not.toThrow();
  });

  it('rejects the mainnet flag on a non-mainnet network', () => {
    expect(() =>
      assertNetworkAllowed({ ...base, network: NETWORKS.testnet, iKnowThisIsMainnet: true }),
    ).toThrow(/contradiction/);
  });

  it('rejects unknown and missing network names', () => {
    expect(() => resolveNetwork('pubnet')).toThrow(/unknown network/);
    expect(() => resolveNetwork(undefined)).toThrow(/required/);
  });

  it('detects an RPC serving a different network than the label', () => {
    expect(() => assertRpcMatchesNetwork(NETWORKS.testnet, NETWORKS.mainnet.passphrase)).toThrow(
      /expects/,
    );
    expect(() =>
      assertRpcMatchesNetwork(NETWORKS.testnet, NETWORKS.testnet.passphrase),
    ).not.toThrow();
  });

  it('local defaults to the quickstart container and its passphrase', () => {
    expect(NETWORKS.local).toMatchObject({
      defaultRpcUrl: 'http://localhost:8000/rpc',
      friendbotUrl: 'http://localhost:8000/friendbot',
      passphrase: 'Standalone Network ; February 2017',
      mainnet: false,
    });
    expect(NETWORKS.local.caip2).toBe('stellar:standalone');
  });

  it('local still refuses an RPC that reports another passphrase', () => {
    expect(() => assertRpcMatchesNetwork(NETWORKS.local, NETWORKS.mainnet.passphrase)).toThrow(
      /expects/,
    );
    expect(() => assertRpcMatchesNetwork(NETWORKS.local, NETWORKS.testnet.passphrase)).toThrow(
      /expects/,
    );
  });

  it('has no default public RPC for mainnet', () => {
    expect(NETWORKS.mainnet.defaultRpcUrl).toBeUndefined();
  });
});

describe('mainnet key source', () => {
  it('refuses an environment-held secret, accepts a keychain item or a public key', () => {
    expect(() => assertMainnetKeySource(NETWORKS.mainnet, {})).toThrow(NetworkGuardError);
    expect(() => assertMainnetKeySource(NETWORKS.mainnet, { keychainItem: 'k' })).not.toThrow();
    expect(() => assertMainnetKeySource(NETWORKS.mainnet, { deployerAddress: 'G' })).not.toThrow();
  });

  it('leaves testnet and local alone', () => {
    expect(() => assertMainnetKeySource(NETWORKS.testnet, {})).not.toThrow();
    expect(() => assertMainnetKeySource(NETWORKS.local, {})).not.toThrow();
  });
});

describe('mainnet custody', () => {
  const roles = { admin: 'A', pauser: 'B', treasurer: 'C' };
  const ok = {
    network: NETWORKS.mainnet,
    deployer: 'D',
    roles,
    adminDelaySecs: MIN_MAINNET_ADMIN_DELAY_SECS,
    proxyDelaySecs: MIN_MAINNET_ADMIN_DELAY_SECS,
  };

  it('accepts roles elsewhere and a delay at the floor', () => {
    expect(() => assertMainnetCustody(ok)).not.toThrow();
  });

  it('refuses every role that equals the deployer, listing them', () => {
    expect(() =>
      assertMainnetCustody({ ...ok, roles: { admin: 'D', pauser: 'B', treasurer: 'D' } }),
    ).toThrow(/admin, treasurer would be held by the deployer/);
  });

  it('refuses the default delay on either contract, and 0', () => {
    expect(() => assertMainnetCustody({ ...ok, adminDelaySecs: 1 })).toThrow(/--admin-delay-secs/);
    expect(() => assertMainnetCustody({ ...ok, proxyDelaySecs: 0 })).toThrow(/--proxy-delay-secs/);
  });

  it('refuses a delay of a few seconds, which is above the default but no guard', () => {
    expect(() => assertMainnetCustody({ ...ok, adminDelaySecs: 2 })).toThrow(/--admin-delay-secs/);
    expect(() => assertMainnetCustody({ ...ok, proxyDelaySecs: 2 })).toThrow(/--proxy-delay-secs/);
  });

  it('refuses one second below the floor and accepts the floor and above', () => {
    const below = MIN_MAINNET_ADMIN_DELAY_SECS - 1;
    expect(() => assertMainnetCustody({ ...ok, adminDelaySecs: below })).toThrow(
      /below the mainnet minimum of 86400 seconds/,
    );
    expect(() => assertMainnetCustody({ ...ok, proxyDelaySecs: below })).toThrow(
      /below the mainnet minimum of 86400 seconds/,
    );
    expect(() =>
      assertMainnetCustody({ ...ok, adminDelaySecs: 5 * MIN_MAINNET_ADMIN_DELAY_SECS }),
    ).not.toThrow();
  });

  it('does not apply off mainnet', () => {
    expect(() =>
      assertMainnetCustody({
        ...ok,
        network: NETWORKS.testnet,
        roles: { admin: 'D' },
        adminDelaySecs: 1,
      }),
    ).not.toThrow();
  });
});
