package chainaddress_test

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	chainaddress "github.com/atum-labs/protocol/schemas/declarations/common/chain-address/go"
)

// vectorsPath is the language-neutral oracle both halves read.
const vectorsPath = "../vectors.json"

type acceptCase struct {
	Name     string `json:"name"`
	Network  string `json:"network"`
	Account  string `json:"account"`
	BytesHex string `json:"bytesHex"`
	Kind     string `json:"kind,omitempty"`
}

type rejectCase struct {
	Name    string `json:"name"`
	Network string `json:"network"`
	Account string `json:"account"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type vectors struct {
	Comment string       `json:"_comment"`
	Accept  []acceptCase `json:"accept"`
	Reject  []rejectCase `json:"reject"`
}

// inputs is the authored corpus. Expectations are derived from the implementation by the
// regenerator below and then reviewed, so the checked-in file is what both languages assert.
var inputs = []struct{ name, network, account string }{
	{"shared/empty", "eip155:1", ""},
	{"shared/whitespace-only", "eip155:1", "   "},
	{"shared/leading-space", "eip155:1", " 0x90f79bf6eb2c4f870365e785982e1f101e93b906"},
	{"shared/trailing-newline", "eip155:1", "0x90f79bf6eb2c4f870365e785982e1f101e93b906\n"},
	{"shared/internal-space", "eip155:1", "0x90f79bf6eb2c4f870365e785982e1f1 1e93b906"},
	{"shared/unsupported-namespace", "bip122:000000000019d6689c085ae165831e93", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"},
	{"shared/no-namespace-separator", "eip155", "0x90f79bf6eb2c4f870365e785982e1f101e93b906"},
	// The two platform trims differ in exactly these two characters, so before the shared set the
	// REASON diverged even though both halves rejected: Go read the byte order mark as part of the
	// address and JavaScript read U+0085 that way. A byte order mark is what a receiver pasted out of
	// a UTF-8 file looks like, so the message it gets matters.
	{"shared/leading-bom", "eip155:1", "\ufeff0x90f79bf6eb2c4f870365e785982e1f101e93b906"},
	{"shared/trailing-nel", "eip155:1", "0x90f79bf6eb2c4f870365e785982e1f101e93b906\u0085"},
	{"shared/bom-only", "eip155:1", "\ufeff"},
	{"shared/nel-only", "eip155:1", "\u0085"},
	// Both halves already trimmed this one, and the union keeps it that way.
	{"shared/leading-nbsp", "eip155:1", "\u00a00x90f79bf6eb2c4f870365e785982e1f101e93b906"},

	{"evm/lowercase", "eip155:42161", "0x90f79bf6eb2c4f870365e785982e1f101e93b906"},
	{"evm/uppercase-body", "eip155:42161", "0x90F79BF6EB2C4F870365E785982E1F101E93B906"},
	{"evm/checksummed", "eip155:42161", "0x90F79bf6EB2c4f870365E785982E1f101E93b906"},
	{"evm/bad-checksum", "eip155:42161", "0x90f79Bf6EB2c4f870365E785982E1f101E93b906"},
	// The two spellings where ethers and go-ethereum disagree, so the TypeScript half must not
	// delegate to getAddress. Pinned here on purpose.
	{"evm/uppercase-0X-prefix-lowercase-body", "eip155:42161", "0X90f79bf6eb2c4f870365e785982e1f101e93b906"},
	{"evm/bare-hex-checksummed", "eip155:42161", "90F79bf6EB2c4f870365E785982E1f101E93b906"},
	{"evm/bare-hex-lowercase", "eip155:42161", "90f79bf6eb2c4f870365e785982e1f101e93b906"},
	{"evm/too-short", "eip155:42161", "0x90f79bf6eb2c4f870365e785982e1f101e93b90"},
	{"evm/too-long", "eip155:42161", "0x90f79bf6eb2c4f870365e785982e1f101e93b9066"},
	{"evm/non-hex", "eip155:42161", "0xz0f79bf6eb2c4f870365e785982e1f101e93b906"},
	{"evm/zero", "eip155:42161", "0x0000000000000000000000000000000000000000"},

	{"solana/base58", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"},
	{"solana/hex-form-refused", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61"},
	{"solana/base64-form-refused", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWE="},
	{"solana/short-decode", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "11111111111111111111111111111"},
	{"solana/zero", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "11111111111111111111111111111111"},

	{"tron/base58", "tron:mainnet", "TYaKH9ApqbdftVGSnTMPVL9kp1S5AQBQSs"},
	{"tron/base58-bad-checksum", "tron:mainnet", "TYaKH9ApqbdftVGSnTMPVL9kp1S5AQBQSt"},
	{"tron/prefixed-hex-lowercase", "tron:mainnet", "0x41f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f"},
	// Accepted here on purpose: the lowercase-0x rule is one settler's payout form, not an
	// address rule, so it stays with the service that enforces it.
	{"tron/prefixed-hex-uppercase-0X", "tron:mainnet", "0X41f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f"},
	// The prefixed-hex branch checks length and never the character set, so the TypeScript half used
	// to hand these to a lenient parseInt: it stops at the first unreadable character and its NaN
	// becomes a zero byte, so the account was ACCEPTED with bytes that were not the caller's. Go
	// always rejected them. Three spellings, because any non-hex byte does it, not just letters.
	{"tron/prefixed-hex-non-hex-body", "tron:mainnet", "0x41f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6ezz"},
	{"tron/prefixed-hex-partial-hex-body", "tron:mainnet", "0x41f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7g"},
	{"tron/prefixed-hex-sign-in-body", "tron:mainnet", "0x41+1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f"},
	{"tron/evm-hex-form", "tron:mainnet", "0xf1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f"},
	{"tron/bare-hex", "tron:mainnet", "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f"},
	{"tron/zero", "tron:mainnet", "0x410000000000000000000000000000000000000000"},

	// The reference is not read (only the namespace is), so both networks take the same accounts.
	{"stellar/account-pubnet", "stellar:pubnet", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH"},
	{"stellar/account-testnet", "stellar:testnet", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH"},
	{"stellar/contract-pubnet", "stellar:pubnet", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5"},
	{"stellar/contract-testnet", "stellar:testnet", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5"},
	// The same 32 bytes as GA5WUJ54..., as a contract: equal Bytes(), different accounts, so the kind is
	// what tells them apart.
	{"stellar/contract-with-the-bytes-of-an-account", "stellar:pubnet", "CA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTO56"},
	{"stellar/account-bad-checksum", "stellar:pubnet", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYG"},
	{"stellar/contract-bad-checksum", "stellar:pubnet", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE6"},
	{"stellar/account-lowercase", "stellar:pubnet", "ga5wuj54z23killcuounaktpbvzwkmqvo4o6eq5ghlaerimllhncskyh"},
	{"stellar/non-base32-character", "stellar:pubnet", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSK1H"},
	{"stellar/too-short", "stellar:pubnet", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKY"},
	{"stellar/too-long", "stellar:pubnet", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYHH"},
	// CAP-84 (Protocol 30): a muxed contract is not a payable account here, and the base contract it
	// wraps must not be paid in its place. Valid W strkey, so the checksum is not what refuses it.
	{"stellar/muxed-contract-refused", "stellar:pubnet", "WADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4RQG"},
	// Valid strkeys of other types, each refused for its version byte rather than its checksum.
	{"stellar/muxed-account-refused", "stellar:pubnet", "MADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA6OSU"},
	{"stellar/s-prefixed-string-refused", "stellar:pubnet", "SA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTOLY"},
	{"stellar/hash-refused", "stellar:pubnet", "XA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSTPP"},
	// A 55-character strkey carrying a VALID checksum over a 31-byte payload. Go's base32 decoder drops
	// \r and \n, so one embedded newline makes it 56 characters and, without an alphabet check, a
	// 31-byte payload with no error. Only the character check refuses these, whatever the position.
	{"stellar/account-31-byte-payload-newline-middle", "stellar:pubnet", "GA5WUJ54Z23KILLCUOUN\nAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ"},
	{"stellar/account-31-byte-payload-carriage-return-middle", "stellar:pubnet", "GA5WUJ54Z23KILLCUOUN\rAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ"},
	{"stellar/account-31-byte-payload-newline-then-carriage-return", "stellar:pubnet", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKM\r\nQVO4O6EQ5GHLAERIMLLHNL4ZQ"},
	{"stellar/account-31-byte-payload-space-middle", "stellar:pubnet", "GA5WU J54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ"},
	{"stellar/account-31-byte-payload-newline-trailing", "stellar:pubnet", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ\n"},
	{"stellar/account-31-byte-payload-newline-leading", "stellar:pubnet", "\nGA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ"},
	{"stellar/account-31-byte-payload-unpadded", "stellar:pubnet", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ"},
	{"stellar/contract-31-byte-payload-newline-middle", "stellar:pubnet", "CA5WUJ54Z23KILLCUOUN\nAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNBL7Y"},
	// Valid strkeys of other types, refused for the version byte alone.
	{"stellar/t-prefixed-string-refused", "stellar:pubnet", "TA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTXKW"},
	{"stellar/signed-payload-refused", "stellar:pubnet", "PA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSAAAAACACAQDATGQY"},
	// Muxed contract and muxed account built to the SDK's own encoding, so their checksums are good.
	{"stellar/muxed-contract-valid-crc-refused", "stellar:pubnet", "WA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSAAAAAAAAAAAAC4AS"},
	{"stellar/muxed-account-valid-crc-refused", "stellar:pubnet", "MA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSAAAAAAAAAAAAADCA"},
	{"stellar/zero-account", "stellar:pubnet", "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"},
	{"stellar/zero-contract", "stellar:pubnet", "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"},

	{"cross/evm-address-on-stellar", "stellar:pubnet", "0x90f79bf6eb2c4f870365e785982e1f101e93b906"},
	{"cross/solana-address-on-stellar", "stellar:pubnet", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"},
	{"cross/stellar-address-on-solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH"},
	{"cross/stellar-address-on-evm", "eip155:1", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH"},

	{"cross/evm-address-on-solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "0x90f79bf6eb2c4f870365e785982e1f101e93b906"},
	{"cross/solana-address-on-evm", "eip155:1", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"},
}

const vectorsComment = "FROZEN cross-language vectors for chain-address. Both go/parity_test.go and " +
	"typescript/src/parity.test.ts assert against this file, so an expectation may only change when " +
	"both implementations change with it. Regenerate with REGEN_VECTORS=1 go test ./... -run " +
	"TestRegenerateVectors in go/, then verify with a separate go test ./... and the TypeScript suite."

func TestVectorParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(vectorsPath))
	require.NoError(t, err, "vectors.json must exist; regenerate with REGEN_VECTORS=1")
	var doc vectors
	require.NoError(t, json.Unmarshal(raw, &doc))
	require.NotEmpty(t, doc.Accept)
	require.NotEmpty(t, doc.Reject)

	for _, want := range doc.Accept {
		t.Run("accept/"+want.Name, func(t *testing.T) {
			got, err := chainaddress.Validate(want.Network, want.Account)
			require.NoError(t, err)
			require.Equal(t, want.BytesHex, hex.EncodeToString(got.Bytes()), "canonical bytes")
			require.Equal(t, chainaddress.Kind(want.Kind), got.Kind(), "kind")
		})
	}

	for _, want := range doc.Reject {
		t.Run("reject/"+want.Name, func(t *testing.T) {
			_, err := chainaddress.Validate(want.Network, want.Account)
			require.Error(t, err)
			require.ErrorIs(t, err, chainaddress.ErrInvalidAccount)
			require.Equal(t, want.Reason, string(chainaddress.ReasonOf(err)), "reason")
			require.Equal(t, want.Message, err.Error(), "message")
		})
	}
}

// TestStellarRejectionCauses pins WHY each Stellar refusal fires. The vectors pin only the reason and
// the message, and both are the same for every UNPARSEABLE input, so a muxed contract refused for
// the wrong cause (say, a checksum slip in the vector) would still pass them. The wording is the
// Stellar escrow-encoding decoder's, which this package calls; the decoder's own tests pin the error
// class for every case in the shared strkey-vectors.json.
func TestStellarRejectionCauses(t *testing.T) {
	cases := []struct{ name, account, detail string }{
		{"muxed contract", "WADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4RQG", "not an account or contract address"},
		{"muxed account", "MADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA6OSU", "unsupported address type"},
		{"S-prefixed string", "SA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTOLY", "not an account or contract address"},
		{"hash", "XA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSTPP", "not an account or contract address"},
		{"account checksum", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYG", "bad checksum"},
		{"contract checksum", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE6", "bad checksum"},
		{"lowercase", "ga5wuj54z23killcuounaktpbvzwkmqvo4o6eq5ghlaerimllhncskyh", "upper-case base32"},
		{"newline in a valid 31-byte payload", "GA5WUJ54Z23KILLCUOUN\nAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ", "upper-case base32"},
		{"carriage return in a valid 31-byte payload", "GA5WUJ54Z23KILLCUOUN\rAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ", "upper-case base32"},
		{"contract with a newline in a valid 31-byte payload", "CA5WUJ54Z23KILLCUOUN\nAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNBL7Y", "upper-case base32"},
		{"T-prefixed string", "TA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTXKW", "not an account or contract address"},
		{"signed payload", "PA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSAAAAACACAQDATGQY", "not an account or contract address"},
		{"muxed contract with a valid checksum", "WA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSAAAAAAAAAAAAC4AS", "not an account or contract address"},
		{"muxed account with a valid checksum", "MA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSAAAAAAAAAAAAADCA", "unsupported address type"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := chainaddress.Validate("stellar:pubnet", c.account)
			var invalid *chainaddress.Error
			require.ErrorAs(t, err, &invalid)
			require.Equal(t, chainaddress.ReasonUnparseable, invalid.Reason)
			require.Contains(t, invalid.Detail, c.detail)
		})
	}
}

// TestVectorsCoverEveryInput refuses a corpus that no longer matches the authored inputs, in both
// directions. Adding an input without regenerating leaves it inert while the author believes it runs,
// and deleting a case from the file by hand is otherwise silent, since the reason it covered is
// usually pinned by some other vector too. The file presents itself as frozen, so shrinking it should
// be loud rather than an escape hatch for whoever is facing a red parity test.
func TestVectorsCoverEveryInput(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(vectorsPath))
	require.NoError(t, err)
	var doc vectors
	require.NoError(t, json.Unmarshal(raw, &doc))

	inFile := map[string]bool{}
	for _, c := range doc.Accept {
		inFile[c.Name] = true
	}
	for _, c := range doc.Reject {
		inFile[c.Name] = true
	}

	authored := map[string]bool{}
	for _, in := range inputs {
		authored[in.name] = true
		require.True(t, inFile[in.name],
			"input %s has no vector, so it never runs: regenerate with REGEN_VECTORS=1", in.name)
	}
	for name := range inFile {
		require.True(t, authored[name],
			"vector %s is not an authored input, so it was added by hand or an input was removed", name)
	}
	require.Len(t, inFile, len(inputs), "every authored input must appear exactly once")
}

// TestVectorsCoverEveryReason keeps a new rule from landing unpinned.
func TestVectorsCoverEveryReason(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(vectorsPath))
	require.NoError(t, err)
	var doc vectors
	require.NoError(t, json.Unmarshal(raw, &doc))

	seen := map[string]bool{}
	for _, c := range doc.Reject {
		seen[c.Reason] = true
	}
	// chainaddress.Reasons(), not a list restated here, so this cannot pass by only checking the
	// reasons it was already told about. Same shape as the namespace half below.
	for _, reason := range chainaddress.Reasons() {
		require.True(t, seen[string(reason)], "no vector pins reason %s", reason)
	}

	namespaces := map[string]bool{}
	for _, c := range doc.Accept {
		ns, _, _ := splitNamespace(c.Network)
		namespaces[ns] = true
	}
	for _, ns := range chainaddress.SupportedNamespaces() {
		require.True(t, namespaces[ns], "no accept vector for namespace %s", ns)
	}
}

func splitNamespace(network string) (string, string, bool) {
	for i := 0; i < len(network); i++ {
		if network[i] == ':' {
			return network[:i], network[i+1:], true
		}
	}
	return network, "", false
}

// TestRegenerateVectors rewrites the corpus from the current implementation. Skipped unless asked
// for, and deliberately separate from TestVectorParity so the two can never run as one act.
//
// They used to share an invocation, which made the assertion a tautology on the one command the
// corpus told you to run when the parity test failed: regenerating rewrote the file from whatever the
// code now did and then asserted the code against it. Verified on a real regression: removing the
// checksum rule fails the parity test, then the old recovery command went green and quietly moved
// two checksum cases from reject to accept. The reason coverage test only catches that when a
// regression removes the last vector for a whole reason, so it was not a reliable backstop.
//
// Recover with two commands, in this order:
//
//	REGEN_VECTORS=1 go test ./... -run TestRegenerateVectors
//	go test ./...    # and the TypeScript half, which reads the same file
func TestRegenerateVectors(t *testing.T) {
	if os.Getenv("REGEN_VECTORS") != "1" {
		t.Skip("set REGEN_VECTORS=1 to rewrite vectors.json, then verify with a separate run")
	}
	regenerate(t)
}

func regenerate(t *testing.T) {
	t.Helper()
	doc := vectors{Comment: vectorsComment}
	for _, in := range inputs {
		parsed, err := chainaddress.Validate(in.network, in.account)
		if err != nil {
			doc.Reject = append(doc.Reject, rejectCase{
				Name:    in.name,
				Network: in.network,
				Account: in.account,
				Reason:  string(chainaddress.ReasonOf(err)),
				Message: err.Error(),
			})
			continue
		}
		doc.Accept = append(doc.Accept, acceptCase{
			Name:     in.name,
			Network:  in.network,
			Account:  in.account,
			BytesHex: hex.EncodeToString(parsed.Bytes()),
			Kind:     string(parsed.Kind()),
		})
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Clean(vectorsPath), append(out, '\n'), 0o644))
}

// strkeyVectorsPath is the one strkey vector file every Stellar strkey decoder in the repo is tested
// against. chain-address no longer carries its own decoder; this proves the delegation keeps every
// case's outcome, so a fix to the shared decoder cannot be undone here without a red test.
const strkeyVectorsPath = "../../../../../contracts/stellar/conformance/strkey-vectors.json"

func TestStellarSharedStrkeyVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(strkeyVectorsPath))
	require.NoError(t, err)
	var doc struct {
		Valid []struct {
			Name       string `json:"name"`
			Address    string `json:"address"`
			PayloadHex string `json:"payloadHex"`
		} `json:"valid"`
		Invalid []struct {
			Name    string `json:"name"`
			Address string `json:"address"`
		} `json:"invalid"`
	}
	require.NoError(t, json.Unmarshal(raw, &doc))
	require.NotEmpty(t, doc.Valid)
	require.NotEmpty(t, doc.Invalid)

	for _, want := range doc.Valid {
		t.Run("accept/"+want.Name, func(t *testing.T) {
			// Parse, not Validate: the all-zero account is a valid strkey and is refused only by the
			// zero-address rule.
			got, err := chainaddress.Parse("stellar:pubnet", want.Address)
			require.NoError(t, err)
			require.Equal(t, want.PayloadHex, hex.EncodeToString(got.Bytes()))
		})
	}
	for _, want := range doc.Invalid {
		t.Run("reject/"+want.Name, func(t *testing.T) {
			_, err := chainaddress.Parse("stellar:pubnet", want.Address)
			require.ErrorIs(t, err, chainaddress.ErrInvalidAccount)
			// Whitespace and emptiness are refused before the strkey is read, with their own reasons.
			require.Contains(t,
				[]chainaddress.Reason{chainaddress.ReasonUnparseable, chainaddress.ReasonEmpty, chainaddress.ReasonSurroundingWhitespace},
				chainaddress.ReasonOf(err))
		})
	}
}

// A G account and a C contract with the same 32 bytes parse to equal Bytes(), so Kind is the only
// thing that tells them apart. The vectors pin each one's kind; this pins that the pair collides.
func TestStellarKindSeparatesAccountFromContractWithEqualBytes(t *testing.T) {
	account, err := chainaddress.Validate("stellar:pubnet", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH")
	require.NoError(t, err)
	contract, err := chainaddress.Validate("stellar:pubnet", "CA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTO56")
	require.NoError(t, err)

	require.Equal(t, account.Bytes(), contract.Bytes())
	require.Equal(t, chainaddress.KindAccount, account.Kind())
	require.Equal(t, chainaddress.KindContract, contract.Kind())

	evm, err := chainaddress.Validate("eip155:1", "0x90f79bf6eb2c4f870365e785982e1f101e93b906")
	require.NoError(t, err)
	require.Equal(t, chainaddress.Kind(""), evm.Kind(), "a namespace with one account kind reports none")
}
