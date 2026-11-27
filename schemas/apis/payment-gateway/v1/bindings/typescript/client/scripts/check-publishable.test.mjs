import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHosts } from '../../../../../../../scripts/hosts.mjs';
import { assertPackedDefaultMatchesSsot } from './check-publishable.mjs';

test('packed default fails when defaultGateway is not the SSOT testnet URL', () => {
  const expected = loadHosts().apis['payment-gateway'].envs.testnet.url;
  const other = expected.replace('testnet', 'mainnet');
  const ok = assertPackedDefaultMatchesSsot('/tmp', {
    load: () => ({ defaultGateway: other, OpenAPI: { BASE: other } }),
  });
  assert.equal(ok, false);
});

test('packed default fails when OpenAPI.BASE drifts from defaultGateway', () => {
  const expected = loadHosts().apis['payment-gateway'].envs.testnet.url;
  const ok = assertPackedDefaultMatchesSsot('/tmp', {
    load: () => ({ defaultGateway: expected, OpenAPI: { BASE: 'https://evil.example' } }),
  });
  assert.equal(ok, false);
});

test('packed default passes when defaultGateway and OpenAPI.BASE are the SSOT testnet URL', () => {
  const expected = loadHosts().apis['payment-gateway'].envs.testnet.url;
  const ok = assertPackedDefaultMatchesSsot('/tmp', {
    load: () => ({ defaultGateway: expected, OpenAPI: { BASE: expected } }),
  });
  assert.equal(ok, true);
});
