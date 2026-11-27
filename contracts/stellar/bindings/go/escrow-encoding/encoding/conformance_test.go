package stellar_escrow_encoding

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// vectorCase mirrors one entry of ../../../../conformance/vectors.json.
type vectorCase struct {
	Name       string            `json:"name"`
	Kind       string            `json:"kind"`
	Network    string            `json:"network"`
	ContractID string            `json:"contractId"`
	Input      map[string]string `json:"input"`
	Digest     string            `json:"digest"`
	Mutates    string            `json:"mutates"`
	Signature  string            `json:"signature"`
}

type vectorFile struct {
	SignatureDomainVersion int `json:"signatureDomainVersion"`
	Networks               map[string]struct {
		Passphrase string `json:"passphrase"`
		NetworkID  string `json:"networkId"`
	} `json:"networks"`
	Delegate struct {
		Seed      string `json:"seed"`
		PublicKey string `json:"publicKey"`
	} `json:"delegate"`
	Addresses []struct {
		Strkey string `json:"strkey"`
		Type   string `json:"type"`
		Key    string `json:"key"`
	} `json:"addresses"`
	RejectedAddresses map[string]string `json:"rejectedAddresses"`
	Cases             []vectorCase      `json:"cases"`
}

const regenHint = "run contracts/stellar/conformance/regenerate_vectors.py only for an intended layout change"

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "conformance", "vectors.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return v
}

func unhex32(t *testing.T, s string) [32]byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 32 {
		t.Fatalf("bad 32-byte hex %q", s)
	}
	var out [32]byte
	copy(out[:], b)
	return out
}

func bigDec(t *testing.T, s string) *big.Int {
	t.Helper()
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		t.Fatalf("bad decimal %q", s)
	}
	return v
}

func u64(t *testing.T, s string) uint64 {
	t.Helper()
	return bigDec(t, s).Uint64()
}

func (v vectorFile) domain(t *testing.T, c vectorCase) EscrowDomain {
	t.Helper()
	n, ok := v.Networks[c.Network]
	if !ok {
		t.Fatalf("%s: unknown network %q", c.Name, c.Network)
	}
	d, err := NewEscrowDomain(n.Passphrase, MustParseAddress(c.ContractID))
	if err != nil {
		t.Fatalf("%s: domain: %v", c.Name, err)
	}
	return d
}

func activeFrom(t *testing.T, in map[string]string) EscrowActiveDeposit {
	t.Helper()
	return EscrowActiveDeposit{
		Depositor:          MustParseAddress(in["depositor"]),
		QuoteHash:          unhex32(t, in["quoteHash"]),
		DepositRequestHash: unhex32(t, in["depositRequestHash"]),
		DestinationHash:    unhex32(t, in["destinationHash"]),
		Token:              MustParseAddress(in["token"]),
		Amount:             bigDec(t, in["amount"]),
		FeeAmount:          bigDec(t, in["feeAmount"]),
		Reserver:           MustPubkeyFromHex(in["reserver"]),
		Releaser:           MustPubkeyFromHex(in["releaser"]),
		Settler:            MustParseAddress(in["settler"]),
	}
}

func (v vectorFile) digest(t *testing.T, c vectorCase) ([32]byte, error) {
	t.Helper()
	in := c.Input
	switch c.Kind {
	case "destinationHash":
		return ComputeDestinationHash(in["destination"]), nil
	case "deposit":
		return ComputeDepositHash(EscrowDepositParams{
			DepositRequestHash: unhex32(t, in["depositRequestHash"]),
			Destination:        in["destination"],
			Depositor:          MustParseAddress(in["depositor"]),
			Token:              MustParseAddress(in["token"]),
			Epoch:              u64(t, in["epoch"]),
			Amount:             bigDec(t, in["amount"]),
			Reserver:           MustPubkeyFromHex(in["reserver"]),
			Releaser:           MustPubkeyFromHex(in["releaser"]),
			Nonce:              u64(t, in["nonce"]),
			IssuedAt:           u64(t, in["issuedAt"]),
			Deadline:           u64(t, in["deadline"]),
		}, v.domain(t, c))
	case "reserve":
		return ComputeReserveHash(EscrowReserveParams{
			DepositID:    unhex32(t, in["depositId"]),
			QuoteHash:    unhex32(t, in["quoteHash"]),
			Settler:      MustParseAddress(in["settler"]),
			SourceAmount: bigDec(t, in["sourceAmount"]),
		}, v.domain(t, c))
	case "release":
		return ComputeReleaseHash(EscrowReleaseParams{
			DepositID: unhex32(t, in["depositId"]), EscrowActiveDeposit: activeFrom(t, in),
		}, v.domain(t, c))
	case "refund":
		return ComputeRefundHash(EscrowRefundParams{
			DepositID: unhex32(t, in["depositId"]), EscrowActiveDeposit: activeFrom(t, in),
		}, v.domain(t, c))
	case "renounce":
		return ComputeRenounceHash(EscrowRenounceParams{
			Depositor: MustParseAddress(in["depositor"]),
			Token:     MustParseAddress(in["token"]),
			Epoch:     u64(t, in["epoch"]),
			Nonce:     u64(t, in["nonce"]),
			Deadline:  u64(t, in["deadline"]),
		}, v.domain(t, c))
	case "activeDeposit":
		return ComputeActiveDepositHash(activeFrom(t, in))
	}
	// A new kind in the fixture must be taught to every implementation, so it fails loudly here
	t.Fatalf("%s: vectors.json has kind %q this test does not implement", c.Name, c.Kind)
	return [32]byte{}, nil
}

// TestConformanceVectors asserts every shared vector. The same file is asserted by the Rust contract
// tests and the TypeScript encoder; none of the three produces it (regenerate_vectors.py does, from the
// layout doc), so a digest that differs here means this encoder drifted, not that the file is stale.
func TestConformanceVectors(t *testing.T) {
	v := loadVectors(t)
	if v.SignatureDomainVersion != SignatureDomainVersion {
		t.Fatalf("vectors are for signature domain version %d, encoder is %d: %s",
			v.SignatureDomainVersion, SignatureDomainVersion, regenHint)
	}
	if len(v.Cases) < 90 {
		t.Fatalf("vector set shrank to %d cases", len(v.Cases))
	}
	kinds := map[string]bool{}
	digests := map[string]string{}
	for _, c := range v.Cases {
		got, err := v.digest(t, c)
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		if hex.EncodeToString(got[:]) != c.Digest {
			t.Errorf("%s: encoder produced %x, vector says %s; %s", c.Name, got, c.Digest, regenHint)
		}
		kinds[c.Kind] = true
		digests[c.Name] = c.Digest
	}
	var got []string
	for k := range kinds {
		got = append(got, k)
	}
	sort.Strings(got)
	want := []string{"activeDeposit", "deposit", "destinationHash", "refund", "release", "renounce", "reserve"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("kinds covered = %v, want %v", got, want)
	}

	// A case that claims to change one field must change the digest: the vectors prove every member of
	// every layout is bound.
	changed := 0
	for _, c := range v.Cases {
		if c.Mutates == "" {
			continue
		}
		base, ok := digests[c.Mutates]
		if !ok {
			t.Errorf("%s mutates unknown case %q", c.Name, c.Mutates)
		} else if base == c.Digest {
			t.Errorf("%s does not change the digest of %s", c.Name, c.Mutates)
		}
		changed++
	}
	if changed < 40 {
		t.Errorf("only %d single-field cases", changed)
	}
	if digests["release/base"] == digests["refund/base"] {
		t.Error("a release signature would validate as a refund")
	}
}

func TestConformanceNetworkIDsArePassphraseHashes(t *testing.T) {
	for name, n := range loadVectors(t).Networks {
		sum := sha256.Sum256([]byte(n.Passphrase))
		if hex.EncodeToString(sum[:]) != n.NetworkID {
			t.Errorf("%s: network id %s is not sha256(passphrase)", name, n.NetworkID)
		}
	}
	// The exported constants are the passphrases the vectors use
	if got := NetworkID(PassphraseTestnet); hex.EncodeToString(got[:]) != loadVectors(t).Networks["testnet"].NetworkID {
		t.Error("PassphraseTestnet does not hash to the testnet network id")
	}
	if got := NetworkID(PassphrasePublic); hex.EncodeToString(got[:]) != loadVectors(t).Networks["public"].NetworkID {
		t.Error("PassphrasePublic does not hash to the public network id")
	}
}

func TestConformanceAddresses(t *testing.T) {
	v := loadVectors(t)
	for _, a := range v.Addresses {
		got, err := ParseAddress(a.Strkey)
		if err != nil {
			t.Errorf("%s: %v", a.Strkey, err)
			continue
		}
		wantType := map[string]AddressType{"account": AccountAddress, "contract": ContractAddress}[a.Type]
		if got.Type != wantType || hex.EncodeToString(got.Key[:]) != a.Key {
			t.Errorf("%s decoded to %d/%x, want %s/%s", a.Strkey, got.Type, got.Key, a.Type, a.Key)
		}
		if got.String() != a.Strkey {
			t.Errorf("%s re-encoded to %s", a.Strkey, got.String())
		}
		b := got.Bytes33()
		if b[0] != byte(wantType) || hex.EncodeToString(b[1:]) != a.Key {
			t.Errorf("%s: addr33 = %x", a.Strkey, b)
		}
	}
	if len(v.Addresses) == 0 || len(v.RejectedAddresses) == 0 {
		t.Fatal("address tables are empty, so this test proves nothing")
	}
}

// TestConformanceDelegateSignatures checks the pinned signatures verify under Go's own ed25519 and are
// exactly what the seed signs: ed25519 is deterministic.
func TestConformanceDelegateSignatures(t *testing.T) {
	v := loadVectors(t)
	seed, _ := hex.DecodeString(v.Delegate.Seed)
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	if hex.EncodeToString(pub) != v.Delegate.PublicKey {
		t.Fatalf("seed derives %x, vectors say %s", pub, v.Delegate.PublicKey)
	}
	signed := 0
	for _, c := range v.Cases {
		if c.Signature == "" {
			continue
		}
		digest, _ := hex.DecodeString(c.Digest)
		sig, _ := hex.DecodeString(c.Signature)
		if !ed25519.Verify(pub, digest, sig) {
			t.Errorf("%s: pinned signature does not verify over the digest", c.Name)
		}
		if got := ed25519.Sign(priv, digest); hex.EncodeToString(got) != c.Signature {
			t.Errorf("%s: seed signs %x, vector says %s", c.Name, got, c.Signature)
		}
		signed++
	}
	if signed != 2 {
		t.Errorf("signed cases = %d, want 2 (deposit and renounce are the delegate's digests)", signed)
	}
}

// TestRawDestinationFeedIsNotWhatTheContractComputes pins the hash-first rule: the same deposit with the
// destination fed raw, the value witness-layouts.md lists as unsound, must differ from the real digest.
func TestRawDestinationFeedIsNotWhatTheContractComputes(t *testing.T) {
	const wantRaw = "a27e5b952663bace502540b5a9f2d6d0ec8e414639741daa9cfdfa3b3abe7fdd"
	v := loadVectors(t)
	var base vectorCase
	for _, c := range v.Cases {
		if c.Name == "deposit/base" {
			base = c
		}
	}
	in := base.Input
	prefix, err := EscrowDomainPrefixBytes(v.domain(t, base))
	if err != nil {
		t.Fatal(err)
	}
	depositor, token := MustParseAddress(in["depositor"]).Bytes33(), MustParseAddress(in["token"]).Bytes33()
	amount, _ := EncodeAmount16(bigDec(t, in["amount"]))
	reqHash, reserver, releaser := unhex32(t, in["depositRequestHash"]), unhex32(t, in["reserver"]), unhex32(t, in["releaser"])
	raw := Keccak256(append(prefix,
		[]byte("deposit"), reqHash[:], []byte(in["destination"]), depositor[:], token[:], EncodeU64LE(u64(t, in["epoch"])), amount,
		reserver[:], releaser[:], EncodeU64LE(u64(t, in["nonce"])), EncodeU64LE(u64(t, in["issuedAt"])),
		EncodeU64LE(u64(t, in["deadline"])))...)
	if hex.EncodeToString(raw[:]) != wantRaw {
		t.Fatalf("raw-destination preimage = %x, witness-layouts.md says %s", raw, wantRaw)
	}
	if hex.EncodeToString(raw[:]) == base.Digest {
		t.Fatal("the raw-destination digest equals the real one")
	}
}

func TestEncodeAmount16(t *testing.T) {
	for _, tc := range []struct {
		in   *big.Int
		want string
		err  error
	}{
		{big.NewInt(0), "00000000000000000000000000000000", nil},
		{big.NewInt(1), "01000000000000000000000000000000", nil},
		{big.NewInt(0x0102), "02010000000000000000000000000000", nil}, // little-endian
		{new(big.Int).Lsh(big.NewInt(1), 64), "00000000000000000100000000000000", nil},
		{maxI128, "ffffffffffffffffffffffffffffff7f", nil},
		{new(big.Int).Lsh(big.NewInt(1), 127), "", ErrAmountOutOfRange},
		{big.NewInt(-1), "", ErrAmountOutOfRange},
		{nil, "", ErrAmountOutOfRange},
	} {
		got, err := EncodeAmount16(tc.in)
		if !errors.Is(err, tc.err) {
			t.Errorf("%v: err = %v, want %v", tc.in, err, tc.err)
		}
		if tc.err == nil && hex.EncodeToString(got) != tc.want {
			t.Errorf("%v: got %x, want %s", tc.in, got, tc.want)
		}
	}
}

// TestAddressStrkeyRejections holds only what strkey-vectors.json cannot express: an exhaustive loop over
// the last character and the refusal of a C address as a signing key. Every other malformed or unsupported
// strkey, including the non-zero spare bits case, belongs in that file.
func TestAddressStrkeyRejections(t *testing.T) {
	good := MustParseAddress("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC").String()
	// A 56-character strkey is exactly 280 bits, so there are no spare bits to make non-canonical. Changing
	// the last character instead has to fail the checksum, whatever base32 digit it becomes.
	last := good[len(good)-1]
	for _, alt := range "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" {
		if byte(alt) == last {
			continue
		}
		if _, err := ParseAddress(good[:len(good)-1] + string(alt)); err == nil {
			t.Errorf("accepted %c as the last character of a checksummed strkey", alt)
		}
	}
	if _, err := PubkeyFromStrkey(good); !errors.Is(err, ErrUnsupportedAddress) {
		t.Errorf("a C address is not a signing key: %v", err)
	}
}

// TestNetworkPassphraseIsHashedExactly pins the passphrase handling: network_id is sha256 of the bytes as
// given (witness-layouts.md), so whitespace is part of the network, never trimmed, and a whitespace-only
// passphrase is a (nonsensical but distinct) network rather than an empty one.
func TestNetworkPassphraseIsHashedExactly(t *testing.T) {
	escrow := validAddr(0xc0)
	testnet, err := NewEscrowDomain(PassphraseTestnet, escrow)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{PassphraseTestnet + " ", " " + PassphraseTestnet, PassphraseTestnet + "\n"} {
		d, err := NewEscrowDomain(p, escrow)
		if err != nil {
			t.Fatalf("%q: %v", p, err)
		}
		if d.NetworkID == testnet.NetworkID {
			t.Errorf("%q hashes like the testnet passphrase: it was trimmed", p)
		}
		if d.NetworkID != sha256.Sum256([]byte(p)) {
			t.Errorf("%q: network id is not sha256 of the bytes as given", p)
		}
	}
	if d, err := NewEscrowDomain(" ", escrow); err != nil || d.NetworkID != sha256.Sum256([]byte(" ")) {
		t.Errorf("a whitespace-only passphrase must be hashed as given, got %v", err)
	}
}
