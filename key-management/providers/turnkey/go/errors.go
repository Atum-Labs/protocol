package turnkey

import (
	"errors"
	"fmt"
	"net/http"
)

// Error is the typed Turnkey error. Transient=true means the caller
// should retry with backoff; Transient=false means escalate to operators
// (policy denial, auth misconfig, bad request).
type Error struct {
	StatusCode int
	Op         string
	Body       string
	Transient  bool
	Cause      error
}

func (e *Error) Error() string {
	switch {
	case e.Cause != nil && e.StatusCode == 0:
		return fmt.Sprintf("turnkey: %s: %v", e.Op, e.Cause)
	case e.StatusCode != 0 && e.Body != "":
		return fmt.Sprintf("turnkey: %s: HTTP %d: %s", e.Op, e.StatusCode, e.Body)
	case e.StatusCode != 0:
		return fmt.Sprintf("turnkey: %s: HTTP %d", e.Op, e.StatusCode)
	default:
		return "turnkey: unknown error"
	}
}

func (e *Error) Unwrap() error { return e.Cause }

// ErrTransient / ErrTerminal are sentinels callers check with errors.Is
// to dispatch on retry policy without unwrapping the typed error.
var (
	ErrTransient = errors.New("turnkey: transient (retryable)")
	ErrTerminal  = errors.New("turnkey: terminal (do not retry)")
)

// ErrActivityRejected marks an activity Turnkey accepted but did not complete: REJECTED, FAILED,
// or CONSENSUS_NEEDED when the caller does not wait. A policy denial can arrive this way as well
// as an HTTP 4xx.
var ErrActivityRejected = errors.New("turnkey: activity did not complete")

func (e *Error) Is(target error) bool {
	switch target {
	case ErrTransient:
		return e.Transient
	case ErrTerminal:
		return !e.Transient
	}
	return false
}

func classify(status int, op string, body []byte) *Error {
	e := &Error{StatusCode: status, Op: op, Body: string(body)}
	switch {
	case status == http.StatusRequestTimeout, status == http.StatusTooManyRequests, status >= 500:
		e.Transient = true
	default:
		e.Transient = false
	}
	return e
}
