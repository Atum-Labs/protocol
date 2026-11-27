package authorizationresponse

import "testing"

// declinedResponseJSON carries a non-ASCII, escape-heavy reason so the golden covers literal escaping.
const declinedResponseJSON = `{"@context":["https://schemas.atum.network/declarations/AuthorizationResponse/v1/context.jsonld","https://w3id.org/security/suites/secp256k1recovery-2020/v2"],"payment_id":"0x1234abcd","counterparty_did":"did:pkh:eip155:1:0x70997970c51812dc3a010c7d01b50e0d17dc79c8","status":"declined","reason":"compte suspendu: vérification échouée \"KYC\"\n口座"}`

// Frozen response_hash values. They pin the derivation across the delegation to
// lddataintegrity.ComputeContentHash: a change here changes every AuthorizationResponseEnvelope challenge.
func TestComputeResponseHash_Golden(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"authorized-with-proof", baseResponseJSON, "0x83d5bbdc1185f4341a99c9f9466425964d2f70baa0b0d2519cf70d8b2fa66607"},
		{"declined-non-ascii-reason", declinedResponseJSON, "0x3a608667738d89929b14defb8f71b1e1049c123dc08163ad14e8fff787ccb8bb"},
	}
	for _, c := range cases {
		if got := mustHash(t, c.raw); got != c.want {
			t.Errorf("%s: response_hash = %s, golden = %s", c.name, got, c.want)
		}
	}
}
