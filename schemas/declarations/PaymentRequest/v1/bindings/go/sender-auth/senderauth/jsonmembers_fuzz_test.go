package senderauth

import (
	"encoding/json"
	"os"
	"testing"
	"unicode/utf8"

	paymentrequest "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
)

// fuzzSeeds are the shared member and request vectors, so the fuzzer starts from real shapes.
func fuzzSeeds(f *testing.F) {
	for _, c := range namedDocumentsOf(loadJSONMemberVectors(f)) {
		f.Add([]byte(c.document))
	}
	raw, err := os.ReadFile(conformancePath("verify-json-vectors.json"))
	if err != nil {
		f.Fatal(err)
	}
	var requests struct {
		Vectors []struct {
			Request string `json:"request"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &requests); err != nil {
		f.Fatal(err)
	}
	for _, v := range requests.Vectors {
		f.Add([]byte(v.Request))
	}
}

// The scanner never panics, and it passes only one valid UTF-8 JSON document. A twin found before
// a later syntax error is reported as the twin; both are refusals.
func FuzzFirstAmbiguousMember(f *testing.F) {
	fuzzSeeds(f)
	f.Fuzz(func(t *testing.T, document []byte) {
		if path, err := FirstAmbiguousMember(document); path == "" && err == nil && (!json.Valid(document) || !utf8.Valid(document)) {
			t.Fatalf("accepted a document that is not valid UTF-8 JSON: %q", document)
		}
	})
}

// The request check never panics, and it admits exactly when it returns no error.
func FuzzVerifyRequestCommitment(f *testing.F) {
	fuzzSeeds(f)
	domain := &SolanaDomain{EscrowProgramID: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", ClusterID: "devnet", DomainVersion: 5}
	f.Fuzz(func(t *testing.T, request []byte) {
		r, err := VerifyRequestCommitment(request, domain)
		if (err == nil) != r.Verified() {
			t.Fatalf("outcome %q with error %v", r.Outcome, err)
		}
	})
}

// The scoped scan refuses only what the full scan refuses, and inside a read member it reports
// exactly what the full scan reports.
func FuzzFirstAmbiguousMemberIn(f *testing.F) {
	fuzzSeeds(f)
	f.Fuzz(func(t *testing.T, document []byte) {
		fullPath, fullErr := FirstAmbiguousMember(document)
		path, err := FirstAmbiguousMemberIn(document, requestReadMembers)
		if fullErr != nil && err == nil {
			t.Fatalf("passed a document the full scan refuses as invalid: %q", document)
		}
		if (err != nil || path != "") && fullErr == nil && fullPath == "" {
			t.Fatalf("refused a document the full scan passes: %q", document)
		}
		if fullErr != nil {
			return // a malformed document could close the wrapper early
		}
		wrapped := append(append([]byte(`{"Read":`), document...), '}')
		wantPath, wantErr := FirstAmbiguousMember(wrapped)
		gotPath, gotErr := FirstAmbiguousMemberIn(wrapped, []string{"read"})
		if gotPath != wantPath || (gotErr != nil) != (wantErr != nil) {
			t.Fatalf("inside a read member got %q, %v, want %q, %v: %q", gotPath, gotErr, wantPath, wantErr, document)
		}
	})
}

// The v2 reader never panics, refuses only with request_malformed, and hashes what it reads: a
// request it admits hashes to the same v2 through DepositRequestHashV2. Its hashes also survive an
// honest re-encode: when solver-gw's typed decode admits the request, json.Marshal of that decode
// is admitted too, with the same v1 and v2.
func FuzzReadDepositRequest(f *testing.F) {
	fuzzSeeds(f)
	raw, err := os.ReadFile(conformancePath("deposit-request-hash-v2-vectors.json"))
	if err != nil {
		f.Fatal(err)
	}
	var v2 depositRequestV2Vectors
	if err := json.Unmarshal(raw, &v2); err != nil {
		f.Fatal(err)
	}
	for _, c := range v2.Golden {
		f.Add([]byte(c.Request))
	}
	for _, c := range v2.Refused {
		f.Add([]byte(c.Request))
	}
	f.Fuzz(func(t *testing.T, request []byte) {
		read, err := ReadDepositRequest(request)
		if err != nil {
			if r, ok := CommitmentResultOf(err); !ok || r.Outcome != OutcomeRequestMalformed {
				t.Fatalf("refused with %v, want a request_malformed *CommitmentError", err)
			}
			return
		}
		hash, err := DepositRequestHashV2(request)
		if err != nil || hash != read.DepositRequestHashV2 {
			t.Fatalf("DepositRequestHashV2 = %x, %v; ReadDepositRequest hashed %x", hash, err, read.DepositRequestHashV2)
		}
		var typed paymentrequest.SchemaJson
		if json.Unmarshal(request, &typed) != nil {
			return
		}
		reencoded, err := json.Marshal(typed)
		if err != nil {
			t.Fatalf("marshal the typed decode: %v", err)
		}
		again, err := ReadDepositRequest(reencoded)
		if err != nil {
			t.Fatalf("the typed re-encode is refused: %v\n%s", err, reencoded)
		}
		if again.DepositRequestHashV1 != read.DepositRequestHashV1 || again.DepositRequestHashV2 != read.DepositRequestHashV2 {
			t.Fatalf("the typed re-encode hashes v1 %x v2 %x, the request v1 %x v2 %x\n%s",
				again.DepositRequestHashV1, again.DepositRequestHashV2, read.DepositRequestHashV1, read.DepositRequestHashV2, reencoded)
		}
	})
}
