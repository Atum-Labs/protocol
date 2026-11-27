import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { isSmallOrderEncoding, verifyEd25519Strict } from './commitment-solana.js';
import { forgeForSmallOrderKey } from './test-helpers.js';

// Written out again rather than read from the library, so a typo in either copy fails: every entry
// must admit a forgery under plain verification, and the strict check must refuse it. Mirrors the
// Go ed25519_strict_test.go.
const SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];
const MESSAGE = Buffer.alloc(32, 0x5a);
// For each small-order R encoding that is a canonical point: a mixed-order public key
// A = [a]B + T (T of order 8) and S = k·a mod L for which plain verification accepts (R, S) over
// MESSAGE, because R + [k]T is the identity. Neither A nor S is small-order or out of range, so only
// the R check refuses these. The other encodings are not canonical, so no signature can carry them
// past plain verification. Mirrors the Go smallOrderRForgeries.
const SMALL_ORDER_R_FORGERIES: Record<string, { pubkey: string; signatureS: string }> = {
  '0000000000000000000000000000000000000000000000000000000000000000': {
    pubkey: 'da99e28ba529cdde35a25fba9059e78ecaee239f99755b9b1aa4f65df00803e2',
    signatureS: '06d1ba14090a9319c0e676bcb28826d8833c481df8fc81311e9895e938b8970f',
  },
  '0000000000000000000000000000000000000000000000000000000000000080': {
    pubkey: '05e1dbc711070bb71fdfa9ee201150e4419dac77051e5f1ad4b811d498570c97',
    signatureS: 'bcab59a92171205ac4589abc7521f914d9a75e920da0ace844817b584a4cdf0f',
  },
  '0100000000000000000000000000000000000000000000000000000000000000': {
    pubkey: '16b981d0b88cdf3ab9fa87190822fe4905b475efda3aec7c34abfa92c19320f4',
    signatureS: '8143a3ebf75816ede2282130a1038c81152c5c8b2a1605a0ced697b6568b8306',
  },
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05': {
    pubkey: '2224104c31292fde7d23ffbaf8569c4c0768ad6bdfe733a04e9eac866e752efe',
    signatureS: 'c4485628a93a6367dc84c379257324c02655808157b8889fcbcff6b666e84d05',
  },
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85': {
    pubkey: 'f8334086bc669024d5c0d79637f0f69a5202c6099008626c9640f33f245aff13',
    signatureS: '7f83ffed6d8287fb51dc2338ffdbc921f0ac74a1a03fff0bab6e6c1b815ddd00',
  },
  c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a: {
    pubkey: '16b981d0b88cdf3ab9fa87190822fe4905b475efda3aec7c34abfa92c19320f4',
    signatureS: 'b35477bac2565a2c69c882fba25a72b8d11983e3a34aa93cd4b4945f891c9402',
  },
  c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa: {
    pubkey: '5b94d525f09dbb3f8bec71da454b8a76c21f9edc1a6b2c8a2650090c0c6a2bd6',
    signatureS: 'bb8bcbdfb59acab9ee2ce96077e63c831c027e3b44ca76c0f63f5febac43640d',
  },
  ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f: {
    pubkey: '5b94d525f09dbb3f8bec71da454b8a76c21f9edc1a6b2c8a2650090c0c6a2bd6',
    signatureS: '575506ecaed80180741698293c0cee3f2d7835c5f96aa86dbc44b07d4f78300b',
  },
};
const withSignBit = (hex: string, set: boolean): Uint8Array => {
  const b = Buffer.from(hex, 'hex');
  if (set) b[31]! |= 0x80;
  return b;
};

describe('verifyEd25519Strict', () => {
  for (const hex of SMALL_ORDER) {
    for (const sign of [false, true]) {
      const point = withSignBit(hex, sign);
      const label = `${hex.slice(0, 8)}… sign bit ${sign ? 'set' : 'clear'}`;

      it(`refuses ${label} as the public key`, () => {
        const forged = forgeForSmallOrderKey(point, MESSAGE);
        // With the sign bit clear, every entry decodes, so plain verification must accept a forgery;
        // that is what proves the entry is a small-order point.
        if (!sign) expect(forged).toBeDefined();
        const signature = Buffer.from((forged ?? '0x' + '11'.repeat(64)).slice(2), 'hex');
        expect(verifyEd25519Strict(point, MESSAGE, signature)).toBe(false);
      });

      it(`refuses ${label} as R`, () => {
        expect(isSmallOrderEncoding(point)).toBe(true);
        const forgery = SMALL_ORDER_R_FORGERIES[Buffer.from(point).toString('hex')];
        if (forgery === undefined) return;
        const publicKey = Buffer.from(forgery.pubkey, 'hex');
        const signature = Buffer.concat([
          Buffer.from(point),
          Buffer.from(forgery.signatureS, 'hex'),
        ]);
        // Controls: plain verification accepts it, and the key is not small-order.
        expect(nacl.sign.detached.verify(MESSAGE, signature, publicKey)).toBe(true);
        expect(isSmallOrderEncoding(publicKey)).toBe(false);
        expect(verifyEd25519Strict(publicKey, MESSAGE, signature)).toBe(false);
      });
    }
  }

  it('has a forgery for every canonical small-order R', () => {
    expect(Object.keys(SMALL_ORDER_R_FORGERIES)).toHaveLength(8);
  });

  it('accepts an honest signature', () => {
    const honest = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const signature = nacl.sign.detached(MESSAGE, honest.secretKey);
    expect(verifyEd25519Strict(honest.publicKey, MESSAGE, signature)).toBe(true);
  });
});
