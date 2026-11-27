package senderauth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unicode"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type jsonMemberVectors struct {
	Ambiguous []struct {
		Name     string  `json:"name"`
		Document string  `json:"document"`
		Want     *string `json:"want"`
	} `json:"ambiguous"`
	Invalid []struct {
		Name           string `json:"name"`
		Document       string `json:"document"`
		DetailContains string `json:"detailContains"`
	} `json:"invalid"`
	Scoped []struct {
		Name     string   `json:"name"`
		Document string   `json:"document"`
		Read     []string `json:"read"`
		Want     *string  `json:"want"`
	} `json:"scoped"`
	ScopedInvalid []struct {
		Name           string   `json:"name"`
		Document       string   `json:"document"`
		Read           []string `json:"read"`
		DetailContains string   `json:"detailContains"`
	} `json:"scopedInvalid"`
}

func loadJSONMemberVectors(t testing.TB) jsonMemberVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "conformance", "json-member-vectors.json"))
	require.NoError(t, err)
	var v jsonMemberVectors
	require.NoError(t, json.Unmarshal(raw, &v))
	require.NotEmpty(t, v.Ambiguous)
	require.NotEmpty(t, v.Invalid)
	return v
}

func TestFirstAmbiguousMember_SharedVectors(t *testing.T) {
	v := loadJSONMemberVectors(t)
	for _, c := range v.Ambiguous {
		t.Run(c.Name, func(t *testing.T) {
			got, err := FirstAmbiguousMember([]byte(c.Document))
			require.NoError(t, err)
			want := ""
			if c.Want != nil {
				want = *c.Want
			}
			assert.Equal(t, want, got)
		})
	}
	// Named, since a depth vector's document is 20 KB. Where the vector names the reason, any other
	// refusal fails: a depth vector must be refused for its depth. Mirrors the TypeScript "refuses"
	// tests.
	for _, c := range v.Invalid {
		t.Run(c.Name, func(t *testing.T) {
			_, err := FirstAmbiguousMember([]byte(c.Document))
			require.ErrorIs(t, err, ErrInvalidJSON, "the document is not exactly one valid JSON value")
			if c.DetailContains != "" {
				assert.Contains(t, err.Error(), c.DetailContains)
			}
		})
	}
	names, documents := map[string]bool{}, map[string]string{}
	for _, c := range namedDocumentsOf(v) {
		assert.False(t, names[c.name], "duplicate vector name %q", c.name)
		names[c.name] = true
		earlier, repeated := documents[c.document]
		assert.False(t, repeated, "%q repeats the document of %q", c.name, earlier)
		documents[c.document] = c.name
	}
}

// Mirrors the TypeScript firstAmbiguousMemberIn tests.
func TestFirstAmbiguousMemberIn_SharedVectors(t *testing.T) {
	v := loadJSONMemberVectors(t)
	require.NotEmpty(t, v.Scoped)
	require.NotEmpty(t, v.ScopedInvalid)
	for _, c := range v.Scoped {
		t.Run(c.Name, func(t *testing.T) {
			got, err := FirstAmbiguousMemberIn([]byte(c.Document), c.Read)
			require.NoError(t, err)
			want := ""
			if c.Want != nil {
				want = *c.Want
			}
			assert.Equal(t, want, got)
		})
	}
	for _, c := range v.ScopedInvalid {
		t.Run(c.Name, func(t *testing.T) {
			_, err := FirstAmbiguousMemberIn([]byte(c.Document), c.Read)
			require.ErrorIs(t, err, ErrInvalidJSON)
			if c.DetailContains != "" {
				assert.Contains(t, err.Error(), c.DetailContains)
			}
		})
	}
}

type namedDocument struct{ name, document string }

func namedDocumentsOf(v jsonMemberVectors) []namedDocument {
	out := make([]namedDocument, 0, len(v.Ambiguous)+len(v.Invalid)+len(v.Scoped)+len(v.ScopedInvalid))
	for _, c := range v.Ambiguous {
		out = append(out, namedDocument{c.Name, c.Document})
	}
	for _, c := range v.Invalid {
		out = append(out, namedDocument{c.Name, c.Document})
	}
	for _, c := range v.Scoped {
		out = append(out, namedDocument{c.Name, c.Document})
	}
	for _, c := range v.ScopedInvalid {
		out = append(out, namedDocument{c.Name, c.Document})
	}
	return out
}

// Invalid UTF-8 cannot be carried by the shared vectors, which are themselves JSON text.
func TestFirstAmbiguousMember_RefusesInvalidUTF8(t *testing.T) {
	for _, document := range [][]byte{
		[]byte("{\"a\xf0\x90\x80\":1}"),
		[]byte("{\"a\":\"\xff\"}"),
	} {
		_, err := FirstAmbiguousMember(document)
		assert.ErrorIs(t, err, ErrInvalidJSON)
	}
}

// The scan refuses exactly the nesting encoding/json refuses.
func TestFirstAmbiguousMember_DepthLimitMatchesEncodingJSON(t *testing.T) {
	shapes := map[string]func(depth int) string{
		"arrays":  func(d int) string { return strings.Repeat("[", d) + strings.Repeat("]", d) },
		"objects": func(d int) string { return strings.Repeat(`{"a":`, d) + "1" + strings.Repeat("}", d) },
		"inside a context": func(d int) string {
			return `{"@context":` + strings.Repeat("[", d-1) + strings.Repeat("]", d-1) + `}`
		},
	}
	for name, shape := range shapes {
		t.Run(name, func(t *testing.T) {
			for _, depth := range []int{MaxJSONDepth, MaxJSONDepth + 1} {
				document := []byte(shape(depth))
				_, err := FirstAmbiguousMember(document)
				assert.Equal(t, json.Valid(document), err == nil, "depth %d: %v", depth, err)
			}
			_, err := FirstAmbiguousMember([]byte(shape(MaxJSONDepth + 1)))
			require.ErrorIs(t, err, ErrInvalidJSON)
			assert.Contains(t, err.Error(), "levels deep")
		})
	}
}

func TestFirstAmbiguousMember_MemoryIsLinearInDepth(t *testing.T) {
	for name, document := range map[string][]byte{
		"arrays":  []byte(strings.Repeat("[", MaxJSONDepth) + strings.Repeat("]", MaxJSONDepth)),
		"objects": []byte(strings.Repeat(`{"key":`, MaxJSONDepth) + "1" + strings.Repeat("}", MaxJSONDepth)),
	} {
		t.Run(name, func(t *testing.T) {
			var before, after runtime.MemStats
			runtime.GC()
			runtime.ReadMemStats(&before)
			_, err := FirstAmbiguousMember(document)
			runtime.ReadMemStats(&after)
			require.NoError(t, err)
			assert.Less(t, after.TotalAlloc-before.TotalAlloc, uint64(16<<20))
		})
	}
}

// foldMemberName must agree with strings.EqualFold, the relation encoding/json matches names by.
func TestFoldMemberName_AgreesWithEqualFold(t *testing.T) {
	for r := rune(0); r <= unicode.MaxRune; r++ {
		for f := unicode.SimpleFold(r); f != r; f = unicode.SimpleFold(f) {
			require.True(t, strings.EqualFold(string(r), string(f)))
			require.Equal(t, foldMemberName(string(r)), foldMemberName(string(f)), "U+%04X and U+%04X", r, f)
		}
	}
	assert.NotEqual(t, foldMemberName("a"), foldMemberName("b"))
}
