package bidaward

// Version is the canonical declaration version every producer of
// BidAward v1 messages MUST emit on the wire (the schema's `version`
// field). The schema's regex locks the MAJOR component to the parent
// directory (v1 → 1.x); this constant pins the MINOR.
//
// Bumping it is a single-line change here that producers pick up via
// recompile. Any new field added to the schema additively (i.e. without
// breaking backward compatibility) lifts this to "1.N+1".
//
// The make verify-version target in schemas/Makefile asserts at CI time
// that this constant matches the schema's `version` regex.
const Version = "1.0"
