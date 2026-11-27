package atumerror

// AtumError is the internal error record. It is an alias for the generated
// SchemaJson so callers use a readable name.
type AtumError = SchemaJson

// Code is a catalogued error code. New takes a Code so callers reach for a
// generated Code constant (codes.go) rather than an arbitrary string.
type Code string

// Error lets an AtumError flow through normal Go error handling. It returns
// internal detail and must never be written to a response: use ToErrorResponse
// (or the shared Respond helper) at the API boundary.
func (e *SchemaJson) Error() string {
	return e.Code + ": " + e.Message
}

// Catalogued reports whether a code has an explicit catalog entry. A code that
// is not catalogued maps to the generic INTERNAL_ERROR fallback.
func Catalogued(code string) bool {
	_, ok := catalog.Entries[code]
	return ok
}
