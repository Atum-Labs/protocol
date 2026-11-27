package apierr

import (
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	atumerror "github.com/atum-labs/protocol/schemas/apis/error/v1/bindings/go"
)

// RegisterFallbackRoutes gives a router catalog-shaped answers for a path it does
// not serve and a method it does not allow.
//
// Without these, gin answers `404 page not found` as text/plain. That body carries
// no code, no retry classification and no docs link, so a caller's error handling
// cannot parse it at all, and it sits below the catalog entirely: a typo in an
// integrator's URL produces the one error shape nobody designed. A wrong method is
// worse, because gin reports it as 404 by default, which tells an integrator the
// route does not exist when in fact only their verb is wrong.
//
// domain is the calling service's own, so the response names the service the caller
// actually reached rather than a generic one.
func RegisterFallbackRoutes(router *gin.Engine, domain atumerror.SchemaJsonDomain) {
	// gin only routes to NoMethod when this is on. Off, a wrong verb falls through
	// to NoRoute and is reported as a missing path.
	router.HandleMethodNotAllowed = true

	router.NoRoute(func(c *gin.Context) {
		Respond(c, atumerror.New(
			atumerror.CodeNotFound,
			"no route for "+c.Request.Method+" "+c.Request.URL.Path,
			c.GetString(requestIDKey),
			domain,
			nil,
		))
	})

	router.NoMethod(func(c *gin.Context) {
		// RFC 9110 requires a 405 to name the methods the target does support, and
		// gin does not set the header itself. Without it a caller is told their verb
		// is wrong and given no way to discover the right one.
		if allow := allowedMethods(router, c.Request.URL.Path); allow != "" {
			c.Header("Allow", allow)
		}
		Respond(c, atumerror.New(
			atumerror.CodeMethodNotAllowed,
			c.Request.Method+" is not allowed on "+c.Request.URL.Path,
			c.GetString(requestIDKey),
			domain,
			nil,
		))
	})
}

// allowedMethods lists the methods registered for the route that path resolves to,
// as a value for the Allow header.
//
// Read from the router at request time rather than captured at registration, so it
// cannot depend on RegisterFallbackRoutes being called after every route is added.
func allowedMethods(router *gin.Engine, path string) string {
	seen := map[string]bool{}
	for _, r := range router.Routes() {
		if routeMatches(r.Path, path) {
			seen[r.Method] = true
		}
	}
	if len(seen) == 0 {
		return ""
	}
	methods := make([]string, 0, len(seen))
	for m := range seen {
		methods = append(methods, m)
	}
	sort.Strings(methods)
	return strings.Join(methods, ", ")
}

// routeMatches reports whether a gin route pattern resolves the given concrete
// path, treating `:param` as one segment and `*catchall` as the rest of the path.
func routeMatches(pattern, path string) bool {
	pat := strings.Split(strings.Trim(pattern, "/"), "/")
	got := strings.Split(strings.Trim(path, "/"), "/")
	for i, seg := range pat {
		if strings.HasPrefix(seg, "*") {
			return true
		}
		if i >= len(got) {
			return false
		}
		if strings.HasPrefix(seg, ":") {
			continue
		}
		if seg != got[i] {
			return false
		}
	}
	return len(pat) == len(got)
}
