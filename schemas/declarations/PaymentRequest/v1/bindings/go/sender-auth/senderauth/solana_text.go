package senderauth

import (
	"encoding/json"

	svm "github.com/atum-labs/protocol/contracts/svm/bindings/go/escrow-encoding/encoding"
)

// solanaWitnessKind is the escrow witness a Solana signed message is: a reserve when
// messagePrehash is a reserve record ({deposit_hash, recipient, quote_hash, source_amount}), a
// deposit otherwise. Mirrors the TS `solanaWitnessKind`.
func solanaWitnessKind(messagePrehash *string) svm.WitnessKind {
	if messagePrehash == nil {
		return svm.WitnessDeposit
	}
	var record map[string]json.RawMessage
	if json.Unmarshal([]byte(*messagePrehash), &record) != nil {
		return svm.WitnessDeposit
	}
	_, quote := record["quote_hash"]
	_, recipient := record["recipient"]
	_, depositor := record["depositor"]
	if quote && recipient && !depositor {
		return svm.WitnessReserve
	}
	return svm.WitnessDeposit
}

// solanaSignerMatches reports whether sig is key's signature over hash in any form a Solana escrow
// accepts: the raw hash, or the deposit or reserve escrow text (bare, v1 or v0). It proves the
// signer only; which forms the escrow accepts is the binding check's.
func solanaSignerMatches(hash [32]byte, key, sig []byte) bool {
	for _, scheme := range svm.MessageSchemes {
		for _, kind := range []svm.WitnessKind{svm.WitnessDeposit, svm.WitnessReserve} {
			if _, _, ok := svm.MatchEscrowWitness(scheme, kind, hash, key, sig); ok {
				return true
			}
		}
	}
	return false
}
