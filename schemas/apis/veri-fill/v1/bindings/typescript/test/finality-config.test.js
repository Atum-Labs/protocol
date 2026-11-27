// The finality-config contract as the generated runtime schema states it: `finality` is an
// open string (a closed enum would make a generated validator drop a chain entry when a method
// is added) and neither new member is required. Runs against the built dist.

const test = require('node:test');
const assert = require('node:assert');

const { $ChainFinalityConfig } = require('../dist/schemas.gen.js');

test('finality is declared as an open string, never an enum', () => {
  const finality = $ChainFinalityConfig.properties.finality;
  assert.ok(finality, 'ChainFinalityConfig declares finality');
  assert.strictEqual(finality.type, 'string');
  assert.strictEqual(finality.enum, undefined);
});

test('time_to_final_ms is a 64-bit integer', () => {
  const ttf = $ChainFinalityConfig.properties.time_to_final_ms;
  assert.ok(ttf, 'ChainFinalityConfig declares time_to_final_ms');
  assert.strictEqual(ttf.type, 'integer');
  assert.strictEqual(ttf.format, 'int64');
});

test('only chain_id is required', () => {
  assert.deepStrictEqual([...$ChainFinalityConfig.required], ['chain_id']);
});

test('finality_model is no longer declared', () => {
  assert.strictEqual($ChainFinalityConfig.properties.finality_model, undefined);
});
