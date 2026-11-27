// request_id_reusable answers a question retry_classification does not: may the
// caller re-send this same request_id. Mirrors the Go request_id_reusable_test.go.
const test = require('node:test');
const assert = require('node:assert');
const { toErrorResponse } = require('../dist/index.js');
const { catalog } = require('../dist/catalog_data.js');

const internal = (code) => ({
  code,
  message: 'internal detail',
  request_id: 'req_1',
  domain: 'PAYMENT_GATEWAY',
  timestamp: '2026-01-01T00:00:00Z',
});

test('a body rejected at ingress leaves the request_id free', () => {
  const pub = toErrorResponse(internal('MALFORMED_REQUEST_BODY'));
  assert.strictEqual(pub.request_id_reusable, true);
});

// The pair that motivated the field: same classification, opposite answer on the id.
test('an unserved corridor spends the request_id despite the same classification', () => {
  const corridor = toErrorResponse(internal('NO_SETTLER_FOR_CORRIDOR'));
  const malformed = toErrorResponse(internal('MALFORMED_REQUEST_BODY'));
  assert.strictEqual(corridor.request_id_reusable, false);
  assert.strictEqual(
    corridor.retry_classification,
    malformed.retry_classification,
    'both are NOT_RETRYABLE_FIX_REQUEST, which is why the id needs its own field',
  );
});

test('false is carried, not dropped as falsy', () => {
  const pub = toErrorResponse(internal('NO_SETTLER_FOR_CORRIDOR'));
  assert.ok('request_id_reusable' in pub, 'the key must be present');
  assert.strictEqual(pub.request_id_reusable, false);
});

test('an unknown code does not guess whether the id survived', () => {
  const pub = toErrorResponse(internal('NO_SUCH_CODE_EXISTS'));
  assert.strictEqual(pub.code, 'INTERNAL_ERROR');
  assert.ok(!('request_id_reusable' in pub), 'the fallback must not assert reusability');
});

test('no entry claims the id is free while telling the caller to reconcile', () => {
  for (const [code, entry] of Object.entries(catalog.entries)) {
    if (entry.retry_classification !== 'RECONCILE_THEN_DECIDE') continue;
    assert.notStrictEqual(
      entry.request_id_reusable,
      true,
      `${code} tells the caller to reconcile a payment, so the id cannot be free`,
    );
  }
});
