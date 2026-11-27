// Leak and fallback tests for the error TypeScript binding, mirroring the Go
// example_test.go. Runs against the built dist.
const test = require('node:test');
const assert = require('node:assert');
const { toErrorResponse, httpStatus } = require('../dist/index.js');

test('toErrorResponse maps TX_REVERTED to a generic public error and leaks nothing', () => {
  const internal = {
    code: 'TX_REVERTED',
    message: 'tx 0xabc reverted: execution reverted: FulfillmentProxy_ExpiredTransaction',
    request_id: 'req_12345',
    domain: 'SETTLER_AGENT',
    timestamp: '2026-01-01T00:00:00Z',
    details: { tx_hash: '0xabc', revert_reason: 'FulfillmentProxy_ExpiredTransaction', nonce: 42 },
  };
  const pub = toErrorResponse(internal);
  assert.strictEqual(pub.code, 'SETTLEMENT_FAILED');
  assert.strictEqual(pub.request_id, 'req_12345');
  assert.strictEqual(httpStatus(internal), 502);
  assert.ok(pub.docs_url.endsWith('settlement-failed'));

  const body = JSON.stringify(pub);
  for (const leaked of ['revert_reason', '0xabc', 'nonce', 'details', 'FulfillmentProxy']) {
    assert.ok(!body.includes(leaked), `serialized ErrorResponse leaked ${leaked}: ${body}`);
  }
});

test('toErrorResponse falls back to INTERNAL_ERROR for an unknown code and leaks nothing', () => {
  const internal = {
    code: 'SOME_BRAND_NEW_CODE',
    message: 'internal: secret stack trace and db dsn',
    request_id: 'req_999',
    domain: 'SETTLER_GATEWAY',
    timestamp: '2026-01-01T00:00:00Z',
    details: { db_dsn: 'postgres://secret@host', stack: 'secret trace' },
  };
  const pub = toErrorResponse(internal);
  assert.strictEqual(pub.code, 'INTERNAL_ERROR');
  assert.strictEqual(httpStatus(internal), 500);
  assert.strictEqual(pub.domain, 'SETTLER_GATEWAY');

  const body = JSON.stringify(pub);
  for (const leaked of ['secret', 'dsn', 'postgres', 'db_dsn', 'stack', 'details']) {
    assert.ok(!body.includes(leaked), `serialized fallback ErrorResponse leaked ${leaked}: ${body}`);
  }
});

test('a prototype-member code falls back instead of resolving up the chain', () => {
  for (const code of ['toString', 'constructor', 'hasOwnProperty']) {
    const pub = toErrorResponse({ code, message: 'x', request_id: 'r', timestamp: '' });
    assert.strictEqual(pub.code, 'INTERNAL_ERROR', `code ${code} did not fall back`);
  }
});

test('toErrorResponse carries both ids independently, and omits payment_id when absent', () => {
  const paymentId = '0xc7108e200d11580e7e75185991084b42a535af588ba8267cd0d1e7df089e5c9c';

  const both = toErrorResponse({
    code: 'TX_REVERTED',
    message: 'reverted',
    request_id: 'req_12345',
    payment_id: paymentId,
    domain: 'SETTLER_AGENT',
    timestamp: '2026-01-01T00:00:00Z',
  });
  assert.strictEqual(both.request_id, 'req_12345');
  assert.strictEqual(both.payment_id, paymentId);

  // A rejection raised before a payment existed has no payment id, and the key is
  // absent rather than present and empty.
  const noPayment = toErrorResponse({
    code: 'INVALID_REQUEST',
    message: 'bad body',
    request_id: 'req_67890',
    domain: 'PAYMENT_GATEWAY',
    timestamp: '2026-01-01T00:00:00Z',
  });
  assert.strictEqual(noPayment.request_id, 'req_67890');
  assert.ok(!('payment_id' in noPayment), `payment_id must be omitted: ${JSON.stringify(noPayment)}`);
});
