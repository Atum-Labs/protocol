package senderauth

import (
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// echo cuts to maxEchoLength code points exactly as a whole-string conversion would, including for
// invalid UTF-8, and reads no further than the cut.
func TestEcho(t *testing.T) {
	whole := func(s string) string {
		runes := []rune(s)
		if len(runes) <= maxEchoLength {
			return s
		}
		return string(runes[:maxEchoLength]) + "..."
	}
	for _, s := range []string{
		"",
		"short",
		strings.Repeat("a", maxEchoLength),
		strings.Repeat("a", maxEchoLength+1),
		strings.Repeat("é", maxEchoLength+1),
		strings.Repeat("😀", maxEchoLength+7),
		strings.Repeat("\xff", maxEchoLength+1),
		strings.Repeat("a", maxEchoLength-1) + "\xff\xfe" + "tail",
	} {
		require.Equal(t, whole(s), echo(s))
	}

	huge := strings.Repeat("😀", 4<<20) // 16 MiB
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	cut := echo(huge)
	runtime.ReadMemStats(&after)
	require.Less(t, after.TotalAlloc-before.TotalAlloc, uint64(64<<10), "echo must not convert the whole value")
	require.Equal(t, whole(huge), cut)
}
