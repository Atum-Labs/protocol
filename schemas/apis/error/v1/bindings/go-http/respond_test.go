package apierr

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	atumerror "github.com/atum-labs/protocol/schemas/apis/error/v1/bindings/go"
	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// TestRespond_AtumError maps a catalogued AtumError to its public body and
// status, and leaks none of the internal detail.
func TestRespond_AtumError(t *testing.T) {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)

	err := atumerror.New(
		atumerror.CodeTxReverted,
		"tx 0xabc reverted: FulfillmentProxy_ExpiredTransaction",
		"req_1",
		atumerror.SchemaJsonDomainSETTLERAGENT,
		map[string]interface{}{"revert_reason": "boom", "nonce": 7},
	)
	Respond(c, err)

	if rec.Code != 502 {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	body := rec.Body.String()
	var resp map[string]any
	if e := json.Unmarshal([]byte(body), &resp); e != nil {
		t.Fatal(e)
	}
	if resp["code"] != "SETTLEMENT_FAILED" {
		t.Fatalf("code = %v, want SETTLEMENT_FAILED", resp["code"])
	}
	for _, leaked := range []string{"0xabc", "FulfillmentProxy", "revert_reason", "nonce", "details"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("Respond leaked %q: %s", leaked, body)
		}
	}
}

// TestRespond_PlainError falls back to a generic 500 without leaking the error text.
func TestRespond_PlainError(t *testing.T) {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)

	Respond(c, errors.New("internal: secret db dsn postgres://x"))

	if rec.Code != 500 {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "INTERNAL_ERROR") {
		t.Fatalf("expected INTERNAL_ERROR fallback, got %s", body)
	}
	for _, leaked := range []string{"secret", "dsn", "postgres"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("Respond leaked %q: %s", leaked, body)
		}
	}
}

// TestRespond_Nil is a no-op and must not panic or write a body.
func TestRespond_Nil(t *testing.T) {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	Respond(c, nil)
	if rec.Body.Len() != 0 {
		t.Fatalf("nil err wrote a body: %s", rec.Body.String())
	}
}

// TestRespond_TypedNil passes a non-nil error interface wrapping a nil
// *AtumError. errors.As reports true but leaves the pointer nil, so Respond
// must not panic and must fall back to the generic 500.
func TestRespond_TypedNil(t *testing.T) {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)

	var ae *atumerror.AtumError // typed nil
	Respond(c, ae)

	if rec.Code != 500 {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "INTERNAL_ERROR") {
		t.Fatalf("expected INTERNAL_ERROR fallback, got %s", rec.Body.String())
	}
}

// TestRespond_QuoteDeadlineExpired locks the mapping for a no-quotes auction:
// QUOTE_DEADLINE_EXPIRED maps to a 422 with the public NO_QUOTES_RECEIVED code,
// leaking none of the internal detail. TX_REVERTED to 502 is covered by
// TestRespond_AtumError. This locks the status mapping at the layer that decides it.
func TestRespond_QuoteDeadlineExpired(t *testing.T) {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)

	err := atumerror.New(
		atumerror.CodeQuoteDeadlineExpired,
		"quote deadline 2026-01-01T00:00:00Z passed before a route was secured",
		"req_2",
		atumerror.SchemaJsonDomainPAYMENTGATEWAY,
		map[string]interface{}{"quote_deadline": "2026-01-01T00:00:00Z"},
	)
	Respond(c, err)

	if rec.Code != 422 {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	body := rec.Body.String()
	var resp map[string]any
	if e := json.Unmarshal([]byte(body), &resp); e != nil {
		t.Fatal(e)
	}
	if resp["code"] != "NO_QUOTES_RECEIVED" {
		t.Fatalf("code = %v, want NO_QUOTES_RECEIVED", resp["code"])
	}
	for _, leaked := range []string{"quote_deadline", "2026-01-01", "details", "passed before"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("Respond leaked %q: %s", leaked, body)
		}
	}
}

// TestRespond_CarriesBothIds writes both identifiers onto the public body when the
// error has both, and omits payment_id when the request never produced a payment.
func TestRespond_CarriesBothIds(t *testing.T) {
	const paymentID = "0xc7108e200d11580e7e75185991084b42a535af588ba8267cd0d1e7df089e5c9c"

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	Respond(c, atumerror.New(
		atumerror.CodeTxReverted, "reverted", "req_12345",
		atumerror.SchemaJsonDomainSETTLERAGENT, nil,
	).WithPaymentID(paymentID))

	var resp map[string]any
	if e := json.Unmarshal(rec.Body.Bytes(), &resp); e != nil {
		t.Fatal(e)
	}
	if resp["request_id"] != "req_12345" {
		t.Fatalf("request_id = %v, want req_12345", resp["request_id"])
	}
	if resp["payment_id"] != paymentID {
		t.Fatalf("payment_id = %v, want %v", resp["payment_id"], paymentID)
	}

	recNoPayment := httptest.NewRecorder()
	c2, _ := gin.CreateTestContext(recNoPayment)
	Respond(c2, atumerror.New(
		atumerror.CodeInvalidRequest, "bad body", "req_67890",
		atumerror.SchemaJsonDomainPAYMENTGATEWAY, nil,
	))

	var resp2 map[string]any
	if e := json.Unmarshal(recNoPayment.Body.Bytes(), &resp2); e != nil {
		t.Fatal(e)
	}
	if _, ok := resp2["payment_id"]; ok {
		t.Fatalf("payment_id must be omitted when there is no payment: %s", recNoPayment.Body.String())
	}
	if resp2["request_id"] != "req_67890" {
		t.Fatalf("request_id = %v, want req_67890", resp2["request_id"])
	}
}
