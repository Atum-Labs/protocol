package atumerror_test

import (
	"encoding/json"
	"testing"

	atumerror "github.com/atum-labs/protocol/schemas/apis/error/v1/bindings/go"
)

// contract_address takes the address spellings of every supported chain. A Stellar G account or C
// contract is a 56-character uppercase base32 strkey; the pattern is a shape check, and the
// strkey checksum is the chain-address codec's job.
func TestBlockchainContextContractAddress(t *testing.T) {
	cases := []struct {
		name    string
		address string
		ok      bool
	}{
		{"evm", "0x90f79bf6eb2c4f870365e785982e1f101e93b906", true},
		{"solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", true},
		{"stellar contract", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5", true},
		{"stellar account", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH", true},
		{"stellar lowercase", "cddpu6xtx3n22or5mxzwvk6joqy3do7eyljpnyhepstaea2ff5owcte5", false},
		{"stellar too short", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE", false},
		{"stellar too long", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5A", false},
		{"stellar base32 excludes 1", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCT15", false},
		{"stellar muxed contract", "WADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4RQG", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var ctx atumerror.BlockchainContext
			err := json.Unmarshal([]byte(`{"contract_address":"`+tc.address+`"}`), &ctx)
			if tc.ok && err != nil {
				t.Fatalf("want %s accepted, got %v", tc.address, err)
			}
			if !tc.ok && err == nil {
				t.Fatalf("want %s refused", tc.address)
			}
		})
	}
}
