// Package apierr writes errors to HTTP clients as the shared ErrorResponse,
// deriving the public body and status from the error catalog so the internal
// AtumError is never leaked. It is the single error-writing boundary services
// should use instead of serializing errors by hand.
//
// It lives with the error system (catalog + binding) as its own module, so a
// service opts in by importing it. Services that do not adopt the error system
// carry no dependency on it.
package apierr

import (
	"errors"
	"log/slog"

	"github.com/gin-gonic/gin"

	atumerror "github.com/atum-labs/protocol/schemas/apis/error/v1/bindings/go"
)

// requestIDKey is the gin context key the request-id middleware sets.
const requestIDKey = "request_id"

// Respond writes err to the client as an ErrorResponse. It derives the public
// code, message, and HTTP status from the catalog via ToErrorResponse, so the
// internal message and details never cross the boundary. An error that is not
// an AtumError, or whose code has no catalog entry, maps to the generic 500
// fallback and is logged so the gap is visible.
func Respond(c *gin.Context, err error) {
	if err == nil {
		return
	}

	var ae *atumerror.AtumError
	if !errors.As(err, &ae) {
		// Not an AtumError: wrap it so its text stays internal and it maps to
		// the generic fallback (empty code is uncatalogued -> INTERNAL_ERROR 500).
		ae = &atumerror.AtumError{Message: err.Error(), RequestId: c.GetString(requestIDKey)}
	}
	if ae == nil {
		// errors.As reports true while leaving ae nil when the chain holds a
		// typed-nil *AtumError. Guard so the fallback never dereferences nil.
		ae = &atumerror.AtumError{RequestId: c.GetString(requestIDKey)}
	}

	if !atumerror.Catalogued(ae.Code) {
		slog.Error("error hit the ErrorResponse fallback", "code", ae.Code, "error", ae.Message)
	}

	resp := ae.ToErrorResponse()
	c.JSON(resp.HTTPStatus(), resp)
}
