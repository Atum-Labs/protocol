package atumerror_test

import (
	"encoding/json"
	"strings"
	"testing"

	atumerror "github.com/atum-labs/protocol/schemas/apis/error/v1/bindings/go"
)

// TestToErrorResponse_TxReverted is the worked example: a reverted settlement transaction. The
// specific cause is kept internally, the user sees a generic settlement
// message, and no internal detail leaks.
func TestToErrorResponse_TxReverted(t *testing.T) {
	internal := atumerror.New(
		"TX_REVERTED",
		"tx 0xabc reverted: execution reverted: FulfillmentProxy_ExpiredTransaction",
		"req_12345",
		atumerror.SchemaJsonDomainSETTLERAGENT,
		map[string]interface{}{
			"tx_hash":       "0xabc",
			"revert_reason": "FulfillmentProxy_ExpiredTransaction",
			"nonce":         42,
		},
	)

	pub := internal.ToErrorResponse()

	// Many internal codes (TX_REVERTED, NONCE_TOO_LOW, ...) collapse onto one
	// public category.
	if pub.Code != "SETTLEMENT_FAILED" {
		t.Fatalf("public code = %q, want SETTLEMENT_FAILED", pub.Code)
	}
	// The user message is the curated catalog string, not the internal message.
	if strings.Contains(pub.Message, "FulfillmentProxy") || strings.Contains(pub.Message, "0xabc") {
		t.Fatalf("public message leaked internal detail: %q", pub.Message)
	}
	// Safe passthrough + catalog-derived fields.
	if pub.RequestId != "req_12345" {
		t.Fatalf("request id = %q, want req_12345", pub.RequestId)
	}
	if pub.HTTPStatus() != 502 {
		t.Fatalf("http status = %d, want 502", pub.HTTPStatus())
	}
	if pub.DocsUrl == "" || !strings.HasSuffix(pub.DocsUrl, "settlement-failed") {
		t.Fatalf("docs url = %q, want it to end in settlement-failed", pub.DocsUrl)
	}

	// The serialized public body must carry none of the internal diagnostics.
	body, err := json.Marshal(pub)
	if err != nil {
		t.Fatal(err)
	}
	for _, leaked := range []string{"revert_reason", "0xabc", "nonce", "details", "FulfillmentProxy"} {
		if strings.Contains(string(body), leaked) {
			t.Fatalf("serialized ErrorResponse leaked %q: %s", leaked, body)
		}
	}
}

// TestToErrorResponse_UnknownCodeFallsBack proves an uncatalogued code cannot leak its
// raw message: it degrades to the generic INTERNAL_ERROR mapping.
func TestToErrorResponse_UnknownCodeFallsBack(t *testing.T) {
	internal := atumerror.New(
		"SOME_BRAND_NEW_CODE",
		"internal: secret stack trace and db dsn",
		"req_999",
		atumerror.SchemaJsonDomainSETTLERGATEWAY,
		map[string]interface{}{"db_dsn": "postgres://secret@host", "stack": "secret trace"},
	)

	pub := internal.ToErrorResponse()

	if pub.Code != "INTERNAL_ERROR" {
		t.Fatalf("fallback code = %q, want INTERNAL_ERROR", pub.Code)
	}
	if pub.HTTPStatus() != 500 {
		t.Fatalf("fallback http status = %d, want 500", pub.HTTPStatus())
	}
	// The originating domain still passes through for internal correlation.
	if pub.Domain != "SETTLER_GATEWAY" {
		t.Fatalf("domain = %q, want SETTLER_GATEWAY", pub.Domain)
	}
	// The fallback path must be as leak-proof as the mapped path: scan the
	// serialized body, not just the message.
	body, err := json.Marshal(pub)
	if err != nil {
		t.Fatal(err)
	}
	for _, leaked := range []string{"secret", "dsn", "postgres", "db_dsn", "stack", "details"} {
		if strings.Contains(string(body), leaked) {
			t.Fatalf("serialized fallback ErrorResponse leaked %q: %s", leaked, body)
		}
	}
}

// TestToErrorResponse_CarriesBothIds pins that the two identifiers travel
// independently: request_id correlates the call, payment_id names the payment.
// A settler-origin failure has only the payment, and a pre-creation rejection has
// only the request, so neither may be inferred from the other.
func TestToErrorResponse_CarriesBothIds(t *testing.T) {
	const paymentID = "0xc7108e200d11580e7e75185991084b42a535af588ba8267cd0d1e7df089e5c9c"

	both := atumerror.New(
		atumerror.CodeTxReverted, "reverted", "req_12345",
		atumerror.SchemaJsonDomainSETTLERAGENT, nil,
	).WithPaymentID(paymentID).ToErrorResponse()

	if both.RequestId != "req_12345" {
		t.Fatalf("request id = %q, want req_12345", both.RequestId)
	}
	if both.PaymentId != paymentID {
		t.Fatalf("payment id = %q, want %q", both.PaymentId, paymentID)
	}

	// No payment: the field is omitted from the wire rather than sent empty, so a
	// consumer can tell "no payment" from "a payment whose id is the empty string".
	noPayment := atumerror.New(
		atumerror.CodeInvalidRequest, "bad body", "req_67890",
		atumerror.SchemaJsonDomainPAYMENTGATEWAY, nil,
	).ToErrorResponse()

	if noPayment.PaymentId != "" {
		t.Fatalf("payment id = %q, want empty", noPayment.PaymentId)
	}
	body, err := json.Marshal(noPayment)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "payment_id") {
		t.Fatalf("payment_id must be omitted when there is no payment: %s", body)
	}
}
