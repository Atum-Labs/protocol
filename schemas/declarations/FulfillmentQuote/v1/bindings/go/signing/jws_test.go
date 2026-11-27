package ldverification

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func encodeHeader(t *testing.T, alg string, b64 bool) string {
	t.Helper()
	h, err := json.Marshal(JWSHeader{Alg: alg, B64: b64, Crit: []string{"b64"}})
	if err != nil {
		t.Fatalf("marshal header: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(h)
}

func TestParseDetachedJWS_Valid(t *testing.T) {
	header := encodeHeader(t, "ES256K-R", false)
	sig := make([]byte, 65)
	jws := header + ".." + base64.RawURLEncoding.EncodeToString(sig)

	h, s, err := ParseDetachedJWS(jws)
	if err != nil {
		t.Fatalf("expected ok, got %v", err)
	}
	if h.Alg != "ES256K-R" {
		t.Errorf("alg = %q", h.Alg)
	}
	if len(s) != 65 {
		t.Errorf("sig len = %d", len(s))
	}
}

func TestParseDetachedJWS_Errors(t *testing.T) {
	cases := []struct {
		name string
		jws  string
		want string
	}{
		{
			name: "missing separator",
			jws:  "header.signature",
			want: "expected header..signature",
		},
		{
			name: "wrong algorithm",
			jws:  encodeHeader(t, "RS256", false) + ".." + base64.RawURLEncoding.EncodeToString(make([]byte, 65)),
			want: "unsupported alg",
		},
		{
			name: "b64 must be false",
			jws:  encodeHeader(t, "ES256K-R", true) + ".." + base64.RawURLEncoding.EncodeToString(make([]byte, 65)),
			want: "b64=false",
		},
		{
			name: "wrong signature length",
			jws:  encodeHeader(t, "ES256K-R", false) + ".." + base64.RawURLEncoding.EncodeToString(make([]byte, 64)),
			want: "65 bytes",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := ParseDetachedJWS(tc.jws)
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %q, want substring %q", err.Error(), tc.want)
			}
		})
	}
}
