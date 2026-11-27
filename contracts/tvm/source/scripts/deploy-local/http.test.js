// The fakes stand in for async I/O, so they are async without awaiting anything.
/* eslint-disable require-await */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { postJson, requireField } = require('./http');

const URL = 'http://127.0.0.1:9090/wallet/getblockbynum';

describe('postJson', () => {
  it('names the URL and the cause when the node refuses the connection', async () => {
    // What Node's fetch rejects with when nothing listens on the port.
    const refused = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    };
    await assert.rejects(postJson(URL, { num: 0 }, refused), new RegExp(`^Error: POST ${URL}: ECONNREFUSED$`));
  });

  it('names the URL and the status on a non-2xx response', async () => {
    const unavailable = async () => ({ ok: false, status: 503 });
    await assert.rejects(postJson(URL, { num: 0 }, unavailable), new RegExp(`POST ${URL}: HTTP 503`));
  });

  it('returns the parsed body', async () => {
    const ok = async () => ({ ok: true, json: async () => ({ blockID: 'ab' }) });
    assert.deepEqual(await postJson(URL, { num: 0 }, ok), { blockID: 'ab' });
  });
});

describe('requireField', () => {
  it('returns the field when the node answered with it', () => {
    assert.equal(requireField(URL, { blockID: 'ab' }, 'blockID'), 'ab');
    assert.equal(requireField(URL, { constant_result: ['cd'] }, 'constant_result[0]', 'cd'), 'cd');
  });

  // A tre still at block 0 rejects the CHAINID constant call; without this the run would fail as
  // "CHAINID result is not a 32-byte word: undefined", which reads like a bad image.
  it('names the URL, the field and the node\'s error when a wallet/ call failed', () => {
    const rejected = { result: { code: 'CONTRACT_VALIDATE_ERROR', message: 'not ready' } };
    assert.throws(
      () => requireField(URL, rejected, 'constant_result[0]', undefined),
      (err) => err.message === `POST ${URL}: no constant_result[0] in response: ` +
        '{"code":"CONTRACT_VALIDATE_ERROR","message":"not ready"}'
    );
  });

  it('names the JSON-RPC error when a /jsonrpc call failed', () => {
    const failed = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } };
    assert.throws(
      () => requireField(URL, failed, 'result'),
      (err) => err.message === `POST ${URL}: no result in response: {"code":-32601,"message":"method not found"}`
    );
  });

  it('falls back to the whole response when it has neither result nor error', () => {
    assert.throws(() => requireField(URL, {}, 'blockID'), (err) => err.message === `POST ${URL}: no blockID in response: {}`);
  });
});
