import { describe, it, expect } from 'vitest';
import { depositRequestHashVersionsFromDefaults } from './index';
import { expectConfigError, thrownBy } from './test-support';

describe('depositRequestHashVersionsFromDefaults', () => {
  const NETWORK = 'eip155:84532';

  it.each([
    ['nothing published', {}, undefined],
    ['version 1', { depositRequestHashVersion: 1 }, undefined],
    ['version 2, from a gateway that predates the list', { depositRequestHashVersion: 2 }, [1, 2]],
    ['[1]', { depositRequestHashVersion: 2, depositRequestHashVersions: [1] }, undefined],
    ['[1, 2]', { depositRequestHashVersion: 2, depositRequestHashVersions: [1, 2] }, [1, 2]],
    [
      '[2], once v1 is retired',
      { depositRequestHashVersion: 2, depositRequestHashVersions: [2] },
      [2],
    ],
  ] as const)('lists %s as %j', (_name, defaults, versions) => {
    expect(depositRequestHashVersionsFromDefaults(NETWORK, defaults)).toEqual(versions);
  });

  // Both refusals come out as INVALID_CONFIG, so a caller handles a bad gateway answer one way.
  it.each([
    ['names no version this build signs', [3], /accepts none this build signs/],
    ['is not a list of versions', [], /must be a non-empty array of positive integers/],
  ] as const)('refuses a chain whose list %s', (_name, list, message) => {
    const err = thrownBy(() =>
      depositRequestHashVersionsFromDefaults(NETWORK, { depositRequestHashVersions: list }),
    );
    expect(expectConfigError(err, 'INVALID_CONFIG', NETWORK).message).toMatch(message);
  });
});
