package senderauth

import (
	jsonmembers "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/jsonmembers"
)

// The ambiguous-member scan lives in the PaymentRequest bindings' jsonmembers package, so the
// sender-auth commitment checks, the FulfillmentAuthorization validator and the PaymentRequest
// rules all run one implementation. These wrappers keep this package's surface, and the identity
// of ErrInvalidJSON, exactly as they were.

// MaxJSONDepth is the deepest nesting the scan reads.
const MaxJSONDepth = jsonmembers.MaxJSONDepth

// ErrInvalidJSON is returned when the document is not exactly one valid JSON value, or nests
// deeper than MaxJSONDepth. Treat it as a refusal.
var ErrInvalidJSON = jsonmembers.ErrInvalidJSON

// FirstAmbiguousMember returns the path of the first member whose name equals another member name
// of the same object under Unicode simple folding, exact duplicates included, or "" when there is
// none. See the jsonmembers package for why such a document must be refused.
func FirstAmbiguousMember(document []byte) (string, error) {
	return jsonmembers.FirstAmbiguousMember(document)
}

// FirstAmbiguousMemberIn is FirstAmbiguousMember limited to what a reader of the root object uses:
// every root member name is checked, but only the values of the root members named in read are
// inspected (CORE-2652).
func FirstAmbiguousMemberIn(document []byte, read []string) (string, error) {
	return jsonmembers.FirstAmbiguousMemberIn(document, read)
}

// firstAmbiguousMember is FirstAmbiguousMember with the "@context" exemption made optional, for
// callers in this package. inspect is honoured as in jsonmembers.
func firstAmbiguousMember(document []byte, exemptContext bool, inspect map[string]struct{}) (string, error) {
	if inspect != nil {
		read := make([]string, 0, len(inspect))
		for folded := range inspect {
			read = append(read, folded)
		}
		return jsonmembers.FirstAmbiguousMemberIn(document, read)
	}
	if exemptContext {
		return jsonmembers.FirstAmbiguousMember(document)
	}
	return jsonmembers.FirstAmbiguousMemberStrict(document)
}

// foldMemberName is the folded form two member names share when encoding/json would treat them as
// the same member.
func foldMemberName(name string) string {
	return jsonmembers.FoldMemberName(name)
}
