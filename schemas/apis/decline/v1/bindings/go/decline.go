package atumdecline

import (
	"encoding/json"
	"fmt"
)

// ReasonCode is one internal decline reason, as named in apis/decline/v1/catalog.json.
// The generated constants in codes.go are the closed set at this catalog version.
type ReasonCode string

// PublicReason is the caller-facing projection of one decline reason. It is what a
// requester is told about why a settler did not bid, and it never carries the settler's
// own message: that is text this gateway neither authors nor validates.
type PublicReason struct {
	// Public reason category in SCREAMING_SNAKE_CASE. Several internal codes may map to one.
	Code string `json:"code"`

	// Curated, safe message describing the reason.
	Message string `json:"message"`

	// What would have to change for this settler to bid. Drawn from the error
	// catalog's closed set so a caller reads one vocabulary. It describes this
	// decline only: the authoritative instruction for the payment is the
	// retry_classification on its own error response.
	//
	// Optional on the wire, matching the published shape: a reader must not be made to
	// branch on an empty string where the member could simply be absent.
	RetryClassification string `json:"retry_classification,omitempty"`

	// DocsUrl links to the documentation for this reason. Absent rather than empty
	// when the catalog names no base url, so a reader never follows a link to the
	// site root.
	DocsUrl string `json:"docs_url,omitempty"`
}

// The catalog data is the catalogJSON constant in the generated catalog_data.go,
// inlined from apis/decline/v1/catalog.json by `make generate-decline`. go:embed is
// avoided because it cannot reach a file outside this package directory.

// catalogEntry maps one internal reason code to its public presentation.
type catalogEntry struct {
	PublicCode          string `json:"public_code"`
	PublicMessage       string `json:"public_message"`
	RetryClassification string `json:"retry_classification"`
	DocsSlug            string `json:"docs_slug"`
}

type declineCatalog struct {
	DocsBaseURL string                  `json:"docs_base_url"`
	Fallback    catalogEntry            `json:"fallback"`
	Entries     map[string]catalogEntry `json:"entries"`
}

// catalog is parsed once at init. A malformed catalog panics rather than degrade
// silently.
var catalog = mustLoadCatalog()

func mustLoadCatalog() declineCatalog {
	var c declineCatalog
	if err := json.Unmarshal([]byte(catalogJSON), &c); err != nil {
		panic(fmt.Sprintf("atumdecline: invalid catalog data: %v", err))
	}
	return c
}

// ReasonFor projects an internal reason code onto its public reason.
//
// An unknown code yields the fallback rather than an error. A settler running a newer
// catalog than this gateway is the expected case, not a fault, and counting it as OTHER
// keeps a decline summary exhaustive instead of dropping the settler from the tally.
func ReasonFor(code string) PublicReason {
	entry, ok := catalog.Entries[code]
	if !ok {
		entry = catalog.Fallback
	}
	return PublicReason{
		Code:                entry.PublicCode,
		Message:             entry.PublicMessage,
		RetryClassification: entry.RetryClassification,
		DocsUrl:             docsURL(entry.DocsSlug),
	}
}

// Known reports whether the code is named in this catalog. Use it to tell "a reason we
// deliberately bucket as OTHER" from "a reason we have never heard of", which ReasonFor
// alone cannot distinguish because both project to OTHER.
func Known(code string) bool {
	_, ok := catalog.Entries[code]
	return ok
}

// BidDecline is the settler-reported decline object. go-jsonschema names every root
// type SchemaJson, so this alias carries the name the schema titles it and the TypeScript
// binding already uses.
type BidDecline = SchemaJson

// ToPublicReason projects a settler-reported decline onto its public reason.
func (d BidDecline) ToPublicReason() PublicReason {
	return ReasonFor(d.ReasonCode)
}

// docsURL joins the catalog's base to a slug. Empty when either is missing, so an
// absent link is visibly absent rather than a url pointing at the site root.
func docsURL(slug string) string {
	if slug == "" || catalog.DocsBaseURL == "" {
		return ""
	}
	return catalog.DocsBaseURL + slug
}
