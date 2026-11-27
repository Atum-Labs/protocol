package apierr

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	atumerror "github.com/atum-labs/protocol/schemas/apis/error/v1/bindings/go"
)

func init() { gin.SetMode(gin.TestMode) }

// A 405 must name the methods the target supports, per RFC 9110.
func TestNoMethod_SetsAllow(t *testing.T) {
	r := gin.New()
	r.GET("/v1/payments/:paymentId", func(c *gin.Context) {})
	r.PATCH("/v1/payments/:paymentId", func(c *gin.Context) {})
	RegisterFallbackRoutes(r, atumerror.SchemaJsonDomainPAYMENTGATEWAY)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/v1/payments/abc", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Allow"); got != "GET, PATCH" {
		t.Fatalf("Allow = %q, want %q", got, "GET, PATCH")
	}
}

// An unrouted path is a 404, and carries no Allow header to imply otherwise.
func TestNoRoute_HasNoAllow(t *testing.T) {
	r := gin.New()
	r.GET("/v1/payments", func(c *gin.Context) {})
	RegisterFallbackRoutes(r, atumerror.SchemaJsonDomainPAYMENTGATEWAY)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/nope", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := rec.Header().Get("Allow"); got != "" {
		t.Fatalf("Allow = %q, want empty on a 404", got)
	}
}

func TestRouteMatches(t *testing.T) {
	cases := []struct {
		pattern, path string
		want          bool
	}{
		{"/v1/payments", "/v1/payments", true},
		{"/v1/payments/:id", "/v1/payments/abc", true},
		{"/v1/payments/:id", "/v1/payments", false},
		{"/v1/payments/:id", "/v1/payments/abc/timeline", false},
		{"/v1/payments/:id/timeline", "/v1/payments/abc/timeline", true},
		{"/static/*filepath", "/static/a/b/c", true},
		{"/v1/payments", "/v1/quotes", false},
		{"/", "/", true},
	}
	for _, c := range cases {
		if got := routeMatches(c.pattern, c.path); got != c.want {
			t.Errorf("routeMatches(%q, %q) = %v, want %v", c.pattern, c.path, got, c.want)
		}
	}
}
