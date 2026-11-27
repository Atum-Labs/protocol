package lddataintegrity

import (
	"errors"
	"fmt"

	"github.com/piprate/json-gold/ld"
)

// Canonicalize performs URDNA2015 canonicalization on a JSON-LD document
// against the given document loader. Returns the canonical n-quads as a
// string (the format URDNA2015 produces).
//
// The W3C Data Integrity 1.0 signing pipeline uses canonical n-quads as
// the pre-hash input — both the document (without proof) and the proof
// options (without proofValue/jws) get canonicalized + hashed
// separately, then combined per the cryptosuite-specific algorithm
// (see hash.go).
//
// Cross-language byte-equality with the TS signer's `canonicalize`
// (FQ's signing/typescript/src/canonicalize.ts) is the
// load-bearing invariant — both sides MUST produce identical n-quads
// from identical input or the cross-language fixture roundtrip silently
// breaks. Pin this with the conformance fixtures, not just unit tests.
//
// Failure modes:
//   - *AdmissionError (matching ErrNotCanonicalizable), returned as is,
//     when doc is refused before canonicalization, because json-gold
//     offers no bound on the work a small, adversarially shaped document
//     can demand of it. CheckCanonicalizable bounds the document's size
//     and refuses self-defined terms and self-named blank nodes. The
//     expanded dataset is then refused if it holds too many blank nodes,
//     or two blank nodes canonicalization could tell apart only by
//     searching permutations.
//   - ErrUnknownContext (wrapped) when doc references a @context URL
//     not in the loader's registered set. SSRF defense: fail-closed
//     instead of HTTP-fetching the unknown URL.
//   - ErrCanonicalizationFailed (wrapped) when json-gold cannot process a
//     document the admission rules let through: it panics, as it does for a
//     graph container holding a number (the panic is contained here, so no
//     caller has to recover from it), or it refuses the document while
//     converting it to a dataset, as it does for a nested @context that
//     redefines a protected term. json-gold's own error stays in the chain.
//   - other json-gold errors, wrapped with %w under a
//     "lddataintegrity.Canonicalize:" prefix: a failure to load or read one of
//     the registered contexts, and any error from the canonicalization step,
//     which only the options set here can cause. These are faults on this side.
func Canonicalize(doc any, loader *DocumentLoader) (string, error) {
	if loader == nil {
		// Defensive: callers SHOULD construct a loader via
		// NewDocumentLoader. A nil loader would fall through to
		// json-gold's default which network-fetches contexts — exactly
		// the SSRF surface the lib exists to close. Fail fast.
		return "", fmt.Errorf("lddataintegrity.Canonicalize: nil DocumentLoader")
	}
	if err := CheckCanonicalizable(doc); err != nil {
		return "", err
	}
	// This is json-gold's own Normalize, split where it converts the document to a
	// dataset and before it canonicalizes that dataset, with the same options on each
	// side, so that the dataset can be checked in between without changing the output.
	opts := ld.NewJsonLdOptions("")
	opts.Algorithm = ld.AlgorithmURDNA2015
	opts.Format = "application/n-quads"
	// Some json-gold releases replace a loader error with their own, dropping it from
	// the chain, which would hide ErrUnknownContext from callers.
	// Recording the refusal here, per call, restores it whatever the release does.
	refusals := &refusalRecorder{loader: loader}
	opts.DocumentLoader = refusals

	toRDFOpts := ld.NewJsonLdOptions(opts.Base)
	toRDFOpts.ProcessingMode = opts.ProcessingMode
	toRDFOpts.Format = ""
	toRDFOpts.DocumentLoader = opts.DocumentLoader

	var datasetObj any
	err := containPanic(func() (err error) {
		datasetObj, err = ld.NewJsonLdProcessor().ToRDF(doc, toRDFOpts)
		return err
	})
	if err != nil {
		if refusals.url != "" && !errors.Is(err, ErrUnknownContext) {
			return "", fmt.Errorf("lddataintegrity.Canonicalize: %w: %s", ErrUnknownContext, refusals.url)
		}
		return "", classifyJSONGoldError(err)
	}
	dataset, ok := datasetObj.(*ld.RDFDataset)
	if !ok {
		return "", fmt.Errorf("lddataintegrity.Canonicalize: json-gold returned %T for a dataset", datasetObj)
	}
	if err := checkDataset(dataset); err != nil {
		return "", err
	}

	var result any
	err = containPanic(func() (err error) {
		result, err = ld.NewJsonLdApi().Normalize(dataset, opts)
		return err
	})
	if err != nil {
		return "", fmt.Errorf("lddataintegrity.Canonicalize: %w", err)
	}
	nquads, ok := result.(string)
	if !ok {
		// json-gold's Normalize returns string when Format is set to
		// "application/n-quads" — this is a defensive check against
		// a future library change.
		return "", fmt.Errorf("lddataintegrity.Canonicalize: json-gold returned non-string for n-quads format")
	}
	return nquads, nil
}

// refusalRecorder passes context requests to a DocumentLoader and remembers the first
// URL it refused as unknown. It serves a single Canonicalize call, so it is never
// shared between goroutines.
type refusalRecorder struct {
	loader *DocumentLoader
	url    string
}

func (r *refusalRecorder) LoadDocument(u string) (*ld.RemoteDocument, error) {
	doc, err := r.loader.LoadDocument(u)
	if err != nil && r.url == "" && errors.Is(err, ErrUnknownContext) {
		r.url = u
	}
	return doc, err
}

// classifyJSONGoldError labels an error json-gold returned while converting the
// document to a dataset as ErrCanonicalizationFailed, so callers can tell a document
// they must not retry from a fault on this side. The caller chooses the document and
// which registered contexts it combines, so such an error is the caller's. Errors
// only the registered contexts themselves can cause stay unlabelled: a context that
// fails to load or is not a context object, and a malformed entry inside one, which a
// caller cannot write since admission accepts only context URLs.
func classifyJSONGoldError(err error) error {
	var jsonLDErr *ld.JsonLdError
	if errors.As(err, &jsonLDErr) {
		switch jsonLDErr.Code {
		case ld.LoadingDocumentFailed, ld.LoadingRemoteContextFailed, ld.InvalidRemoteContext,
			ld.InvalidLocalContext, ld.InvalidContextEntry:
		default:
			return fmt.Errorf("lddataintegrity.Canonicalize: %w: %w", ErrCanonicalizationFailed, err)
		}
	}
	return fmt.Errorf("lddataintegrity.Canonicalize: %w", err)
}

// containPanic runs f and returns ErrCanonicalizationFailed if it panics. The panic
// value is dropped rather than reported, since it may quote the document.
func containPanic(f func() error) (err error) {
	defer func() {
		if recover() != nil {
			err = ErrCanonicalizationFailed
		}
	}()
	return f()
}
