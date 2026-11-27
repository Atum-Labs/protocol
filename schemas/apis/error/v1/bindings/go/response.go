package atumerror

import (
	"encoding/json"
	"fmt"
	"time"
)

// RetryClassification tells a caller what to do next.
//
// Which retry this is about: re-sending the same request_id is an idempotent
// replay that returns the stored outcome, so it is always safe. This value is
// about the step that is NOT safe by default, submitting a new request_id, which
// creates a new payment.
//
// The set below is closed, but a value outside it just means a newer server than
// this binding: compare with these constants and treat an unrecognised value as
// unclassified rather than rejecting the response.
type RetryClassification string

const (
	// RetryAfterDelay: no payment was created and the condition is transient, so
	// re-send the same request_id after a delay.
	RetryAfterDelay RetryClassification = "RETRY_AFTER_DELAY"
	// ReconcileThenDecide: the outcome is unknown. Check the payment before
	// issuing a new request_id, or risk paying twice. Only meaningful alongside a
	// PaymentId, since you cannot reconcile a payment you cannot name.
	ReconcileThenDecide RetryClassification = "RECONCILE_THEN_DECIDE"
	// RetryWithNewIdentifier: terminal, and no settlement was ever awarded for it,
	// so a fresh request_id is safe to submit.
	RetryWithNewIdentifier RetryClassification = "RETRY_WITH_NEW_IDENTIFIER"
	// PollForCompletion: the operation is still running. Poll its status rather
	// than re-sending, and do not submit a new request_id until it is terminal.
	PollForCompletion RetryClassification = "POLL_FOR_COMPLETION"
	// NotRetryableFixRequest: the request is wrong. Fix it and re-send. Whether the
	// same request_id may be reused is answered by RequestIdReusable, not by this
	// value: an unserved corridor is also a fix-the-request condition and it does
	// spend the id.
	NotRetryableFixRequest RetryClassification = "NOT_RETRYABLE_FIX_REQUEST"
	// AlreadyDone: the operation had already completed. Read its current state
	// rather than submitting anything.
	AlreadyDone RetryClassification = "ALREADY_DONE"
	// ContactSupport: not resolvable by the caller. Quote request_id.
	ContactSupport RetryClassification = "CONTACT_SUPPORT"
)

// ErrorResponse is the only error shape returned to integrators. It is derived
// from an internal AtumError via ToErrorResponse. Never serialize a raw AtumError: its
// Message and Details may contain sensitive detail.
type ErrorResponse struct {
	// Public error category in SCREAMING_SNAKE_CASE. Many internal codes may map to one.
	Code string `json:"code"`

	// Curated, safe message shown to the user.
	Message string `json:"message"`

	// Correlation id the user quotes to support to find the internal record.
	RequestId string `json:"request_id,omitempty"`

	// The payment this error was raised against. Empty when the error is not about
	// a specific payment, which is every error raised before a payment exists.
	PaymentId string `json:"payment_id,omitempty"`

	// Docs page for this code.
	DocsUrl string `json:"docs_url,omitempty"`

	// Originating service domain.
	Domain string `json:"domain,omitempty"`

	// What the caller should do next. Empty means unclassified, which is not the
	// same as safe to retry.
	RetryClassification RetryClassification `json:"retry_classification,omitempty"`

	// Whether the caller may re-send this same request_id. True means no payment was
	// created for it, so the id is still free. False means a payment exists for it,
	// so the id is spent and re-sending only replays this outcome.
	//
	// Nil means undetermined, and a caller should read that as false: assuming an id
	// is free when it is not is the direction that wastes an attempt. Deliberately
	// separate from RetryClassification, which answers what the caller must change.
	RequestIdReusable *bool `json:"request_id_reusable,omitempty"`

	// Suggested HTTP status. Sent as the response status, not in the body.
	httpStatus int
}

// HTTPStatus is the status a handler should respond with. Defaults to 500 for a
// zero-value ErrorResponse.
func (p ErrorResponse) HTTPStatus() int {
	if p.httpStatus == 0 {
		return 500
	}
	return p.httpStatus
}

// The catalog data is the catalogJSON constant in the generated catalog_data.go,
// inlined from apis/error/v1/catalog.json by `make generate-error`. go:embed is
// avoided because it cannot reach a file outside this package directory.

// catalogEntry maps one internal code to its public presentation. Domain is not
// here: it comes from the AtumError.
type catalogEntry struct {
	PublicCode          string              `json:"public_code"`
	PublicMessage       string              `json:"public_message"`
	HTTPStatus          int                 `json:"http_status"`
	DocsSlug            string              `json:"docs_slug"`
	RetryClassification RetryClassification `json:"retry_classification,omitempty"`
	RequestIdReusable   *bool               `json:"request_id_reusable,omitempty"`
}

type errorCatalog struct {
	DocsBaseURL string                  `json:"docs_base_url"`
	Fallback    catalogEntry            `json:"fallback"`
	Entries     map[string]catalogEntry `json:"entries"`
}

// catalog is parsed once at init. A malformed catalog panics rather than degrade
// silently.
var catalog = mustLoadCatalog()

func mustLoadCatalog() errorCatalog {
	var c errorCatalog
	if err := json.Unmarshal([]byte(catalogJSON), &c); err != nil {
		panic(fmt.Sprintf("atumerror: invalid catalog data: %v", err))
	}
	return c
}

func lookup(code string) (catalogEntry, bool) {
	e, ok := catalog.Entries[code]
	return e, ok
}

// ToErrorResponse maps an internal AtumError to its ErrorResponse via the catalog. An
// unknown code falls back to INTERNAL_ERROR, so an internal message never leaks.
func (e *SchemaJson) ToErrorResponse() ErrorResponse {
	entry, ok := lookup(e.Code)
	if !ok {
		entry = catalog.Fallback
	}

	domain := ""
	if e.Domain != nil {
		domain = string(*e.Domain)
	}

	paymentID := ""
	if e.PaymentId != nil {
		paymentID = *e.PaymentId
	}

	return ErrorResponse{
		Code:      entry.PublicCode,
		Message:   entry.PublicMessage,
		RequestId: e.RequestId,
		PaymentId: paymentID,
		DocsUrl:   docsURL(entry.DocsSlug),
		Domain:    domain,
		// Both passed through from the catalog. Every entry carries a classification,
		// and an entry with no request_id_reusable leaves the field absent, which a
		// caller reads as not reusable.
		RetryClassification: entry.RetryClassification,
		RequestIdReusable:   entry.RequestIdReusable,
		httpStatus:          entry.HTTPStatus,
	}
}

func docsURL(slug string) string {
	if slug == "" {
		return ""
	}
	return catalog.DocsBaseURL + slug
}

// New builds an internal AtumError. Callers pass internal-only context; the
// user-facing text is owned by the catalog.
func New(code Code, message, requestID string, domain SchemaJsonDomain, details map[string]interface{}) *SchemaJson {
	d := domain
	return &SchemaJson{
		Code:      string(code),
		Message:   message,
		RequestId: requestID,
		Domain:    &d,
		Details:   details,
		Timestamp: time.Now().UTC(),
	}
}

// WithPaymentID names the payment this error was raised against, and returns the
// error so it can be chained onto New. A caller with no payment leaves it unset,
// and the field is then omitted from the wire rather than sent empty.
//
// Separate from New rather than a sixth positional argument: New already takes
// two adjacent strings, and a third would make transposing the request id and the
// payment id a silent mistake — which is the exact defect this field exists to fix.
func (e *SchemaJson) WithPaymentID(paymentID string) *SchemaJson {
	if e == nil || paymentID == "" {
		return e
	}
	e.PaymentId = &paymentID
	return e
}
