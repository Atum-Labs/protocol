package verifill

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
)

// specVerdictPatterns reads every property pattern of a verdict schema from openapi.yaml as
// text, so the package's copy cannot drift from the spec unnoticed.
func specVerdictPatterns(t *testing.T, schema string) map[string]string {
	t.Helper()
	f, err := os.Open(filepath.Join("..", "..", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var (
		inSchema bool
		property string
		out      = map[string]string{}
	)
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		line := scan.Text()
		switch {
		case line == "    "+schema+":":
			inSchema = true
		case inSchema && strings.HasPrefix(line, "    ") && !strings.HasPrefix(line, "     ") && strings.HasSuffix(line, ":"):
			return out
		case inSchema && strings.HasPrefix(line, "        ") && !strings.HasPrefix(line, "         ") && strings.HasSuffix(line, ":"):
			property = strings.TrimSuffix(strings.TrimSpace(line), ":")
		case inSchema && strings.HasPrefix(line, "          pattern: "):
			out[property] = strings.Trim(strings.TrimPrefix(line, "          pattern: "), "'")
		}
	}
	if len(out) == 0 {
		t.Fatalf("%s patterns not found in openapi.yaml", schema)
	}
	return out
}

func TestVerdictPatternsMatchTheSpec(t *testing.T) {
	spec := specVerdictPatterns(t, "FulfillmentVerdict")
	ours := map[string]string{}
	for k, v := range verdictMemberPatterns {
		ours[k] = v
	}
	for k, v := range verdictEnvelopePatterns {
		ours[k] = v
	}
	// outcome is an enum in the spec rather than a pattern, so it is checked against that enum.
	delete(ours, "outcome")
	for k, want := range spec {
		if got, ok := ours[k]; !ok || got != want {
			t.Errorf("%s: package pattern %q, spec pattern %q", k, got, want)
		}
	}
	for k := range ours {
		if _, ok := spec[k]; !ok {
			t.Errorf("%s: package declares a pattern the spec does not", k)
		}
	}
	enum := specPropertyEnum(t, "FulfillmentVerdict", "outcome")
	for _, o := range enum {
		if !verdictMemberRegexps["outcome"].MatchString(o) {
			t.Errorf("outcome pattern rejects the spec value %q", o)
		}
	}
	if got := strings.Count(strings.Trim(verdictMemberPatterns["outcome"], "^()$"), "|") + 1; got != len(enum) {
		t.Errorf("outcome pattern admits %d values, the spec enum has %d: %v", got, len(enum), enum)
	}
}

func signedTestVerdict(t *testing.T, priv *secp256k1.PrivateKey) *FulfillmentVerdict {
	t.Helper()
	v := &FulfillmentVerdict{
		Domain:          "did:web:atum.network",
		PaymentId:       "0x" + strings.Repeat("1", 64),
		ChainId:         "eip155:42161",
		Outcome:         FulfillmentVerdictOutcomeDelivered,
		BlockNumber:     "21500000",
		BlockHash:       "0x" + strings.Repeat("a", 64),
		FinalityPolicy:  "confirmations:64",
		TransactionHash: "0x" + strings.Repeat("b", 64),
		Fulfiller:       "0x" + strings.Repeat("c", 40),
		SignatureScheme: VerdictSignatureSchemeEip712Secp256k1,
	}
	digest, err := VerdictSigningDigest(v)
	if err != nil {
		t.Fatal(err)
	}
	v.Signature = signSecp256k1(t, priv, digest)
	return v
}

func TestVerdictSigningDigestVerifies(t *testing.T) {
	priv, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	v := signedTestVerdict(t, priv)
	if err := VerifyVerdictSignature(v, evmAddressOf(priv)); err != nil {
		t.Fatalf("a verdict signed over VerdictSigningDigest did not verify: %v", err)
	}

	crossed := *v
	crossed.SignatureScheme = VerdictSignatureSchemeTip191Secp256k1
	if _, err := VerdictSigningDigest(&crossed); err == nil {
		t.Error("a scheme the chain does not admit produced a digest")
	}
}

func TestValidateVerdictMembers(t *testing.T) {
	priv, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	valid := signedTestVerdict(t, priv)
	if err := ValidateVerdictMembers(valid); err != nil {
		t.Fatalf("a valid verdict was rejected: %v", err)
	}

	cases := map[string]func(v *FulfillmentVerdict){
		"EIP-55 fulfiller":          func(v *FulfillmentVerdict) { v.Fulfiller = "0x" + strings.Repeat("C", 40) },
		"uppercase block hash":      func(v *FulfillmentVerdict) { v.BlockHash = "0x" + strings.Repeat("A", 64) },
		"bare tron transaction id":  func(v *FulfillmentVerdict) { v.TransactionHash = strings.Repeat("ab", 32) },
		"base58 block hash":         func(v *FulfillmentVerdict) { v.BlockHash = strings.Repeat("A", 44) },
		"tron fulfiller":            func(v *FulfillmentVerdict) { v.Fulfiller = "T" + strings.Repeat("A", 33) },
		"scanner finality string":   func(v *FulfillmentVerdict) { v.FinalityPolicy = "finalized_block>=21500000" },
		"delivered without tx":      func(v *FulfillmentVerdict) { v.TransactionHash = "" },
		"not_delivered with tx":     func(v *FulfillmentVerdict) { v.Outcome = FulfillmentVerdictOutcomeNotDelivered },
		"scheme the chain refuses":  func(v *FulfillmentVerdict) { v.SignatureScheme = VerdictSignatureSchemeEd25519Raw },
		"ed25519 length on eip155":  func(v *FulfillmentVerdict) { v.Signature = v.Signature[:128] },
		"empty signature":           func(v *FulfillmentVerdict) { v.Signature = "" },
		"mixed-case payment id":     func(v *FulfillmentVerdict) { v.PaymentId = "0x" + strings.Repeat("A", 64) },
		"uppercase chain namespace": func(v *FulfillmentVerdict) { v.ChainId = "EIP155:42161" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			v := *valid
			mutate(&v)
			if err := ValidateVerdictMembers(&v); err == nil {
				t.Error("an invalid verdict was accepted")
			}
		})
	}
	if err := ValidateVerdictMembers(nil); err == nil {
		t.Error("a nil verdict was accepted")
	}
	outcome := *valid
	outcome.Outcome = "delivered_x"
	if err := ValidateVerdictMembers(&outcome); err == nil {
		t.Error("an outcome outside the enum was accepted")
	}
}

// Each family admits its own encodings and refuses another's. The signature is not under test
// here, so each verdict carries a placeholder of the length its scheme requires.
func TestVerdictFamilyEncodings(t *testing.T) {
	tron := FulfillmentVerdict{
		Domain: "did:web:atum.network", PaymentId: "0x" + strings.Repeat("1", 64), ChainId: "tron:mainnet",
		Outcome: FulfillmentVerdictOutcomeDelivered, BlockNumber: "7", BlockHash: "0x" + strings.Repeat("a", 64),
		FinalityPolicy: "confirmations:19", TransactionHash: "0x" + strings.Repeat("b", 64),
		Fulfiller: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", SignatureScheme: VerdictSignatureSchemeTip191Secp256k1,
		Signature: strings.Repeat("ab", 65),
	}
	solana := FulfillmentVerdict{
		Domain: "did:web:atum.network", PaymentId: "0x" + strings.Repeat("1", 64),
		ChainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", Outcome: FulfillmentVerdictOutcomeDelivered,
		BlockNumber: "7", BlockHash: "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn",
		FinalityPolicy:  "commitment:finalized",
		TransactionHash: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
		Fulfiller:       "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", SignatureScheme: VerdictSignatureSchemeEd25519Raw,
		Signature: strings.Repeat("ab", 64),
	}
	for name, v := range map[string]FulfillmentVerdict{"tron": tron, "solana": solana} {
		if err := ValidateVerdictMembers(&v); err != nil {
			t.Errorf("a valid %s verdict was rejected: %v", name, err)
		}
	}
	cases := map[string]FulfillmentVerdict{
		"evm fulfiller on tron":    func(v FulfillmentVerdict) FulfillmentVerdict { v.Fulfiller = "0x" + strings.Repeat("c", 40); return v }(tron),
		"base58 hash on tron":      func(v FulfillmentVerdict) FulfillmentVerdict { v.BlockHash = strings.Repeat("A", 44); return v }(tron),
		"hex block hash on solana": func(v FulfillmentVerdict) FulfillmentVerdict { v.BlockHash = "0x" + strings.Repeat("a", 64); return v }(solana),
		"evm fulfiller on solana":  func(v FulfillmentVerdict) FulfillmentVerdict { v.Fulfiller = "0x" + strings.Repeat("c", 40); return v }(solana),
		// Right alphabet and length, wrong bytes: only the decoded checks catch these.
		"tron fulfiller with a bad checksum": func(v FulfillmentVerdict) FulfillmentVerdict {
			v.Fulfiller = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU8"
			return v
		}(tron),
		"solana block hash of 33 bytes": func(v FulfillmentVerdict) FulfillmentVerdict { v.BlockHash = strings.Repeat("z", 45); return v }(solana),
		"solana transaction hash of 32 bytes": func(v FulfillmentVerdict) FulfillmentVerdict {
			v.TransactionHash = solana.BlockHash
			return v
		}(solana),
		"solana fulfiller of 33 bytes": func(v FulfillmentVerdict) FulfillmentVerdict { v.Fulfiller = strings.Repeat("z", 44); return v }(solana),
	}
	for name, v := range cases {
		t.Run(name, func(t *testing.T) {
			if err := ValidateVerdictMembers(&v); err == nil {
				t.Error("a value in another family's encoding was accepted")
			}
		})
	}
}

// specPropertyEnum reads the enum of one property of a component schema from openapi.yaml as
// text, and fails rather than return an empty set.
func specPropertyEnum(t *testing.T, schema, property string) []string {
	t.Helper()
	f, err := os.Open(filepath.Join("..", "..", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var (
		inSchema, inProperty, inEnum bool
		values                       []string
	)
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		line := scan.Text()
		switch {
		case line == "    "+schema+":":
			inSchema = true
		case inSchema && strings.HasPrefix(line, "    ") && !strings.HasPrefix(line, "     ") && strings.HasSuffix(line, ":"):
			inSchema = false
		case inSchema && line == "        "+property+":":
			inProperty = true
		case inProperty && line == "          enum:":
			inEnum = true
		case inEnum && strings.HasPrefix(line, "            - "):
			values = append(values, strings.TrimPrefix(line, "            - "))
		case inEnum:
			if len(values) == 0 {
				t.Fatalf("%s.%s: the enum has no values", schema, property)
			}
			return values
		}
	}
	t.Fatalf("%s.%s: no enum found in openapi.yaml", schema, property)
	return nil
}

func TestDepositVerdictPatternsMatchTheSpec(t *testing.T) {
	spec := specVerdictPatterns(t, "DepositVerdict")
	ours := map[string]string{}
	for k, v := range depositVerdictMemberPatterns {
		ours[k] = v
	}
	for k, v := range verdictEnvelopePatterns {
		ours[k] = v
	}
	// outcome is an enum in the spec rather than a pattern, so it is checked against that enum.
	delete(ours, "outcome")
	for k, want := range spec {
		if got, ok := ours[k]; !ok || got != want {
			t.Errorf("%s: package pattern %q, spec pattern %q", k, got, want)
		}
	}
	for k := range ours {
		if _, ok := spec[k]; !ok {
			t.Errorf("%s: package declares a pattern the spec does not", k)
		}
	}
	enum := specPropertyEnum(t, "DepositVerdict", "outcome")
	for _, o := range enum {
		if !depositVerdictMemberRegexps["outcome"].MatchString(o) {
			t.Errorf("outcome pattern rejects the spec value %q", o)
		}
	}
	if got := strings.Count(strings.Trim(depositVerdictMemberPatterns["outcome"], "^()$"), "|") + 1; got != len(enum) {
		t.Errorf("outcome pattern admits %d values, the spec enum has %d: %v", got, len(enum), enum)
	}
}

func signedTestDepositVerdict(t *testing.T, priv *secp256k1.PrivateKey) *DepositVerdict {
	t.Helper()
	v := &DepositVerdict{
		Domain:          "did:web:atum.network",
		PaymentId:       "0x" + strings.Repeat("1", 64),
		ChainId:         "eip155:8453",
		EscrowAddress:   "0x" + strings.Repeat("e", 40),
		Outcome:         DepositVerdictOutcomeHeld,
		BlockNumber:     "1200",
		BlockHash:       "0x" + strings.Repeat("a", 64),
		FinalityPolicy:  "confirmations:40",
		TransactionHash: "0x" + strings.Repeat("d", 64),
		SignatureScheme: VerdictSignatureSchemeEip712Secp256k1,
	}
	digest, err := DepositVerdictSigningDigest(v)
	if err != nil {
		t.Fatal(err)
	}
	v.Signature = signSecp256k1(t, priv, digest)
	return v
}

func TestDepositVerdictSigningDigestVerifies(t *testing.T) {
	priv, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	v := signedTestDepositVerdict(t, priv)
	if err := VerifyDepositVerdictSignature(v, evmAddressOf(priv)); err != nil {
		t.Fatalf("a deposit verdict signed over DepositVerdictSigningDigest did not verify: %v", err)
	}
	// The two kinds share a key, so a fulfillment signature must not verify as a deposit one.
	fv := signedTestVerdict(t, priv)
	if err := VerifyDepositVerdictSignature(&DepositVerdict{
		Domain: fv.Domain, PaymentId: fv.PaymentId, ChainId: fv.ChainId, EscrowAddress: v.EscrowAddress,
		Outcome: v.Outcome, BlockNumber: fv.BlockNumber, BlockHash: fv.BlockHash, FinalityPolicy: fv.FinalityPolicy,
		TransactionHash: fv.TransactionHash, SignatureScheme: fv.SignatureScheme, Signature: fv.Signature,
	}, evmAddressOf(priv)); err == nil {
		t.Error("a fulfillment verdict signature verified as a deposit verdict")
	}
	crossed := *v
	crossed.SignatureScheme = VerdictSignatureSchemeTip191Secp256k1
	if _, err := DepositVerdictSigningDigest(&crossed); err == nil {
		t.Error("a scheme the chain does not admit produced a digest")
	}
	if _, err := DepositVerdictSigningDigest(nil); err == nil {
		t.Error("a nil deposit verdict produced a digest")
	}
}

func TestValidateDepositVerdictMembers(t *testing.T) {
	priv, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	valid := signedTestDepositVerdict(t, priv)
	if err := ValidateDepositVerdictMembers(valid); err != nil {
		t.Fatalf("a valid deposit verdict was rejected: %v", err)
	}
	cases := map[string]func(v *DepositVerdict){
		"EIP-55 escrow":            func(v *DepositVerdict) { v.EscrowAddress = "0x" + strings.Repeat("E", 40) },
		"empty escrow":             func(v *DepositVerdict) { v.EscrowAddress = "" },
		"tron escrow on eip155":    func(v *DepositVerdict) { v.EscrowAddress = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
		"held without tx":          func(v *DepositVerdict) { v.TransactionHash = "" },
		"not_held with tx":         func(v *DepositVerdict) { v.Outcome = DepositVerdictOutcomeNotHeld },
		"leading-zero block":       func(v *DepositVerdict) { v.BlockNumber = "01200" },
		"uppercase block hash":     func(v *DepositVerdict) { v.BlockHash = "0x" + strings.Repeat("A", 64) },
		"base58 block hash":        func(v *DepositVerdict) { v.BlockHash = strings.Repeat("A", 44) },
		"unknown outcome":          func(v *DepositVerdict) { v.Outcome = "released" },
		"scheme the chain refuses": func(v *DepositVerdict) { v.SignatureScheme = VerdictSignatureSchemeEd25519Raw },
		"ed25519 length on eip155": func(v *DepositVerdict) { v.Signature = v.Signature[:128] },
		"empty signature":          func(v *DepositVerdict) { v.Signature = "" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			v := *valid
			mutate(&v)
			if err := ValidateDepositVerdictMembers(&v); err == nil {
				t.Error("an invalid deposit verdict was accepted")
			}
		})
	}
	if err := ValidateDepositVerdictMembers(nil); err == nil {
		t.Error("a nil deposit verdict was accepted")
	}
}

// Each family admits its own escrow and hash encodings and refuses another's. The signature is
// not under test here, so each verdict carries a placeholder of the length its scheme requires.
func TestDepositVerdictFamilyEncodings(t *testing.T) {
	tron := DepositVerdict{
		Domain: "did:web:atum.network", PaymentId: "0x" + strings.Repeat("1", 64), ChainId: "tron:mainnet",
		EscrowAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", Outcome: DepositVerdictOutcomeHeld,
		BlockNumber: "7", BlockHash: "0x" + strings.Repeat("a", 64), FinalityPolicy: "confirmations:19",
		TransactionHash: "0x" + strings.Repeat("b", 64), SignatureScheme: VerdictSignatureSchemeTip191Secp256k1,
		Signature: strings.Repeat("ab", 65),
	}
	solana := DepositVerdict{
		Domain: "did:web:atum.network", PaymentId: "0x" + strings.Repeat("1", 64),
		ChainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", EscrowAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
		Outcome: DepositVerdictOutcomeHeld, BlockNumber: "7", BlockHash: "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn",
		FinalityPolicy:  "commitment:finalized",
		TransactionHash: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
		SignatureScheme: VerdictSignatureSchemeEd25519Raw, Signature: strings.Repeat("ab", 64),
	}
	for name, v := range map[string]DepositVerdict{"tron": tron, "solana": solana} {
		if err := ValidateDepositVerdictMembers(&v); err != nil {
			t.Errorf("a valid %s deposit verdict was rejected: %v", name, err)
		}
	}
	cases := map[string]DepositVerdict{
		"evm escrow on tron":       func(v DepositVerdict) DepositVerdict { v.EscrowAddress = "0x" + strings.Repeat("e", 40); return v }(tron),
		"base58 hash on tron":      func(v DepositVerdict) DepositVerdict { v.BlockHash = strings.Repeat("A", 44); return v }(tron),
		"hex block hash on solana": func(v DepositVerdict) DepositVerdict { v.BlockHash = "0x" + strings.Repeat("a", 64); return v }(solana),
		"evm escrow on solana":     func(v DepositVerdict) DepositVerdict { v.EscrowAddress = "0x" + strings.Repeat("e", 40); return v }(solana),
		// Right alphabet and length, wrong bytes: only the decoded checks catch these.
		"tron escrow with a bad checksum": func(v DepositVerdict) DepositVerdict {
			v.EscrowAddress = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"
			return v
		}(tron),
		"solana escrow of 33 bytes": func(v DepositVerdict) DepositVerdict { v.EscrowAddress = strings.Repeat("z", 44); return v }(solana),
		"solana transaction hash of 32 bytes": func(v DepositVerdict) DepositVerdict {
			v.TransactionHash = solana.BlockHash
			return v
		}(solana),
	}
	for name, v := range cases {
		t.Run(name, func(t *testing.T) {
			if err := ValidateDepositVerdictMembers(&v); err == nil {
				t.Error("a value in another family's encoding was accepted")
			}
		})
	}
}
