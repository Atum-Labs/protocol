package paymentrequest

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

// directDepositRuleVectors is conformance/direct-deposit-rule-vectors.json, which the TypeScript
// binding reads too.
type directDepositRuleVectors struct {
	Vectors []struct {
		Name        string `json:"name"`
		Document    string `json:"document"`
		WantErrKind string `json:"wantErrKind"`
		WantRule    string `json:"wantRule"`
		WantMessage string `json:"wantMessage"`
		// ValidateErrKind is "schema" when Validate refuses the document on its schema before the
		// rules run, so the caller sees a schema error rather than a DirectDepositRuleError.
		ValidateErrKind string `json:"validateErrKind"`
	} `json:"vectors"`
}

func loadDirectDepositRuleVectors(t *testing.T) directDepositRuleVectors {
	t.Helper()
	raw, err := os.ReadFile("../../conformance/direct-deposit-rule-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var file directDepositRuleVectors
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("conformance vectors are not valid JSON: %v", err)
	}
	if len(file.Vectors) == 0 {
		t.Fatal("conformance file carries no vectors")
	}
	return file
}

func TestValidateRules_DirectDeposit(t *testing.T) {
	for _, vector := range loadDirectDepositRuleVectors(t).Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			err := ValidateRules([]byte(vector.Document))
			switch vector.WantErrKind {
			case "":
				if err != nil {
					t.Fatalf("want the document admitted, got %v", err)
				}
				return
			case "direct_deposit":
				// The sentinel is what a consumer branches on, the rule what it maps to a code.
				if !errors.Is(err, ErrInvalidDirectDeposit) {
					t.Fatalf("refusal must match ErrInvalidDirectDeposit, got %#v", err)
				}
				var refusal *DirectDepositRuleError
				if !errors.As(err, &refusal) {
					t.Fatalf("want a *DirectDepositRuleError, got %#v", err)
				}
				if refusal.Rule != vector.WantRule {
					t.Fatalf("rule = %q, want %q", refusal.Rule, vector.WantRule)
				}
				if errors.Is(err, ErrUnsupportedOriginatorDestination) {
					t.Fatalf("a direct deposit refusal must not read as an unsupported destination: %v", err)
				}
			case "unsupported":
				if !errors.Is(err, ErrUnsupportedOriginatorDestination) {
					t.Fatalf("want the EIP-3009 destination refusal, got %#v", err)
				}
			case "ambiguous":
				// A twin inside a member the rules read is malformed, not a broken deposit rule.
				if err == nil {
					t.Fatal("want an ambiguous-member refusal, got nil")
				}
				if errors.Is(err, ErrInvalidDirectDeposit) || errors.Is(err, ErrUnsupportedOriginatorDestination) {
					t.Fatalf("an ambiguous document must not read as a rule refusal: %v", err)
				}
			default:
				t.Fatalf("unknown wantErrKind %q", vector.WantErrKind)
			}
			if err.Error() != vector.WantMessage {
				t.Fatalf("message is %q, want %q", err.Error(), vector.WantMessage)
			}
		})
	}
}

// Validate runs the schema before the rules, and the schema already refuses some of what the rules
// refuse (a deposit_nonce that is not a decimal string, any sender_auth that is not a complete
// object). Those reach the caller as schema errors, not as a DirectDepositRuleError; every other
// vector gets the same answer from Validate as from ValidateRules.
func TestValidate_DirectDeposit(t *testing.T) {
	for _, vector := range loadDirectDepositRuleVectors(t).Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			err := Validate([]byte(vector.Document))
			if vector.ValidateErrKind == "schema" {
				var refusal *DirectDepositRuleError
				if err == nil || errors.As(err, &refusal) || !strings.Contains(err.Error(), "validation error") {
					t.Fatalf("want a schema validation error, got %v", err)
				}
				return
			}
			if rulesErr := ValidateRules([]byte(vector.Document)); fmt.Sprint(err) != fmt.Sprint(rulesErr) {
				t.Fatalf("Validate = %v, ValidateRules = %v", err, rulesErr)
			}
		})
	}
}

// The destination cap the rules apply is the escrow's, which the shared destination fixture pins
// for every implementation of the destination grammar.
func TestDirectDepositMaxDestinationBytesMatchesSharedFixture(t *testing.T) {
	raw, err := os.ReadFile("../../conformance/destination-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		MaxDestinationBytes int `json:"maxDestinationBytes"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if directDepositMaxDestinationBytes != fixture.MaxDestinationBytes {
		t.Fatalf("directDepositMaxDestinationBytes = %d, shared fixture says %d", directDepositMaxDestinationBytes, fixture.MaxDestinationBytes)
	}
}
