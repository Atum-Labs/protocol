// Projection and fallback tests for the decline TypeScript binding, mirroring the Go
// catalog_test.go. Runs against the built dist.
const test = require('node:test');
const assert = require('node:assert');
const { reasonFor, known, toPublicReason, ALL_DECLINE_REASON_CODES } = require('../dist/index.js');

test('toPublicReason projects a catalogued reason and never relays the settler message', () => {
  const decline = {
    reason_code: 'UNTRUSTED_VERIFIER',
    message: 'fulfillment verifier 0xdeadbeef is not trusted by this settler',
    payment_id: '0xabc',
  };
  const pub = toPublicReason(decline);
  assert.strictEqual(pub.code, 'UNTRUSTED_VERIFIER');
  assert.ok(pub.message.length > 0);

  const body = JSON.stringify(pub);
  for (const leaked of ['0xdeadbeef', '0xabc', 'payment_id']) {
    assert.ok(!body.includes(leaked), `serialized PublicReason leaked ${leaked}: ${body}`);
  }
});

test('an unknown reason is counted as OTHER rather than throwing', () => {
  const pub = reasonFor('A_REASON_FROM_THE_FUTURE');
  assert.strictEqual(pub.code, 'OTHER');
  assert.ok(pub.message.length > 0);
  assert.strictEqual(known('A_REASON_FROM_THE_FUTURE'), false);
});

test('a reason deliberately bucketed as OTHER is still known', () => {
  assert.strictEqual(reasonFor('HOOK_DECLINED').code, 'OTHER');
  assert.strictEqual(known('HOOK_DECLINED'), true);
});

test('every generated code resolves through the catalog', () => {
  assert.ok(ALL_DECLINE_REASON_CODES.length > 0);
  for (const code of ALL_DECLINE_REASON_CODES) {
    assert.strictEqual(known(code), true, `${code} is generated but absent from the catalog`);
    assert.ok(reasonFor(code).message.length > 0, `${code} has an empty public message`);
  }
});

test('QUOTE_WINDOW_TOO_SHORT projects to its own fixable reason, not OTHER', () => {
  // The fix is a longer quote_deadline, so the caller needs the specific code and a
  // message naming the field; bucketed as OTHER the decline is not actionable.
  const code = 'QUOTE_WINDOW_TOO_SHORT';
  assert.strictEqual(known(code), true);
  const pub = reasonFor(code);
  assert.strictEqual(pub.code, code);
  assert.strictEqual(pub.retry_classification, 'NOT_RETRYABLE_FIX_REQUEST');
  assert.ok(pub.message.includes('quote_deadline'), `message does not name quote_deadline: ${pub.message}`);
  // The direction is the fix; the opposite direction moves the caller further away.
  assert.ok(
    pub.message.includes('longer quote_deadline'),
    `message does not ask for a longer quote_deadline: ${pub.message}`,
  );
  // The two window reasons ask for opposite fixes, so they cannot share a message.
  assert.notStrictEqual(pub.message, reasonFor('QUOTE_WINDOW_TOO_LONG').message);
  assert.ok(
    typeof pub.docs_url === 'string' && pub.docs_url.endsWith('#quote-window-too-short'),
    `docs_url ${pub.docs_url} does not end in #quote-window-too-short`,
  );
});

test('AWARD_WINDOW_TOO_SHORT names the hold and asks for a later fulfillment_deadline', () => {
  const code = 'AWARD_WINDOW_TOO_SHORT';
  assert.strictEqual(known(code), true);
  const pub = reasonFor(code);
  assert.strictEqual(pub.code, code);
  assert.strictEqual(pub.retry_classification, 'NOT_RETRYABLE_FIX_REQUEST');
  // The window that ran out is the settler's own price hold.
  assert.ok(pub.message.includes('award_deadline'), `message does not name award_deadline: ${pub.message}`);
  // No request field is called award_deadline, so the message has to say whose it is and
  // what it holds, or a caller goes looking for a field of their own to change.
  assert.ok(
    pub.message.includes("settler's award_deadline"),
    `message does not call award_deadline the settler's: ${pub.message}`,
  );
  assert.ok(
    pub.message.toLowerCase().includes('price'),
    `message does not say award_deadline is how long the settler holds its price: ${pub.message}`,
  );
  // The caller cannot move award_deadline; a later fulfillment_deadline is what widens the window.
  assert.ok(
    pub.message.includes('later fulfillment_deadline'),
    `message does not ask for a later fulfillment_deadline: ${pub.message}`,
  );
  // Moving quote_deadline does not help, so naming it sends the caller to the wrong field.
  assert.ok(!pub.message.includes('quote_deadline'), `message names quote_deadline: ${pub.message}`);
  // A different cause from DEADLINE_TOO_SHORT, so the two cannot share a message.
  assert.notStrictEqual(pub.message, reasonFor('DEADLINE_TOO_SHORT').message);
});

test('token transfer restrictions project to their own codes and retry advice', () => {
  // A paused asset clears when the issuer resumes; a restricted destination needs a changed request.
  for (const [code, retry, slug, advice] of [
    ['ASSET_PAUSED', 'RETRY_AFTER_DELAY', '#asset-paused', 'once the issuer resumes'],
    ['DESTINATION_ACCOUNT_RESTRICTED', 'NOT_RETRYABLE_FIX_REQUEST', '#destination-account-restricted', 'destination account that can receive'],
  ]) {
    const pub = reasonFor(code);
    assert.strictEqual(pub.code, code);
    assert.strictEqual(pub.retry_classification, retry);
    assert.ok(pub.docs_url.endsWith(slug), `${code} docs_url ${pub.docs_url} does not end in ${slug}`);
    // The payer only sees this message, so it says what to do next.
    assert.ok(pub.message.includes(advice), `${code} message does not advise ${advice}: ${pub.message}`);
  }
});
