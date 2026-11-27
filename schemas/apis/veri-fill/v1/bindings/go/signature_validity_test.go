package verifill

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// POST /v1/signature-validity answers with the sender-auth library's verdict, so its reason and path
// sets must be exactly the library's. The library's shared vectors use every value it can return,
// so the spec's enums are compared against the values those vectors expect: a value on one side
// only is an answer the other side cannot give or cannot read.
func TestSignatureValidityEnumsMatchTheLibraryVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "declarations", "PaymentRequest", "v1", "conformance", "depositor-signature-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Vectors []struct {
			Result struct {
				Path   string `json:"path"`
				Reason string `json:"reason"`
			} `json:"result"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	var reasons, paths []string
	for _, v := range doc.Vectors {
		reasons = append(reasons, v.Result.Reason)
		paths = append(paths, v.Result.Path)
	}

	for _, c := range []struct {
		schema string
		used   []string
	}{
		{"SignatureValidityReason", reasons},
		{"SignatureValidityPath", paths},
	} {
		spec := specEnum(t, c.schema)
		used := slices.Compact(slices.Sorted(slices.Values(c.used)))
		if !slices.Equal(spec, used) {
			t.Errorf("%s: the spec lists %v, the library's vectors use %v", c.schema, spec, used)
		}
	}

	// And the generated constants carry those same strings.
	for _, pair := range [][2]string{
		{string(SignatureValidityReasonVerified), "verified"},
		{string(SignatureValidityReasonSignerMismatch), "signer_mismatch"},
		{string(SignatureValidityReasonContractSignatureRejected), "contract_signature_rejected"},
		{string(SignatureValidityReasonSignatureUnverifiable), "signature_unverifiable"},
		{string(SignatureValidityReasonUnsupportedChain), "unsupported_chain"},
		{string(SignatureValidityReasonMalformed), "malformed"},
		{string(SignatureValidityPathEoa), "eoa"},
		{string(SignatureValidityPathContract), "contract"},
		{string(SignatureValidityPathNone), "none"},
	} {
		if pair[0] != pair[1] {
			t.Errorf("generated constant %q, want %q", pair[0], pair[1])
		}
	}
}

// Both routes refuse a signature longer than its maxLength as malformed, and so does the library, so
// the bounds must be one number: each request schema's signature maxLength and the library fixture's
// signatureMaxLength, which both sender-auth suites test the bound against.
func TestSignatureValidityMaxLengthMatchesTheLibrary(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "declarations", "PaymentRequest", "v1", "conformance", "depositor-signature-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		SignatureMaxLength int `json:"signatureMaxLength"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.SignatureMaxLength == 0 {
		t.Fatal("the library's vectors carry no signatureMaxLength")
	}
	for _, schema := range []string{"SignatureValidityRequest", "ReserveSignatureValidityRequest"} {
		if spec := specSignatureMaxLength(t, schema); spec != doc.SignatureMaxLength {
			t.Errorf("%s.signature: the spec's maxLength is %d, the library's bound is %d", schema, spec, doc.SignatureMaxLength)
		}
	}
}

// specSignatureMaxLength reads a request schema's signature maxLength from openapi.yaml as text, and
// fails when the property has none.
func specSignatureMaxLength(t *testing.T, schema string) int {
	t.Helper()
	f, err := os.Open(filepath.Join("..", "..", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var inSchema, inProperty bool
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		line := scan.Text()
		indent := len(line) - len(strings.TrimLeft(line, " "))
		switch {
		case line == "    "+schema+":":
			inSchema = true
		case inSchema && !inProperty && indent == 4 && strings.TrimSpace(line) != "":
			inSchema = false
		case inSchema && line == "        signature:":
			inProperty = true
		case inProperty && strings.HasPrefix(line, "          maxLength: "):
			n, err := strconv.Atoi(strings.TrimPrefix(line, "          maxLength: "))
			if err != nil {
				t.Fatalf("%s.signature: maxLength: %v", schema, err)
			}
			return n
		case inProperty && strings.TrimSpace(line) != "" && indent <= 8:
			t.Fatalf("%s.signature has no maxLength", schema)
		}
	}
	t.Fatalf("%s.signature not found in openapi.yaml", schema)
	return 0
}

// specEnum reads the enum of a top-level component schema from openapi.yaml, sorted. It reads
// the spec as text, one schema down to its enum list, and fails rather than return an empty set.
func specEnum(t *testing.T, schema string) []string {
	t.Helper()
	f, err := os.Open(filepath.Join("..", "..", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var (
		inSchema, inEnum bool
		values           []string
	)
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		line := scan.Text()
		switch {
		case line == "    "+schema+":":
			inSchema = true
		case inSchema && line == "      enum:":
			inEnum = true
		case inEnum && strings.HasPrefix(line, "        - "):
			values = append(values, strings.TrimPrefix(line, "        - "))
		case inEnum:
			if len(values) == 0 {
				t.Fatalf("%s: the enum has no values", schema)
			}
			slices.Sort(values)
			return values
		}
	}
	t.Fatalf("%s: no enum found in openapi.yaml", schema)
	return nil
}
