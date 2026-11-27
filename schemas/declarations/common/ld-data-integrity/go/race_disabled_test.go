//go:build !race

package lddataintegrity

// raceEnabled reports whether the tests run under the race detector, whose
// instrumentation inflates what each allocation-measuring test observes.
const raceEnabled = false
