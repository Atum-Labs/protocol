// reserve_location as the generated runtime schema states it: an optional object on the refund
// request, whose three members travel together. Its transaction_hash is shaped exactly as the
// sibling deposit_transaction_hash. Runs against the built dist.

const test = require('node:test');
const assert = require('node:assert');

const { $RefundSignatureRequest, $ReserveLocation } = require('../dist/schemas.gen.js');

const deposit = $RefundSignatureRequest.properties.deposit_transaction_hash;
const members = $ReserveLocation.properties;

const goodTx = '0x' + 'cd'.repeat(32);
const goodBlockNumber = '21500000';
const goodBlockHash = '0x' + 'ef'.repeat(32);

// Just enough of JSON Schema to check a location against the generated runtime schema:
// required members, string type and pattern.
function locationErrors(location) {
  const errors = [];
  for (const name of $ReserveLocation.required) {
    if (!(name in location)) errors.push(`${name} missing`);
  }
  for (const [name, value] of Object.entries(location)) {
    const member = members[name];
    if (!member) continue;
    if (typeof value !== member.type) {
      errors.push(`${name} is not a ${member.type}`);
      continue;
    }
    if (member.pattern && !new RegExp(member.pattern).test(value)) {
      errors.push(`${name} does not match its pattern`);
    }
  }
  return errors;
}

const good = { transaction_hash: goodTx, block_number: goodBlockNumber, block_hash: goodBlockHash };

test('reserve_location is optional and refers to ReserveLocation', () => {
  const property = $RefundSignatureRequest.properties.reserve_location;
  assert.ok(property, 'RefundSignatureRequest declares reserve_location');
  assert.strictEqual(property.$ref, '#/components/schemas/ReserveLocation');
  const required = $RefundSignatureRequest.required || [];
  assert.ok(!required.includes('reserve_location'));
  assert.ok(!required.includes('deposit_transaction_hash'));
});

test('the flat reserve_transaction_hash is not declared', () => {
  assert.strictEqual($RefundSignatureRequest.properties.reserve_transaction_hash, undefined);
});

test('all three members are required inside it, and all are strings', () => {
  assert.deepStrictEqual(
    [...$ReserveLocation.required].sort(),
    ['block_hash', 'block_number', 'transaction_hash'],
  );
  for (const name of ['transaction_hash', 'block_number', 'block_hash']) {
    assert.strictEqual(members[name].type, 'string', `${name} is a string`);
  }
});

test('transaction_hash carries the same pattern as deposit_transaction_hash', () => {
  assert.strictEqual(members.transaction_hash.pattern, deposit.pattern);
});

test('a well-formed location is accepted', () => {
  assert.deepStrictEqual(locationErrors(good), []);
  assert.deepStrictEqual(locationErrors({ ...good, block_number: '0' }), []);
  assert.deepStrictEqual(
    locationErrors({ ...good, transaction_hash: '0' + 'a'.repeat(63) }),
    [],
    'the bare-hex form the sibling accepts',
  );
});

test('a malformed transaction_hash is refused as the sibling refuses it', () => {
  const pattern = new RegExp(deposit.pattern);
  for (const bad of ['0xabc', 'not a hash', '0x' + 'zz'.repeat(32)]) {
    assert.ok(!pattern.test(bad), `the sibling refuses ${bad}`);
    assert.deepStrictEqual(locationErrors({ ...good, transaction_hash: bad }), [
      'transaction_hash does not match its pattern',
    ]);
  }
});

test('a negative or non-integer block_number is refused', () => {
  for (const bad of ['-1', '1.5', '1e6', '0x10', '007', '']) {
    assert.deepStrictEqual(locationErrors({ ...good, block_number: bad }), [
      'block_number does not match its pattern',
    ], `block_number ${JSON.stringify(bad)}`);
  }
  assert.deepStrictEqual(locationErrors({ ...good, block_number: 21500000 }), [
    'block_number is not a string',
  ]);
});

test('a malformed block_hash is refused', () => {
  for (const bad of ['0xabc', 'ef'.repeat(32), '0x' + 'zz'.repeat(32), 'A'.repeat(87)]) {
    assert.deepStrictEqual(locationErrors({ ...good, block_hash: bad }), [
      'block_hash does not match its pattern',
    ], `block_hash ${bad}`);
  }
});

test('a location missing any one member is refused', () => {
  for (const name of ['transaction_hash', 'block_number', 'block_hash']) {
    const partial = { ...good };
    delete partial[name];
    assert.deepStrictEqual(locationErrors(partial), [`${name} missing`]);
  }
});
