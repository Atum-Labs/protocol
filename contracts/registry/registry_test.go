package registry

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

// repoRoot is where a version's Source path is relative to.
const repoRoot = "../.."

func mustLoad(t *testing.T) *Registry {
	t.Helper()
	r, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return r
}

// TestSignatureDomainsMatchTheContractSource pins each version's domain to the source the
// signers encode against, so a registry entry cannot claim a domain nothing signs.
func TestSignatureDomainsMatchTheContractSource(t *testing.T) {
	sol, err := os.ReadFile(filepath.Join(repoRoot, "contracts/evm/source/src/Escrow.sol"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`EIP712\("([^"]+)",\s*"([^"]+)"\)`).FindSubmatch(sol)
	if m == nil {
		t.Fatal("no EIP712 domain in Escrow.sol")
	}
	rs, err := os.ReadFile(filepath.Join(repoRoot, "contracts/svm/source/programs/escrow/src/state.rs"))
	if err != nil {
		t.Fatal(err)
	}
	sm := regexp.MustCompile(`CURRENT_SIGNATURE_DOMAIN_VERSION: u8 = (\d+)`).FindSubmatch(rs)
	if sm == nil {
		t.Fatal("no CURRENT_SIGNATURE_DOMAIN_VERSION in state.rs")
	}
	svm, _ := strconv.Atoi(string(sm[1]))
	xs, err := os.ReadFile(filepath.Join(repoRoot, "contracts/stellar/source/contracts/escrow/src/signatures.rs"))
	if err != nil {
		t.Fatal(err)
	}
	xm := regexp.MustCompile(`SIGNATURE_DOMAIN_VERSION: u8 = (\d+)`).FindSubmatch(xs)
	if xm == nil {
		t.Fatal("no SIGNATURE_DOMAIN_VERSION in the Stellar escrow's signatures.rs")
	}
	stellar, _ := strconv.Atoi(string(xm[1]))

	// Only the newest version per chain follows today's source. Older versions keep the domain
	// they were deployed with, so a future domain bump must not rewrite them.
	r := mustLoad(t)
	for _, chain := range r.Chains() {
		c, _ := r.Chain(chain)
		for _, v := range c.Versions[len(c.Versions)-1:] {
			s := v.Signature
			switch {
			case strings.HasPrefix(chain, "stellar:"):
				if s.StellarDomainVersion != stellar || s.EIP712Name != "" || s.SVMDomainVersion != 0 {
					t.Errorf("%s %s: signature %+v, want stellarDomainVersion %d only", chain, v.ID, s, stellar)
				}
			case strings.HasPrefix(chain, "solana:"):
				if s.SVMDomainVersion != svm || s.EIP712Name != "" {
					t.Errorf("%s %s: signature %+v, want svmDomainVersion %d only", chain, v.ID, s, svm)
				}
			default:
				if s.EIP712Name != string(m[1]) || s.EIP712Version != string(m[2]) || s.SVMDomainVersion != 0 {
					t.Errorf("%s %s: signature %+v, Escrow.sol has EIP712(%q, %q)", chain, v.ID, s, m[1], m[2])
				}
			}
		}
	}
}

func TestValidateRefusesBrokenChains(t *testing.T) {
	evmSig := Signature{EIP712Name: "Escrow", EIP712Version: "3"}
	ok := Version{ID: "v4", Source: "s", Escrow: "0xAA", FulfillmentProxies: []string{"0xBB"}, Signature: evmSig}
	cases := []struct {
		name string
		c    Chain
		want string
	}{
		{"no versions", Chain{Chain: "eip155:1", Name: "n"}, "at least one version"},
		{"no chain", Chain{Name: "n", Versions: []Version{ok}}, "at least one version"},
		{"newest first", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{{ID: "v5", Source: "s", Escrow: "0xCC", FulfillmentProxies: []string{"0xBB"}, Signature: evmSig}, ok}}, "oldest first"},
		{"EVM version without a domain", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{{ID: "v4", Source: "s", Escrow: "0xAA", FulfillmentProxies: []string{"0xBB"}}}}, "needs eip712Name"},
		{"EVM version with an SVM domain", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{{ID: "v4", Source: "s", Escrow: "0xAA", FulfillmentProxies: []string{"0xBB"}, Signature: Signature{EIP712Name: "Escrow", EIP712Version: "3", SVMDomainVersion: 5}}}}, "no svmDomainVersion"},
		{"Solana version with an EIP-712 domain", Chain{Chain: "solana:x", Name: "n", Versions: []Version{{ID: "v4", Source: "s", Escrow: "A", FulfillmentProxies: []string{"B"}, Signature: evmSig}}}, "Solana version needs"},
		{"Stellar version with an EIP-712 domain", Chain{Chain: "stellar:x", Name: "n", Versions: []Version{{ID: "v4", Source: "s", Escrow: "C", FulfillmentProxies: []string{"D"}, Signature: evmSig}}}, "Stellar version needs"},
		{"Stellar version over one byte", Chain{Chain: "stellar:x", Name: "n", Versions: []Version{{ID: "v4", Source: "s", Escrow: "C", FulfillmentProxies: []string{"D"}, Signature: Signature{StellarDomainVersion: 256}}}}, "one byte"},
		{"EVM version with a Stellar domain", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{{ID: "v4", Source: "s", Escrow: "0xAA", FulfillmentProxies: []string{"0xBB"}, Signature: Signature{EIP712Name: "Escrow", EIP712Version: "3", StellarDomainVersion: 2}}}}, "Stellar versions only"},
		{"no name", Chain{Chain: "eip155:1", Versions: []Version{ok}}, "at least one version"},
		{"empty id", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{{Source: "s", Escrow: "0xAA", FulfillmentProxies: []string{"0xBB"}}}}, "required"},
		{"empty source", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{{ID: "v4", Escrow: "0xAA", FulfillmentProxies: []string{"0xBB"}}}}, "required"},
		{"missing escrow", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{{ID: "v4", Source: "s", FulfillmentProxies: []string{"0xBB"}}}}, "required"},
		{"missing proxies", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{{ID: "v4", Source: "s", Escrow: "0xAA"}}}, "required"},
		{"duplicate id", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{ok, {ID: "v4", Source: "s", Escrow: "0xCC", FulfillmentProxies: []string{"0xBB"}, Signature: evmSig}}}, "appears twice"},
		{"same escrow, two ids, case folded", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{ok, {ID: "v5", Source: "s", Escrow: "0xaa", FulfillmentProxies: []string{"0xBB"}, Signature: evmSig}}}, "under both"},
		{"Solana version with a text message scheme", Chain{Chain: "solana:x", Name: "n", Versions: []Version{{ID: "v4", Source: "s", Escrow: "A", FulfillmentProxies: []string{"B"}, Signature: Signature{SVMDomainVersion: 5, SVMMessage: "text"}}}}, "not a known message scheme"},
		{"Solana domain version over one byte", Chain{Chain: "solana:x", Name: "n", Versions: []Version{{ID: "v4", Source: "s", Escrow: "A", FulfillmentProxies: []string{"B"}, Signature: Signature{SVMDomainVersion: 256}}}}, "does not fit in one byte"},
		{"EVM version with an SVM message scheme", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{{ID: "v4", Source: "s", Escrow: "0xAA", FulfillmentProxies: []string{"0xBB"}, Signature: Signature{EIP712Name: "Escrow", EIP712Version: "3", SVMMessage: "text"}}}}, "no svmDomainVersion or svmMessage"},
		{"unrecorded proxy not listed", Chain{Chain: "eip155:1", Name: "n", Versions: []Version{{ID: "v4", Source: "s", Escrow: "0xAA", FulfillmentProxies: []string{"0xBB"}, UnrecordedFulfillmentProxies: map[string]string{"0xDD": "why"}, Signature: evmSig}}}, "not in fulfillmentProxies"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.c.validate()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("validate() = %v, want error containing %q", err, tc.want)
			}
		})
	}
	shared := Chain{Chain: "eip155:4217", Name: "n", Versions: []Version{ok, {ID: "v5", Source: "s", Escrow: "0xCC", FulfillmentProxies: []string{"0xBB"}, Signature: evmSig}}}
	if err := shared.validate(); err != nil {
		t.Fatalf("a proxy shared by two versions must be allowed: %v", err)
	}
}

func TestSignatureValidate(t *testing.T) {
	cases := []struct {
		name  string
		chain string
		s     Signature
		want  string // "" = valid
	}{
		{"Solana raw, version 1", "solana:x", Signature{SVMDomainVersion: 1}, ""},
		{"Solana raw, version 255", "solana:x", Signature{SVMDomainVersion: 255}, ""},
		{"Solana version 256", "solana:x", Signature{SVMDomainVersion: 256}, "one byte"},
		{"Solana version 0", "solana:x", Signature{}, "needs svmDomainVersion"},
		{"Solana version negative", "solana:x", Signature{SVMDomainVersion: -1}, "needs svmDomainVersion"},
		{"Solana text scheme", "solana:x", Signature{SVMDomainVersion: 5, SVMMessage: "text"}, "not a known message scheme"},
		{"Solana scheme of one space", "solana:x", Signature{SVMDomainVersion: 5, SVMMessage: " "}, "not a known message scheme"},
		{"EVM", "eip155:1", Signature{EIP712Name: "Escrow", EIP712Version: "3"}, ""},
		{"Tron", "tron:mainnet", Signature{EIP712Name: "Escrow", EIP712Version: "3"}, ""},
		{"EVM with svmMessage", "eip155:1", Signature{EIP712Name: "Escrow", EIP712Version: "3", SVMMessage: "text"}, "no svmDomainVersion or svmMessage"},
		{"Tron with svmMessage", "tron:mainnet", Signature{EIP712Name: "Escrow", EIP712Version: "3", SVMMessage: "text"}, "no svmDomainVersion or svmMessage"},
	}
	for _, tc := range cases {
		err := tc.s.validate(tc.chain)
		if tc.want == "" {
			if err != nil {
				t.Errorf("%s: %v", tc.name, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want %q", tc.name, err, tc.want)
		}
	}
}

func TestVersionOfEscrow(t *testing.T) {
	r := mustLoad(t)
	const (
		tempoV4  = "0x815d450F443466d52D3c1fB7a57D74D463D1E6F0"
		tempoV5  = "0xedaD6a9846c79A64449603e95F8c77fd5A46881b"
		tronV4   = "TYj48kPL31aMpJfm2LKi96e9hEfVKGmv5Y"
		solMain  = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
		solEsc   = "5BD9UAUCRCg6Chv6CS5k4sBHGd7CciWpng9u7iJxJFjx"
		tempoPxy = "0xA8F40Ed7437BCB6bF264832369e8364b80B06c83"
	)
	cases := []struct {
		name, chain, addr, want string // want "" = not found
	}{
		{"EVM exact", "eip155:4217", tempoV4, "v4"},
		{"EVM lower case", "eip155:4217", strings.ToLower(tempoV4), "v4"},
		{"EVM upper case body", "eip155:4217", "0x" + strings.ToUpper(tempoV4[2:]), "v4"},
		{"EVM second version", "eip155:4217", tempoV5, "v5"},
		{"EVM chain id upper case", "EIP155:4217", tempoV5, "v5"},
		{"EVM chain id and address case both changed", "EIP155:4217", strings.ToLower(tempoV5), "v5"},
		{"EVM escrow of another chain", "eip155:42161", tempoV5, ""},
		{"EVM proxy is not an escrow", "eip155:4217", tempoPxy, ""},
		{"Tron exact", "tron:mainnet", tronV4, "v4"},
		{"Tron case changed", "tron:mainnet", strings.ToLower(tronV4), ""},
		{"Tron chain id upper case", "TRON:MAINNET", tronV4, "v4"},
		{"Solana exact", solMain, solEsc, "v4"},
		{"Solana address lower case", solMain, strings.ToLower(solEsc), ""},
		{"Solana chain id lower case", strings.ToLower(solMain), solEsc, "v4"},
		{"Solana escrow on the other cluster", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", solEsc, ""},
		{"unknown chain", "eip155:999999", tempoV4, ""},
		{"empty chain", "", tempoV4, ""},
		{"empty address", "eip155:4217", "", ""},
	}
	for _, tc := range cases {
		v, ok := r.VersionOfEscrow(tc.chain, tc.addr)
		if ok != (tc.want != "") || v.ID != tc.want {
			t.Errorf("%s: VersionOfEscrow = %q, %v, want %q", tc.name, v.ID, ok, tc.want)
		}
		if got := r.HasEscrow(tc.chain, tc.addr); got != ok {
			t.Errorf("%s: HasEscrow = %v, VersionOfEscrow found = %v", tc.name, got, ok)
		}
	}
}

func TestChainLookupFoldsCase(t *testing.T) {
	r := mustLoad(t)
	const sol = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
	cases := []struct{ in, want string }{
		{sol, sol},
		{strings.ToLower(sol), sol},
		{strings.ToUpper(sol), sol},
		{"EIP155:1", "eip155:1"},
		{"eip155:999999", ""},
		{"", ""},
	}
	for _, tc := range cases {
		c, ok := r.Chain(tc.in)
		if ok != (tc.want != "") || c.Chain != tc.want {
			t.Errorf("Chain(%q) = %q, %v, want %q", tc.in, c.Chain, ok, tc.want)
		}
	}
	if _, ok := r.Version(strings.ToLower(sol), "v4"); !ok {
		t.Error("Version with a lower case Solana chain id missing")
	}
	if !r.HasProxy(strings.ToLower(sol), "CMxMPzpmeJPJbyUK4DDSDEhEYdCCAUt7w5cr5SWEHoNJ") {
		t.Error("HasProxy with a lower case Solana chain id missing")
	}
	if r.HasProxy(sol, strings.ToLower("CMxMPzpmeJPJbyUK4DDSDEhEYdCCAUt7w5cr5SWEHoNJ")) {
		t.Error("HasProxy folded a Solana address")
	}
}

func TestAllowed(t *testing.T) {
	r := mustLoad(t)
	// The list keeps the registry's mixed case chain ids; payment-gw looks chains up lower case.
	l, err := ParseEnvList("eip155:4217=v5,v4;solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp=v4;tron:mainnet=v4")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.CheckEnvList(l); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, chain string
		want        string // version ids in order
	}{
		{"EVM, list order kept", "eip155:4217", "v5,v4"},
		{"EVM, upper case", "EIP155:4217", "v5,v4"},
		{"Solana, exact", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "v4"},
		{"Solana, lower case", "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp", "v4"},
		{"Tron, upper case", "TRON:MAINNET", "v4"},
		{"registry chain not in the list", "eip155:1", ""},
		{"chain not in the registry", "eip155:999999", ""},
		{"empty chain", "", ""},
	}
	for _, tc := range cases {
		var ids []string
		for _, v := range r.Allowed(l, tc.chain) {
			ids = append(ids, v.ID)
		}
		if got := strings.Join(ids, ","); got != tc.want {
			t.Errorf("%s: Allowed = %q, want %q", tc.name, got, tc.want)
		}
	}
	if got := r.Allowed(EnvList{}, "eip155:4217"); got != nil {
		t.Errorf("Allowed on an empty list = %v, want nil", got)
	}
}

func TestLookups(t *testing.T) {
	r := mustLoad(t)
	const tempoV4 = "0x815d450F443466d52D3c1fB7a57D74D463D1E6F0"
	cases := []struct {
		name string
		got  bool
		want bool
	}{
		{"EVM escrow, exact", r.HasEscrow("eip155:4217", tempoV4), true},
		{"EVM escrow, lower case", r.HasEscrow("eip155:4217", strings.ToLower(tempoV4)), true},
		{"EVM v5 escrow on Tempo", r.HasEscrow("eip155:4217", "0xedaD6a9846c79A64449603e95F8c77fd5A46881b"), true},
		{"Tempo v5 escrow is not on Arbitrum", r.HasEscrow("eip155:42161", "0xedaD6a9846c79A64449603e95F8c77fd5A46881b"), false},
		{"mainnet escrow is not a testnet escrow", r.HasEscrow("eip155:84532", tempoV4), false},
		{"unknown chain", r.HasEscrow("eip155:999999", tempoV4), false},
		{"proxy is not an escrow", r.HasEscrow("eip155:4217", "0xA8F40Ed7437BCB6bF264832369e8364b80B06c83"), false},
		{"Tron escrow, exact", r.HasEscrow("tron:mainnet", "TYj48kPL31aMpJfm2LKi96e9hEfVKGmv5Y"), true},
		{"Tron escrow, case changed", r.HasEscrow("tron:mainnet", "tyj48kpl31ampjfm2lki96e9hefvkgmv5y"), false},
		{"retired Tron v1 escrow", r.HasEscrow("tron:mainnet", "TFXoNv8TuzXEGrkRv6aNghM2G7Lfjy15Aj"), false},
		{"Solana escrow", r.HasEscrow("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "5BD9UAUCRCg6Chv6CS5k4sBHGd7CciWpng9u7iJxJFjx"), true},
		{"EVM preview proxy", r.HasProxy("eip155:1", "0x1FaF7640110Fb09BaD288dBEf5B4f676b0eC1932"), true},
		{"unrecorded testnet proxy", r.HasProxy("eip155:84532", "0x3f2F4Fa9EA195028f534851ddFd26994e4e3700c"), true},
		{"unrecorded testnet proxy is not on mainnet", r.HasProxy("eip155:8453", "0x3f2F4Fa9EA195028f534851ddFd26994e4e3700c"), false},
		{"escrow is not a proxy", r.HasProxy("eip155:4217", tempoV4), false},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, tc.got, tc.want)
		}
	}
	if _, ok := r.Version("eip155:4217", "v5"); !ok {
		t.Error("Version(eip155:4217, v5) missing")
	}
	if _, ok := r.Version("eip155:4217", "v9"); ok {
		t.Error("Version(eip155:4217, v9) found")
	}
}

func TestParseEnvList(t *testing.T) {
	cases := []struct {
		in      string
		want    EnvList
		wantErr string
	}{
		{"", EnvList{}, ""},
		{"  ", EnvList{}, ""},
		{"eip155:4217=v4,v5", EnvList{"eip155:4217": {"v4", "v5"}}, ""},
		{" eip155:1 = v4 ; tron:mainnet=v4; ", EnvList{"eip155:1": {"v4"}, "tron:mainnet": {"v4"}}, ""},
		{"eip155:1", nil, "want chain=id"},
		{"=v4", nil, "want chain=id"},
		{" =v4", nil, "want chain=id"},
		{"eip155:1=", nil, "empty version id"},
		{"eip155:1=v4,,v5", nil, "empty version id"},
		{"eip155:1=v4,v4", nil, "listed twice"},
		{"eip155:1=v4;eip155:1=v5", nil, "listed twice"},
	}
	for _, tc := range cases {
		got, err := ParseEnvList(tc.in)
		if tc.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("ParseEnvList(%q) err = %v, want %q", tc.in, err, tc.wantErr)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseEnvList(%q): %v", tc.in, err)
			continue
		}
		if len(got) != len(tc.want) {
			t.Errorf("ParseEnvList(%q) = %v, want %v", tc.in, got, tc.want)
			continue
		}
		for k, ids := range tc.want {
			if strings.Join(got[k], ",") != strings.Join(ids, ",") {
				t.Errorf("ParseEnvList(%q)[%s] = %v, want %v", tc.in, k, got[k], ids)
			}
		}
	}
}

func TestCheckEnvList(t *testing.T) {
	r := mustLoad(t)
	cases := []struct {
		in      string
		wantErr string
	}{
		{"eip155:4217=v4,v5;tron:mainnet=v4;solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp=v4", ""},
		{"eip155:4217=v6", "version v6 is not in the registry"},
		{"eip155:999999=v4", "not in the registry"},
		{"tron:mainnet=TYj48kPL31aMpJfm2LKi96e9hEfVKGmv5Y", "not in the registry"},
		// EXPECTED_CHAINS lowercases chain ids; the registry keeps Solana's case, so this must fail loudly.
		{"solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp=v4", "case sensitive"},
	}
	for _, tc := range cases {
		l, err := ParseEnvList(tc.in)
		if err != nil {
			t.Fatalf("ParseEnvList(%q): %v", tc.in, err)
		}
		err = r.CheckEnvList(l)
		if tc.wantErr == "" {
			if err != nil {
				t.Errorf("CheckEnvList(%q): %v", tc.in, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
			t.Errorf("CheckEnvList(%q) err = %v, want %q", tc.in, err, tc.wantErr)
		}
	}
}

// TestUnrecordedProxiesArePinned keeps the escape hatch from the deployments-file rule closed:
// an unrecorded proxy is trusted without any deployments record, so each one is named here.
func TestUnrecordedProxiesArePinned(t *testing.T) {
	const oldTestnetProxy = "0x3f2F4Fa9EA195028f534851ddFd26994e4e3700c"
	want := map[string]bool{}
	for _, c := range []string{"421614", "11142220", "84532", "11155111", "80002", "11155420", "43113", "42431"} {
		want["eip155:"+c+"|v4|"+oldTestnetProxy] = true
	}
	r := mustLoad(t)
	got := map[string]bool{}
	for _, chain := range r.Chains() {
		c, _ := r.Chain(chain)
		for _, v := range c.Versions {
			for p := range v.UnrecordedFulfillmentProxies {
				got[chain+"|"+v.ID+"|"+p] = true
			}
		}
	}
	for k := range got {
		if !want[k] {
			t.Errorf("unrecorded proxy %s is not one of the pinned exceptions; record it in a deployments file instead", k)
		}
	}
	for k := range want {
		if !got[k] {
			t.Errorf("pinned exception %s is gone; drop it from this test", k)
		}
	}
}

// domainKey is a version's signature domain as one published.txt field: "svm:<n>" for the raw
// hash scheme, "svm:<n>/<scheme>" otherwise, "<name>:<version>" for EIP-712.
func domainKey(s Signature) string {
	if s.StellarDomainVersion != 0 {
		return "stellar:" + strconv.Itoa(s.StellarDomainVersion)
	}
	if s.SVMDomainVersion != 0 {
		k := "svm:" + strconv.Itoa(s.SVMDomainVersion)
		if s.SVMMessage != "" {
			k += "/" + s.SVMMessage
		}
		return k
	}
	return s.EIP712Name + ":" + s.EIP712Version
}

func TestDomainKey(t *testing.T) {
	cases := []struct {
		s    Signature
		want string
	}{
		{Signature{SVMDomainVersion: 5}, "svm:5"},
		{Signature{SVMDomainVersion: 255}, "svm:255"},
		{Signature{SVMDomainVersion: 6, SVMMessage: "text"}, "svm:6/text"},
		{Signature{EIP712Name: "Escrow", EIP712Version: "3"}, "Escrow:3"},
		{Signature{StellarDomainVersion: 2}, "stellar:2"},
	}
	for _, tc := range cases {
		if got := domainKey(tc.s); got != tc.want {
			t.Errorf("domainKey(%+v) = %q, want %q", tc.s, got, tc.want)
		}
	}
}

// publishedLines returns the non-comment lines of published.txt.
func publishedLines(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile("published.txt")
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, line := range strings.Split(string(raw), "\n") {
		if line = strings.TrimSpace(line); line != "" && !strings.HasPrefix(line, "#") {
			out = append(out, line)
		}
	}
	return out
}

// TestPublishedRebuildsFromChains rebuilds published.txt from the chain files line for line (the
// TypeScript reader runs the same check), so both readers agree on every column.
func TestPublishedRebuildsFromChains(t *testing.T) {
	r := mustLoad(t)
	var rebuilt []string
	for _, chain := range r.Chains() {
		c, _ := r.Chain(chain)
		for _, v := range c.Versions {
			rebuilt = append(rebuilt, strings.Join([]string{chain, v.ID, v.Escrow, domainKey(v.Signature)}, " "))
		}
	}
	published := publishedLines(t)
	sort.Strings(rebuilt)
	sort.Strings(published)
	if strings.Join(rebuilt, "\n") != strings.Join(published, "\n") {
		t.Errorf("published.txt lines:\n%s\nrebuilt from chains/:\n%s", strings.Join(published, "\n"), strings.Join(rebuilt, "\n"))
	}
}

// TestPublishedEscrowsNeverMove enforces "versions are only ever added": published.txt lists every
// chain, id, escrow and signature domain ever published, and each must still be in the registry unchanged. A
// deployments file edited in place cannot repoint a published version through the generator.
func TestPublishedEscrowsNeverMove(t *testing.T) {
	raw, err := os.ReadFile("published.txt")
	if err != nil {
		t.Fatal(err)
	}
	r := mustLoad(t)
	listed := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Fields(line)
		if len(f) != 4 {
			t.Fatalf("published.txt: %q is not \"chain id escrow domain\"", line)
		}
		listed[f[0]+" "+f[1]] = true
		v, ok := r.Version(f[0], f[1])
		if !ok {
			t.Errorf("%s %s was published and is gone from the registry; versions are never removed", f[0], f[1])
			continue
		}
		if v.Escrow != f[2] {
			t.Errorf("%s %s was published with escrow %s and now says %s; add a new version instead", f[0], f[1], f[2], v.Escrow)
		}
		if d := domainKey(v.Signature); d != f[3] {
			t.Errorf("%s %s was published with signature domain %s and now says %s; a deployed contract's domain never changes", f[0], f[1], f[3], d)
		}
	}
	for _, chain := range r.Chains() {
		c, _ := r.Chain(chain)
		for _, v := range c.Versions {
			if !listed[chain+" "+v.ID] {
				t.Errorf("%s %s is not in published.txt; add \"%s %s %s %s\"", chain, v.ID, chain, v.ID, v.Escrow, domainKey(v.Signature))
			}
		}
	}
}

// TestLoadFSMatchesLoad reads the chain files from disk through LoadFS and expects the embedded registry.
func TestLoadFSMatchesLoad(t *testing.T) {
	fromDisk, err := LoadFS(os.DirFS("."))
	if err != nil {
		t.Fatalf("LoadFS: %v", err)
	}
	embedded := mustLoad(t)
	if !reflect.DeepEqual(fromDisk.Chains(), embedded.Chains()) {
		t.Fatalf("LoadFS chains %v, Load chains %v", fromDisk.Chains(), embedded.Chains())
	}
	for _, c := range embedded.Chains() {
		a, _ := fromDisk.Chain(c)
		b, _ := embedded.Chain(c)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("%s differs between LoadFS and Load", c)
		}
	}
	if _, err := LoadFS(fstest.MapFS{"chains/x.json": {Data: []byte("{")}}); err == nil {
		t.Error("LoadFS accepted a broken chain file")
	}
}

func TestLoadRefusesBadFiles(t *testing.T) {
	good := `{"chain":"eip155:1","name":"n","mainnet":true,"versions":[{"id":"v4","source":"s","escrow":"0xAA","fulfillmentProxies":["0xBB"],"signature":{"eip712Name":"Escrow","eip712Version":"3"}}]}`
	cases := []struct {
		name, file, body, want string
	}{
		{"file name differs from chain", "chains/eip155_2.json", good, "want file eip155_1.json"},
		{"unknown field", "chains/eip155_1.json", strings.Replace(good, `"name":"n"`, `"name":"n","extra":1`, 1), "unknown field"},
		{"broken JSON", "chains/eip155_1.json", good[:20], "unexpected EOF"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := load(fstest.MapFS{tc.file: {Data: []byte(tc.body)}})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("load() = %v, want error containing %q", err, tc.want)
			}
		})
	}
	sol := func(chain string) []byte {
		return []byte(`{"chain":"` + chain + `","name":"n","mainnet":true,"versions":[{"id":"v4","source":"s","escrow":"A","fulfillmentProxies":["B"],"signature":{"svmDomainVersion":5}}]}`)
	}
	_, err := load(fstest.MapFS{
		"chains/solana_AbC.json": {Data: sol("solana:AbC")},
		"chains/solana_abc.json": {Data: sol("solana:abc")},
	})
	if err == nil || !strings.Contains(err.Error(), "only in case") {
		t.Fatalf("load() of two chains equal but for case = %v, want error containing %q", err, "only in case")
	}
	if _, err := load(fstest.MapFS{"chains/eip155_1.json": {Data: []byte(good)}}); err != nil {
		t.Fatalf("a good file must load: %v", err)
	}
}
