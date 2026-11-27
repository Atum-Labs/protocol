package registry

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// writeOverlay writes files into a fresh directory and returns it.
func writeOverlay(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

const localnetV4 = `{"chain":"solana:localnet","name":"Solana Localnet","mainnet":false,"versions":[{"id":"v4","source":"s","escrow":"CFKUVjrHDt1cXXzHMTCbHj5NxFZjtCqxxTc2k61gry7R","fulfillmentProxies":["FLNuCtE9w1qsyr2wjDSf1BCy7KCR6pvnVYht2KaY2dAn"],"signature":{"svmDomainVersion":5}}]}`

func TestLoadWithOverlayAddsAChain(t *testing.T) {
	dir := writeOverlay(t, map[string]string{"solana_localnet.json": localnetV4, "README.md": "not a chain file"})
	r, err := LoadWithOverlay(dir)
	if err != nil {
		t.Fatalf("LoadWithOverlay: %v", err)
	}
	v, ok := r.VersionOfEscrow("solana:localnet", "CFKUVjrHDt1cXXzHMTCbHj5NxFZjtCqxxTc2k61gry7R")
	if !ok || v.ID != "v4" {
		t.Fatalf("VersionOfEscrow on the overlay chain = %+v, %v", v, ok)
	}
	if _, ok := r.Chain("SOLANA:LOCALNET"); !ok {
		t.Error("an overlay chain must be found regardless of case")
	}
	embedded := mustLoad(t)
	if _, ok := embedded.Chain("solana:localnet"); ok {
		t.Fatal("the overlay leaked into the embedded registry")
	}
	for _, c := range embedded.Chains() {
		a, _ := r.Chain(c)
		b, _ := embedded.Chain(c)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("%s changed under the overlay", c)
		}
	}
	if got, want := len(r.Chains()), len(embedded.Chains())+1; got != want {
		t.Errorf("%d chains with the overlay, want %d", got, want)
	}
}

func TestLoadWithOverlayEmptyDirIsEmbedded(t *testing.T) {
	r, err := LoadWithOverlay("")
	if err != nil {
		t.Fatalf("LoadWithOverlay(\"\"): %v", err)
	}
	if !reflect.DeepEqual(r.Chains(), mustLoad(t).Chains()) {
		t.Fatal("LoadWithOverlay(\"\") differs from Load")
	}
}

func TestLoadWithOverlayRefusesAnEmbeddedChain(t *testing.T) {
	devnet := "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
	body := strings.Replace(localnetV4, `"solana:localnet"`, `"`+devnet+`"`, 1)
	lower := strings.Replace(localnetV4, `"solana:localnet"`, `"`+strings.ToLower(devnet)+`"`, 1)
	cases := map[string]map[string]string{
		"same chain id":       {"solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1.json": body},
		"chain id other case": {"solana_etwtrabzayq6imfeykouru166vu2xqa1.json": lower},
	}
	for name, files := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := LoadWithOverlay(writeOverlay(t, files))
			if err == nil || !strings.Contains(err.Error(), "may only add chains") {
				t.Fatalf("LoadWithOverlay = %v, want error containing %q", err, "may only add chains")
			}
		})
	}
}

func TestLoadWithOverlayValidatesFiles(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{"file name differs from chain", map[string]string{"solana_other.json": localnetV4}, "want file solana_localnet.json"},
		{"unknown field", map[string]string{"solana_localnet.json": strings.Replace(localnetV4, `"mainnet":false`, `"mainnet":false,"extra":1`, 1)}, "unknown field"},
		{"no versions", map[string]string{"solana_localnet.json": `{"chain":"solana:localnet","name":"n","mainnet":false,"versions":[]}`}, "at least one version"},
		{"EVM domain on Solana", map[string]string{"solana_localnet.json": strings.Replace(localnetV4, `{"svmDomainVersion":5}`, `{"eip712Name":"Escrow","eip712Version":"3"}`, 1)}, "needs svmDomainVersion"},
		{"unknown message scheme", map[string]string{"solana_localnet.json": strings.Replace(localnetV4, `{"svmDomainVersion":5}`, `{"svmDomainVersion":5,"svmMessage":"no-such-scheme"}`, 1)}, "not a known message scheme"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := LoadWithOverlay(writeOverlay(t, tc.files))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("LoadWithOverlay = %v, want error containing %q", err, tc.want)
			}
		})
	}
	if _, err := LoadWithOverlay(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Error("LoadWithOverlay accepted a directory that does not exist")
	}
}

// TestLocalnetOverlayMatchesTheDockerAccounts loads overlays/localnet and checks its escrows and
// proxy against the program ids the docker localnet deploys (contracts/svm/docker/accounts.sh).
func TestLocalnetOverlayMatchesTheDockerAccounts(t *testing.T) {
	r, err := LoadWithOverlay("overlays/localnet")
	if err != nil {
		t.Fatalf("LoadWithOverlay(overlays/localnet): %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(repoRoot, "contracts/svm/docker/accounts.sh"))
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for _, m := range regexp.MustCompile(`(?m)^(LOCAL_\w+_PROGRAM_ID)="(\w+)"`).FindAllStringSubmatch(string(raw), -1) {
		ids[m[1]] = m[2]
	}
	want := []struct{ id, escrowVar, message string }{
		{"v4", "LOCAL_ESCROW_PROGRAM_ID", ""},
		{"v5", "LOCAL_ESCROW_V5_PROGRAM_ID", "escrow-text-v1"},
	}
	c, _ := r.Chain("solana:localnet")
	if len(c.Versions) != len(want) {
		t.Fatalf("solana:localnet has %d versions, want %d", len(c.Versions), len(want))
	}
	for _, w := range want {
		v, ok := r.Version("solana:localnet", w.id)
		if !ok {
			t.Fatalf("solana:localnet has no %s", w.id)
		}
		if ids[w.escrowVar] == "" || v.Escrow != ids[w.escrowVar] {
			t.Errorf("%s escrow %s, accounts.sh %s=%q", w.id, v.Escrow, w.escrowVar, ids[w.escrowVar])
		}
		if !reflect.DeepEqual(v.FulfillmentProxies, []string{ids["LOCAL_FULFILLMENT_PROXY_PROGRAM_ID"]}) {
			t.Errorf("%s proxies %v, accounts.sh proxy %q", w.id, v.FulfillmentProxies, ids["LOCAL_FULFILLMENT_PROXY_PROGRAM_ID"])
		}
		if v.Signature.SVMMessage != w.message {
			t.Errorf("%s svmMessage %q, want %q", w.id, v.Signature.SVMMessage, w.message)
		}
	}
}
