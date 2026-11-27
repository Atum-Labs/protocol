package encoding

import (
	"math/big"
	"testing"
)

// In-range chain IDs (fit in 32 bits, e.g. Tron mainnet) pass through the mask unchanged.
func TestMaskTronChainId_InRangeIsUnchanged(t *testing.T) {
	const tronMainnet = 728126428 // < 2^32

	in := big.NewInt(tronMainnet)

	if got := MaskTronChainId(*in); got.Cmp(in) != 0 {
		t.Fatalf("MaskTronChainId(%d) = %s, want %d (in-range IDs must be unchanged)", tronMainnet, got.String(), tronMainnet)
	}
	if got := MaskTronChainIdBig(in); got.Cmp(in) != 0 {
		t.Fatalf("MaskTronChainIdBig(%d) = %s, want %d (in-range IDs must be unchanged)", tronMainnet, got.String(), tronMainnet)
	}
}

// Two IDs sharing their low 32 bits but differing above bit 32 mask to the same value,
// the cross-chain signing-domain collision the ChainIDMask invariant guards against.
func TestMaskTronChainId_HighBitsCollide(t *testing.T) {
	low := big.NewInt(728126428) // low 32 bits, an in-range ID

	// aliased = low + (1 << 32): identical low 32 bits, differs above bit 32.
	twoPow32 := new(big.Int).Lsh(big.NewInt(1), 32)
	aliased := new(big.Int).Add(low, twoPow32)

	if low.Cmp(aliased) == 0 {
		t.Fatalf("test setup: low and aliased must differ before masking")
	}

	gotLow := MaskTronChainIdBig(low)
	gotAliased := MaskTronChainIdBig(aliased)
	if gotLow.Cmp(gotAliased) != 0 {
		t.Fatalf("expected masked collision: MaskTronChainIdBig(%s)=%s vs MaskTronChainIdBig(%s)=%s",
			low.String(), gotLow.String(), aliased.String(), gotAliased.String())
	}

	// The value form collides too.
	vLow := MaskTronChainId(*low)
	vAliased := MaskTronChainId(*aliased)
	if vLow.Cmp(&vAliased) != 0 {
		t.Fatalf("expected masked collision (value form): %s vs %s", vLow.String(), vAliased.String())
	}
}
