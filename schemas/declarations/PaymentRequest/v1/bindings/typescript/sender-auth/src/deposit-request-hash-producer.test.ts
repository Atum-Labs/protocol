import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  depositRequestHashShadowOf,
  depositRequestHashVersionsOf,
  publishedDepositRequestHashVersions,
} from './deposit-request-hash-producer.js';
import * as index from './index.js';

const vectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../conformance/commitment-v2-vectors.json'), 'utf8'),
) as {
  requests: Array<{
    name: string;
    request: string;
    result: { expectedDepositRequestHashV2?: string };
  }>;
};
const row = (name: string) => vectors.requests.find((r) => r.name === name)!;

describe('publishedDepositRequestHashVersions', () => {
  // [1] is what payers read when nothing is published, so a payer that predates the field still pays.
  it.each([
    ['nothing published', {}, undefined],
    ['version 1', { depositRequestHashVersion: 1 }, undefined],
    ['version 2, from a gateway that predates the list', { depositRequestHashVersion: 2 }, [1, 2]],
    ['[1]', { depositRequestHashVersion: 2, depositRequestHashVersions: [1] }, undefined],
    ['[1, 2]', { depositRequestHashVersions: [1, 2] }, [1, 2]],
    ['[2]', { depositRequestHashVersions: [2] }, [2]],
    [
      '[2, 3], without the version this build does not know',
      { depositRequestHashVersions: [2, 3] },
      [2],
    ],
  ] as const)('publishes %s as %j', (_name, defaults, published) => {
    expect(publishedDepositRequestHashVersions(defaults)).toEqual(published);
  });

  it.each([
    ['names no version this build signs', [3], /accepts none this build signs, \[3\]/],
    ['is empty', [], /must be a non-empty array of positive integers/],
  ] as const)('refuses a list that %s', (_name, list, message) => {
    expect(() => publishedDepositRequestHashVersions({ depositRequestHashVersions: list })).toThrow(
      message,
    );
  });
});

describe('depositRequestHashVersionsOf', () => {
  it.each([
    ['nothing published', {}, [1]],
    ['version 1', { depositRequestHashVersion: 1 }, [1]],
    ['version 2, from a gateway that predates the list', { depositRequestHashVersion: 2 }, [1, 2]],
    [
      'nulls, from untyped JSON',
      { depositRequestHashVersion: null, depositRequestHashVersions: null },
      [1],
    ],
    ['[1]', { depositRequestHashVersion: 2, depositRequestHashVersions: [1] }, [1]],
    ['[1, 2]', { depositRequestHashVersion: 2, depositRequestHashVersions: [2, 1] }, [1, 2]],
    [
      '[2], once v1 is retired',
      { depositRequestHashVersion: 2, depositRequestHashVersions: [2] },
      [2],
    ],
    ['a version this build does not know, ignored', { depositRequestHashVersions: [2, 3] }, [2]],
    ['only versions this build does not know', { depositRequestHashVersions: [3] }, []],
  ] as const)('reads %s', (_name, defaults, versions) => {
    expect(depositRequestHashVersionsOf(defaults)).toEqual(versions);
  });

  it.each([[[]], [['2']], [[0]], [[1.5]], ['2']])('refuses a malformed list: %j', (published) => {
    expect(() =>
      depositRequestHashVersionsOf({
        depositRequestHashVersions: published as unknown as number[],
      }),
    ).toThrow(/depositRequestHashVersions must be a non-empty array of positive integers/);
  });
});

describe('depositRequestHashShadowOf', () => {
  // The v2 the commitment check derives for the same signed body, so the shadow is what the
  // gateway reads, sender_auth included.
  it.each(['strict-evm-v1/audit', 'strict-solana-v1/audit', 'strict-tron-v1/audit'])(
    'reads the v2 the commitment check derives for %s',
    (name) => {
      const c = row(name);
      expect(c.result.expectedDepositRequestHashV2).toMatch(/^0x[0-9a-f]{64}$/);
      expect(depositRequestHashShadowOf(c.request, 'sdk-ts')).toEqual({
        producer: 'sdk-ts',
        depositRequestHashV2: c.result.expectedDepositRequestHashV2,
      });
    },
  );

  it('sends no v2 for a body the strict reader refuses', () => {
    const body = JSON.parse(row('strict-evm-v1/audit').request);
    body.unknown_member = 1;
    expect(depositRequestHashShadowOf(JSON.stringify(body), 'mppx')).toEqual({ producer: 'mppx' });
  });

  it('is exported from the package index', () => {
    expect(index.depositRequestHashShadowOf).toBe(depositRequestHashShadowOf);
    expect(index.depositRequestHashVersionsOf).toBe(depositRequestHashVersionsOf);
    expect(index.publishedDepositRequestHashVersions).toBe(publishedDepositRequestHashVersions);
  });
});
