package senderauth

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"math/big"
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Written out again rather than read from smallOrderEncodings, so a typo in either copy fails:
// every entry must admit a forgery under plain verification, and the strict check must refuse it.
// Mirrors the TS ed25519-strict.test.ts.
var smallOrderTestEncodings = []string{
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0100000000000000000000000000000000000000000000000000000000000000",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
}

var ed25519L, _ = new(big.Int).SetString("7237005577332262213973186563042994240857116359379907606001950938285454250989", 10)

// leBigInt reads b as a little-endian integer.
func leBigInt(b []byte) *big.Int {
	be := slices.Clone(b)
	slices.Reverse(be)
	return new(big.Int).SetBytes(be)
}

// le32 writes v as 32 little-endian bytes.
func le32(v *big.Int) []byte {
	out := v.FillBytes(make([]byte, 32))
	slices.Reverse(out)
	return out
}

// secretScalar is the ed25519 secret scalar of a seed, reduced mod L.
func secretScalar(seed []byte) *big.Int {
	h := sha512.Sum512(seed)
	h[0] &= 248
	h[31] &= 127
	h[31] |= 64
	return new(big.Int).Mod(leBigInt(h[:32]), ed25519L)
}

// forgeForSmallOrderKey returns a signature over message that ed25519.Verify accepts under the
// small-order publicKey, from R = [a]B and S = a for the first of 256 seeds whose [k]A is the
// identity, or nil when none does.
func forgeForSmallOrderKey(publicKey, message []byte) []byte {
	for i := 1; i <= 256; i++ {
		seed := make([]byte, 32)
		seed[0], seed[1] = byte(i), byte(i>>8)
		pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
		signature := append(bytes.Clone(pub), le32(secretScalar(seed))...)
		if ed25519.Verify(publicKey, message, signature) {
			return signature
		}
	}
	return nil
}

// smallOrderRForgeries holds, for each small-order R encoding that is a canonical point, a
// mixed-order public key A = [a]B + T (T of order 8) and S = k·a mod L for which plain verification
// accepts (R, S) over the test message: [S]B = R + [k]A because R + [k]T is the identity. Neither A
// nor S is small-order or out of range, so only the R check refuses these. Generated with
// @noble/curves and checked with tweetnacl; the Go control below checks them with crypto/ed25519.
// The other encodings are not canonical, so no signature can carry them past plain verification.
var smallOrderRForgeries = map[string]struct{ pubkey, signatureS string }{
	"0000000000000000000000000000000000000000000000000000000000000000": {"da99e28ba529cdde35a25fba9059e78ecaee239f99755b9b1aa4f65df00803e2", "06d1ba14090a9319c0e676bcb28826d8833c481df8fc81311e9895e938b8970f"},
	"0000000000000000000000000000000000000000000000000000000000000080": {"05e1dbc711070bb71fdfa9ee201150e4419dac77051e5f1ad4b811d498570c97", "bcab59a92171205ac4589abc7521f914d9a75e920da0ace844817b584a4cdf0f"},
	"0100000000000000000000000000000000000000000000000000000000000000": {"16b981d0b88cdf3ab9fa87190822fe4905b475efda3aec7c34abfa92c19320f4", "8143a3ebf75816ede2282130a1038c81152c5c8b2a1605a0ced697b6568b8306"},
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05": {"2224104c31292fde7d23ffbaf8569c4c0768ad6bdfe733a04e9eac866e752efe", "c4485628a93a6367dc84c379257324c02655808157b8889fcbcff6b666e84d05"},
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85": {"f8334086bc669024d5c0d79637f0f69a5202c6099008626c9640f33f245aff13", "7f83ffed6d8287fb51dc2338ffdbc921f0ac74a1a03fff0bab6e6c1b815ddd00"},
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a": {"16b981d0b88cdf3ab9fa87190822fe4905b475efda3aec7c34abfa92c19320f4", "b35477bac2565a2c69c882fba25a72b8d11983e3a34aa93cd4b4945f891c9402"},
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa": {"5b94d525f09dbb3f8bec71da454b8a76c21f9edc1a6b2c8a2650090c0c6a2bd6", "bb8bcbdfb59acab9ee2ce96077e63c831c027e3b44ca76c0f63f5febac43640d"},
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f": {"5b94d525f09dbb3f8bec71da454b8a76c21f9edc1a6b2c8a2650090c0c6a2bd6", "575506ecaed80180741698293c0cee3f2d7835c5f96aa86dbc44b07d4f78300b"},
}

func TestVerifyEd25519StrictRefusesEverySmallOrderPoint(t *testing.T) {
	message := bytes.Repeat([]byte{0x5a}, 32)
	for _, h := range smallOrderTestEncodings {
		for _, signBit := range []bool{false, true} {
			point, _ := hex.DecodeString(h)
			if signBit {
				point[31] |= 0x80
			}
			label := fmt.Sprintf("%s… sign bit %v", h[:8], signBit)

			t.Run(label+" as the public key", func(t *testing.T) {
				forged := forgeForSmallOrderKey(point, message)
				// With the sign bit clear, every entry decodes, so plain verification must accept a
				// forgery; that is what proves the entry is a small-order point.
				if !signBit {
					require.NotNil(t, forged, "no forgery: %s is not a small-order point", h)
				}
				if forged == nil {
					forged = bytes.Repeat([]byte{0x11}, 64)
				}
				assert.False(t, verifyEd25519Strict(point, message, forged))
			})

			t.Run(label+" as R", func(t *testing.T) {
				assert.True(t, isSmallOrderEncoding(point))
				forgery, canonical := smallOrderRForgeries[hex.EncodeToString(point)]
				if !canonical {
					return
				}
				publicKey, _ := hex.DecodeString(forgery.pubkey)
				s, _ := hex.DecodeString(forgery.signatureS)
				signature := append(bytes.Clone(point), s...)
				require.True(t, ed25519.Verify(publicKey, message, signature), "control: plain verification accepts it")
				require.False(t, isSmallOrderEncoding(publicKey), "control: the key is not small-order")
				assert.False(t, verifyEd25519Strict(publicKey, message, signature))
			})
		}
	}
	require.Len(t, smallOrderRForgeries, 8)

	t.Run("an honest signature", func(t *testing.T) {
		honest := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{3}, 32))
		honestPub := honest.Public().(ed25519.PublicKey)
		assert.True(t, verifyEd25519Strict(honestPub, message, ed25519.Sign(honest, message)))
	})
}
