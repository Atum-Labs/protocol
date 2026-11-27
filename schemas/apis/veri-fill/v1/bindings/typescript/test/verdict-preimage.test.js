// Cross-language conformance for the verdict signing preimage, asserted against the SAME frozen
// vector files the Go binding asserts. Runs against the built dist.
//
// The point of this file is that the framing was designed around JavaScript's behaviour: the
// length prefix counts bytes because Go's len does, while a naive JS renderer counts UTF-16 code
// units, and an omitted member interpolates as the string "undefined". Two reject vectors in each
// file exist only to pin that, so before this test nothing exercised the case they were written
// for.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  VERDICT_PREIMAGE_TAG,
  DEPOSIT_VERDICT_PREIMAGE_TAG,
  verdictSignedMembers,
  depositVerdictSignedMembers,
  verdictSignedPayload,
  depositVerdictSignedPayload,
  preimageValueByteLength,
} = require('../dist/verdict.js');

const CONFORMANCE = path.join(__dirname, '..', '..', '..', 'conformance');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(CONFORMANCE, name), 'utf8'));
}

const KINDS = [
  {
    label: 'FulfillmentVerdict',
    file: 'verdict-preimage-vectors.json',
    tag: VERDICT_PREIMAGE_TAG,
    render: verdictSignedPayload,
    members: verdictSignedMembers,
  },
  {
    label: 'DepositVerdict',
    file: 'deposit-verdict-preimage-vectors.json',
    tag: DEPOSIT_VERDICT_PREIMAGE_TAG,
    render: depositVerdictSignedPayload,
    members: depositVerdictSignedMembers,
  },
];

for (const kind of KINDS) {
  const vectors = load(kind.file);

  test(`${kind.label}: tag and member order match the vectors`, () => {
    assert.strictEqual(
      vectors.tag,
      kind.tag,
      'the implementation tag and the frozen tag disagree, so every signature would differ',
    );
    const order = kind.members(vectors.accept[0].verdict).map((m) => m.key);
    assert.deepStrictEqual(
      order,
      vectors.memberOrder,
      'member order is part of the signed bytes and it drifted',
    );
  });

  test(`${kind.label}: every accept vector renders the frozen bytes`, () => {
    for (const c of vectors.accept) {
      const preimage = kind.render(c.verdict);
      const hex = Buffer.from(preimage, 'utf8').toString('hex');
      assert.strictEqual(hex, c.preimageHex, `${c.name}: preimage bytes drifted`);
      assert.strictEqual(
        Buffer.byteLength(preimage, 'utf8'),
        c.byteLength,
        `${c.name}: byte length drifted`,
      );
      assert.strictEqual(
        crypto.createHash('sha256').update(preimage, 'utf8').digest('hex'),
        c.sha256,
        `${c.name}: sha256 drifted`,
      );
    }
  });

  test(`${kind.label}: every reject vector is refused before rendering`, () => {
    for (const c of vectors.reject) {
      const bad = { ...vectors.accept[0].verdict, [c.member]: c.value };
      assert.throws(
        () => kind.render(bad),
        `${c.name}: rendered a preimage that must be refused`,
      );
    }
  });

  test(`${kind.label}: an omitted member renders as key=0: and never as "undefined"`, () => {
    // The failure this guards is specific to JavaScript and invisible in Go: interpolating a
    // missing property yields the literal text "undefined", which would then be signed as though
    // it were a value, on the commonest path rather than an exotic one.
    const complete = vectors.accept[0].verdict;
    for (const key of vectors.memberOrder) {
      const partial = { ...complete };
      delete partial[key];
      const preimage = kind.render(partial);
      assert.ok(
        !preimage.includes('undefined'),
        `dropping ${key} put the text "undefined" into the signed bytes`,
      );
      assert.ok(
        preimage.includes(`${key}=0:\n`),
        `dropping ${key} did not render as ${key}=0:`,
      );
    }
  });

  test(`${kind.label}: non-ASCII is refused, which is what prevents a byte/code-unit divergence`, () => {
    // The rejection is the real protection: no legal value is non-ASCII, so the renderer never
    // reaches a length where the two measures could disagree. Asserted here so that stays true.
    const nonAscii = vectors.reject.filter((r) => /non-ascii|astral-plane/.test(r.name));
    assert.ok(
      nonAscii.length >= 2,
      'the vectors no longer carry the non-ASCII cases this check exists for',
    );
    for (const c of nonAscii) {
      const bad = { ...vectors.accept[0].verdict, [c.member]: c.value };
      assert.throws(() => kind.render(bad), `${c.name} was accepted`);
      // And the premise: these values genuinely disagree between the two measures, so the vector
      // is testing what it claims to.
      assert.notStrictEqual(
        Buffer.byteLength(c.value, 'utf8'),
        c.value.length,
        `${c.name}: byte length and code-unit length agree, so this vector proves nothing`,
      );
    }
  });

}

test('the two kinds cannot render the same bytes', () => {
  // The cross-kind guarantee, asserted on this side too. Both are signed by the same per-chain
  // key, so if their preimages could coincide a signature over one would verify as the other.
  const common = {
    domain: 'did:web:atum.network',
    payment_id: '0x' + '1'.repeat(64),
    chain_id: 'eip155:1',
    block_number: '21500000',
    block_hash: '0x' + 'a'.repeat(64),
    transaction_hash: '0x' + 'b'.repeat(64),
  };
  const fulfillment = verdictSignedPayload({
    ...common,
    outcome: 'delivered',
    fulfiller: '0x' + 'c'.repeat(40),
  });
  const deposit = depositVerdictSignedPayload({
    ...common,
    outcome: 'held',
    escrow_address: '0x' + 'c'.repeat(40),
  });

  assert.notStrictEqual(fulfillment, deposit);
  assert.ok(!fulfillment.startsWith(deposit) && !deposit.startsWith(fulfillment));
  assert.notStrictEqual(
    fulfillment.split('\n')[0],
    deposit.split('\n')[0],
    'the two kinds share a first line, so their signing domains are not separated',
  );
});

test('the length prefix counts bytes and not UTF-16 code units', () => {
  // Tested directly rather than through the renderer, because the ASCII rejection means no legal
  // verdict can exercise a divergence: a test that only rendered vectors would pass with this
  // counting code units and prove nothing. It has to be right in advance of the rejection ever
  // being relaxed, since by then a wrong count would be signing different bytes than Go.
  const cases = [
    { value: 'plain-ascii', bytes: 11, units: 11 },
    { value: 'did:web:atum.netw\u043Erk', bytes: 21, units: 20 },
    { value: 'did:web:atum.network\u{1F512}', bytes: 24, units: 22 },
  ];
  for (const c of cases) {
    assert.strictEqual(c.value.length, c.units, `premise wrong for ${JSON.stringify(c.value)}`);
    assert.strictEqual(Buffer.byteLength(c.value, 'utf8'), c.bytes, 'premise wrong');
    assert.strictEqual(
      preimageValueByteLength(c.value),
      c.bytes,
      `${JSON.stringify(c.value)}: counted code units instead of bytes`,
    );
  }
});
