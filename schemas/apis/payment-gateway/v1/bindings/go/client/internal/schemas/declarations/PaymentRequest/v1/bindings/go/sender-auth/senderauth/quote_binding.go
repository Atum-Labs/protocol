package senderauth

// VerifyQuoteRequestBinding checks that a FulfillmentQuote quotes the payment request the caller
// stored, and returns the stored request's terms. Act on those terms, never on the quote's copy.
//
// quote is the whole FulfillmentQuote as received. It is refused as request_malformed when its
// member names are ambiguous, when it is not an object, or when payment_request_json is not a
// string. Both the embedded payment_request_json and storedRequest are read with
// ReadDepositRequest; a refusal of either is request_malformed, its detail prefixed with the copy
// refused. The two must commit the same depositRequestHash v2, or the quote is refused as
// quote_request_mismatch: the settler quoted terms other than the ones the payer signs. Re-encoding
// that keeps the terms, such as storage in a JSONB column, does not change v2. The two must also
// carry the same deposit_nonce, which v2 does not commit.
//
// It is always strict: it has no audit mode. A refusal returns the zero DepositRequest and a
// *CommitmentError. Mirrors TS verifyQuoteRequestBinding.
func VerifyQuoteRequestBinding(quote, storedRequest []byte) (DepositRequest, error) {
	stored, err := readNamedCopy("the stored payment request", storedRequest)
	if err != nil {
		return DepositRequest{}, err
	}
	path, err := FirstAmbiguousMember(quote)
	if err != nil {
		return refuseDepositRequest("the quote is not a single valid JSON document")
	}
	if path != "" {
		return refuseDepositRequest("the quote carries two members that differ only in letter case, at " + echo(path))
	}
	root, err := decodeScanned(quote)
	if err != nil {
		return refuseDepositRequest("the quote is not a single valid JSON document")
	}
	doc, ok := root.(map[string]any)
	if !ok {
		return refuseDepositRequest("the quote is not an object")
	}
	embedded, ok := doc["payment_request_json"].(string)
	if !ok {
		return refuseDepositRequest("the quote has no payment_request_json string")
	}
	quoted, err := readNamedCopy("the quote's payment_request_json", []byte(embedded))
	if err != nil {
		return DepositRequest{}, err
	}
	if quoted.DepositRequestHashV2 != stored.DepositRequestHashV2 {
		_, err := refuse(CommitmentResult{}, OutcomeQuoteRequestMismatch,
			"the quote's payment_request_json does not commit the same terms as the stored payment request")
		return DepositRequest{}, err
	}
	// v2 does not commit an originator-executed deposit's nonce (the deposit id does), so it is
	// compared here: another nonce names another deposit.
	if !sameDepositNonce(quoted.DepositNonce, stored.DepositNonce) {
		_, err := refuse(CommitmentResult{}, OutcomeQuoteRequestMismatch,
			"the quote's payment_request_json does not carry the stored payment request's deposit_nonce")
		return DepositRequest{}, err
	}
	return stored, nil
}

// sameDepositNonce reports whether two copies of a request carry the same deposit_nonce, byte for
// byte, or both carry none.
func sameDepositNonce(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// readNamedCopy is ReadDepositRequest with its refusal detail prefixed by which copy was refused.
func readNamedCopy(name string, request []byte) (DepositRequest, error) {
	read, err := ReadDepositRequest(request)
	if err != nil {
		r, _ := CommitmentResultOf(err)
		return refuseDepositRequest(name + ": " + r.Detail)
	}
	return read, nil
}
