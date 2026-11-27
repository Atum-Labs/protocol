package senderauth

import (
	"fmt"
	"math/big"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// bigIntFromString is a test helper that parses a decimal string into a *big.Int.
func bigIntFromString(t *testing.T, s string) *big.Int {
	t.Helper()
	n, ok := new(big.Int).SetString(s, 10)
	require.True(t, ok, "parse big.Int %q", s)
	return n
}

// TestSameAddress mirrors TS utils.test.ts: EVM 0x hex compares case-insensitively,
// everything else (base58 Solana / Tron) compares exactly.
func TestSameAddress(t *testing.T) {
	require.True(t, sameAddress(
		"0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
		"0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a"), "EVM hex is case-insensitive")
	require.False(t, sameAddress(
		"0x1111111111111111111111111111111111111111",
		"0x2222222222222222222222222222222222222222"), "different EVM hex")

	require.True(t, sameAddress(
		"GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse",
		"GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse"), "base58 exact match")
	require.False(t, sameAddress(
		"GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse",
		"gygkxmyg1p9sshfm15mknuu1u9tn2jttspcdmrtgudse"), "base58 is case-sensitive")

	// Only one side is 0x-prefixed -> exact compare (never case-folded).
	require.False(t, sameAddress("0xabc", "abc"), "mixed prefix falls back to exact compare")
}

func TestNamespaceOf(t *testing.T) {
	require.Equal(t, "eip155", namespaceOf("eip155:1"))
	require.Equal(t, "solana", namespaceOf("solana:mainnet"))
	require.Equal(t, "tron", namespaceOf("tron:mainnet"))
	require.Equal(t, "unprefixed", namespaceOf("unprefixed"))
}

func TestEvmChainID(t *testing.T) {
	id, err := evmChainID("eip155:1")
	require.NoError(t, err)
	require.Equal(t, int64(1), id)

	id, err = evmChainID("eip155:42161")
	require.NoError(t, err)
	require.Equal(t, int64(42161), id)

	_, err = evmChainID("solana:mainnet")
	require.Error(t, err, "non-eip155 network must error")

	_, err = evmChainID("eip155:abc")
	require.Error(t, err, "non-numeric chain id must error")

	// The EIP-2294 bound, which exists for the TS mirror: above it Number() stops being
	// injective, so the two bindings would read the same reference differently. Last accepted and
	// first refused, the pair a `>` slipped to `>=` would break. TS asserts the same two values.
	id, err = evmChainID("eip155:9007199254740991")
	require.NoError(t, err)
	require.Equal(t, int64(maxEvmChainID), id)

	_, err = evmChainID("eip155:9007199254740992")
	require.ErrorContains(t, err, "exceeds the EIP-2294 maximum")

	_, err = evmChainID("eip155:9007199254740993")
	require.ErrorContains(t, err, "exceeds the EIP-2294 maximum")

	// Past int64 the parse fails before the bound is reached. It still reports the range rather
	// than claiming this is not an eip155 network, which is what TS says for the same input.
	_, err = evmChainID("eip155:99999999999999999999999999")
	require.ErrorContains(t, err, "exceeds the EIP-2294 maximum")
}

func TestTronNumericChainID(t *testing.T) {
	id, err := tronNumericChainID("tron:mainnet", nil)
	require.NoError(t, err)
	require.Equal(t, int64(728126428), id)

	id, err = tronNumericChainID("tron:shasta", nil)
	require.NoError(t, err)
	require.Equal(t, int64(2494104990), id)

	_, err = tronNumericChainID("tron:unknown", nil)
	require.Error(t, err)

	// A non-tron namespace must not resolve to Tron mainnet's id off the cluster name alone. TS
	// asserts the same three inputs.
	for _, network := range []string{"eip155:mainnet", "solana:mainnet", ":mainnet", "mainnet"} {
		_, err = tronNumericChainID(network, nil)
		require.ErrorContains(t, err, "expected a tron network", network)
	}

	// Namespace is right, segment count is not. TS asserts the same input.
	_, err = tronNumericChainID("tron:mainnet:extra", nil)
	require.ErrorContains(t, err, "unsupported Tron network")

	// A Go map lookup never reaches a prototype, but a TS object index can, so these are asserted
	// on both sides to keep the pair equivalent.
	for _, name := range []string{"constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"} {
		_, err = tronNumericChainID("tron:"+name, nil)
		require.ErrorContains(t, err, "unsupported Tron network", name)
		_, err = resolveTronPermit2(name)
		require.ErrorContains(t, err, "no Permit2 address known", name)
	}
}

// requireTronChainIDError asserts err is a *tronChainIDError with exactly detail.
func requireTronChainIDError(t *testing.T, err error, detail string) {
	t.Helper()
	var misconfigured *tronChainIDError
	require.ErrorAs(t, err, &misconfigured)
	require.Equal(t, detail, misconfigured.detail)
}

// A supplied id is read only where the table has none, and never against it. TS asserts the same
// inputs.
func TestTronNumericChainIDSupplied(t *testing.T) {
	localnet := map[string]int64{"localnet": 3360022319}
	id, err := tronNumericChainID("tron:localnet", localnet)
	require.NoError(t, err)
	require.Equal(t, int64(3360022319), id)

	// Nothing supplied for the cluster: refused exactly as without the option.
	for _, supplied := range []map[string]int64{nil, {}, {"nile": 3360022319}} {
		_, err = tronNumericChainID("tron:localnet", supplied)
		require.ErrorContains(t, err, "unsupported Tron network")
		var misconfigured *tronChainIDError
		require.NotErrorAs(t, err, &misconfigured)
	}

	// The table is authoritative: an entry may repeat its id, never replace it.
	id, err = tronNumericChainID("tron:mainnet", map[string]int64{"mainnet": 728126428})
	require.NoError(t, err)
	require.Equal(t, int64(728126428), id)
	_, err = tronNumericChainID("tron:mainnet", map[string]int64{"mainnet": 3360022319})
	requireTronChainIDError(t, err, `the Tron chain id supplied for cluster "mainnet" is 3360022319, but the built-in table has 728126428`)
	_, err = tronNumericChainID("tron:shasta", map[string]int64{"shasta": 728126428})
	requireTronChainIDError(t, err, `the Tron chain id supplied for cluster "shasta" is 728126428, but the built-in table has 2494104990`)

	// Only the source's own cluster is read, so an unusable entry for another changes nothing.
	id, err = tronNumericChainID("tron:mainnet", map[string]int64{"localnet": 0, "shasta": 1})
	require.NoError(t, err)
	require.Equal(t, int64(728126428), id)
}

// A built-in id under a new name would make that name an alias of the built-in network, so a permit
// signed for mainnet would verify there. TS asserts the same inputs.
func TestTronNumericChainIDSuppliedNotABuiltInID(t *testing.T) {
	_, err := tronNumericChainID("tron:localnet", map[string]int64{"localnet": 728126428})
	requireTronChainIDError(t, err, `the Tron chain id supplied for cluster "localnet" is 728126428, which the built-in table gives cluster "mainnet"`)
	_, err = tronNumericChainID("tron:localnet", map[string]int64{"localnet": 2494104990})
	requireTronChainIDError(t, err, `the Tron chain id supplied for cluster "localnet" is 2494104990, which the built-in table gives cluster "shasta"`)
	// The non-canonical alias of mainnet stays refused when an entry names it.
	_, err = tronNumericChainID("tron:0x2b6653dc", map[string]int64{"0x2b6653dc": 728126428})
	requireTronChainIDError(t, err, `the Tron chain id supplied for cluster "0x2b6653dc" is 728126428, which the built-in table gives cluster "mainnet"`)
	// Only an id the table uses is refused, not its neighbours.
	for _, want := range []int64{728126429, 2494104989} {
		id, err := tronNumericChainID("tron:localnet", map[string]int64{"localnet": want})
		require.NoError(t, err)
		require.Equal(t, want, id)
	}
}

// TIP712.sol refuses a chain id above uint32, and TS uses the same bound.
func TestTronNumericChainIDSuppliedRange(t *testing.T) {
	require.Equal(t, int64(4294967295), maxTronChainID)
	// First and last accepted, then the first refused on each side: the pairs a slipped bound breaks.
	for _, want := range []int64{1, 4294967295} {
		id, err := tronNumericChainID("tron:localnet", map[string]int64{"localnet": want})
		require.NoError(t, err)
		require.Equal(t, want, id)
	}
	for _, bad := range []int64{0, -1, 4294967296} {
		_, err := tronNumericChainID("tron:localnet", map[string]int64{"localnet": bad})
		requireTronChainIDError(t, err, `the Tron chain id supplied for cluster "localnet" is not an integer in 1..4294967295`)
	}
}

// Cluster names come from the request; both bindings must quote the same bytes so a caller
// cannot close the cluster field or forge the rest of the diagnostic.
func TestTronNumericChainIDErrorQuotesSuppliedCluster(t *testing.T) {
	for _, tc := range []struct{ cluster, quoted string }{
		{`local"quote`, `"local\"quote"`},
		{`local\slash`, `"local\\slash"`},
		{"local\nline", `"local\u000aline"`},
	} {
		_, err := tronNumericChainID("tron:"+tc.cluster, map[string]int64{tc.cluster: 0})
		requireTronChainIDError(t, err, fmt.Sprintf("the Tron chain id supplied for cluster %s is not an integer in 1..4294967295", tc.quoted))

		_, err = tronNumericChainID("tron:"+tc.cluster, map[string]int64{tc.cluster: 728126428})
		requireTronChainIDError(t, err, fmt.Sprintf("the Tron chain id supplied for cluster %s is 728126428, which the built-in table gives cluster \"mainnet\"", tc.quoted))
	}
}

// The namespace, segment and exact-key rules hold when ids are supplied. TS asserts the same inputs.
func TestTronNumericChainIDSuppliedKeepsNetworkRules(t *testing.T) {
	supplied := map[string]int64{"localnet": 3360022319, "": 5}
	_, err := tronNumericChainID("eip155:localnet", supplied)
	require.ErrorContains(t, err, "expected a tron network")
	_, err = tronNumericChainID("tron:localnet:extra", supplied)
	require.ErrorContains(t, err, "unsupported Tron network")
	// An empty cluster names no network, even when an entry is keyed by the empty string.
	_, err = tronNumericChainID("tron:", supplied)
	require.ErrorContains(t, err, "unsupported Tron network")
}

func TestResolveTronPermit2(t *testing.T) {
	addr, err := resolveTronPermit2("tron:mainnet")
	require.NoError(t, err)
	require.Equal(t, "TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m", addr)

	addr, err = resolveTronPermit2("tron:shasta")
	require.NoError(t, err)
	require.Equal(t, "TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp", addr)

	_, err = resolveTronPermit2("tron:unknown")
	require.Error(t, err)
}

// TestClusterIDFromName mirrors the TS clusterIdFromName: UTF-8 bytes right-padded to
// 32, error when longer than 32 bytes.
func TestClusterIDFromName(t *testing.T) {
	id, err := clusterIDFromName("devnet")
	require.NoError(t, err)
	require.Equal(t, []byte("devnet"), id[:6])
	require.Equal(t, make([]byte, 26), id[6:], "remaining bytes are zero-padded")

	// Exactly 32 bytes is allowed.
	exact := strings.Repeat("a", 32)
	id, err = clusterIDFromName(exact)
	require.NoError(t, err)
	require.Equal(t, []byte(exact), id[:])

	// 33 bytes errors.
	_, err = clusterIDFromName(strings.Repeat("a", 33))
	require.Error(t, err)
}

// TestResolvePermitDeadline: an explicit absolute deadline is echoed back verbatim. There
// is deliberately no fallback — the calling layer must supply it (from fulfillment_deadline).
func TestResolvePermitDeadline(t *testing.T) {
	require.Equal(t, "1924991999", resolvePermitDeadline(big.NewInt(1924991999)).String())
}

// TestResolvePermitNonce: an explicit nonce is echoed back. There is deliberately no random
// fallback (a random nonce is not retry-safe); one-shot randomness is the caller's explicit
// opt-in via GeneratePermitNonce.
func TestResolvePermitNonce(t *testing.T) {
	explicit := resolvePermitNonce(bigIntFromString(t, "123"))
	require.Equal(t, "123", explicit.String())

	a := GeneratePermitNonce()
	b := GeneratePermitNonce()
	require.NotEqual(t, a.String(), b.String(), "explicitly-generated nonces are unique")
}

// TestAssertAmountMatches: numeric equality (leading-zero / big-value tolerant); any
// mismatch or unparseable input is the uniform amount-mismatch error.
func TestAssertAmountMatches(t *testing.T) {
	require.NoError(t, assertAmountMatches("1000000", "1000000"))
	require.ErrorContains(t, assertAmountMatches("1000000", "999"), "permit amount does not match max_source_amount")
	require.ErrorContains(t, assertAmountMatches("not-a-number", "1000000"), "permit amount does not match max_source_amount")
	// One spelling per amount: no sign, prefix, padding, whitespace or leading zero.
	for _, spelled := range []string{"", "0123", "+123", "0x7b", " 123", "123 ", "1_23"} {
		require.ErrorContains(t, assertAmountMatches("123", spelled), "max_source_amount is not a decimal integer string", "%q", spelled)
	}
	require.ErrorContains(t, assertAmountMatches("0123", "123"), "permit amount does not match max_source_amount")
}

// TestAssertFresh: the permit deadline must be strictly in the future.
func TestAssertFresh(t *testing.T) {
	require.NoError(t, assertFresh(1000, 999))
	require.ErrorContains(t, assertFresh(1000, 1000), "permit deadline is not in the future")
	require.ErrorContains(t, assertFresh(1000, 1001), "permit deadline is not in the future")
}

// TestAssetAddress mirrors the TS parseSourceAsset rows: exactly two segments on each separator,
// neither empty.
func TestAssetAddress(t *testing.T) {
	addr, err := assetAddress("eip155:1/erc20:0x5555555555555555555555555555555555555555")
	require.NoError(t, err)
	require.Equal(t, "0x5555555555555555555555555555555555555555", addr)

	for _, identifier := range []string{
		"eip155:1//erc20:0x5555555555555555555555555555555555555555",
		"eip155:1/erc20::0x5555555555555555555555555555555555555555",
		"eip155:1/erc20:0x5555555555555555555555555555555555555555:0x6666666666666666666666666666666666666666",
		"eip155:1/erc20:",
		"eip155:1/erc20",
		"eip155:1",
		"/erc20:0x1",
		"eip155:1/:0x5555555555555555555555555555555555555555",
		"",
	} {
		_, err = assetAddress(identifier)
		require.ErrorContains(t, err, "invalid source asset", identifier)
		require.ErrorContains(t, err, identifier, "the message names the offending identifier")
	}

	// The CAIP-19 token-id form. The wire schema permits it, this flow cannot bind it, so it is
	// refused by name rather than read as a plain address. TS asserts the same input.
	_, err = assetAddress("eip155:1/erc721:0x06012c8cf97BEaD5deAe237070F9587f8E7A266d/771769")
	require.ErrorContains(t, err, "names a token id")
}
