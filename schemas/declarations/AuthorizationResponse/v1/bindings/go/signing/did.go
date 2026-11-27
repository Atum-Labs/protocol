package authorizationresponse

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
)

// This file vendors the minimal did:pkh parsing helpers this verifier needs.
// It wraps CAIP-10 account identifiers into W3C DIDs:
//
//	did:pkh:<namespace>:<reference>:<account>
//
// where <namespace>:<reference> is a CAIP-2 chain ID (e.g., "eip155:1")
// and <account> is the on-chain address (e.g., "0xdeadbeef").
//
// Two parsers are provided for two distinct contracts:
//
//   - ParseDIDPKH accepts a bare did:pkh DID and rejects DID URLs.
//   - ParsePkhDIDURL accepts a did:pkh DID URL (DID + optional `#fragment`)
//     and rejects path/query components — used for a proof's
//     verificationMethod, where a fragment is the norm.

const didPKHPrefix = "did:pkh:"

// segmentCount is the fixed colon count of a bare did:pkh DID:
// did : pkh : namespace : reference : account => 5 segments.
const didPKHSegmentCount = 5

var (
	errDIDURLFragment = errors.New("did:pkh: input is a DID URL with fragment, not a bare DID — use ParsePkhDIDURL")
	errDIDURLQuery    = errors.New("did:pkh: input contains a DID URL query")
	errDIDURLPath     = errors.New("did:pkh: input contains a DID URL path")
	errWhitespace     = errors.New("did:pkh: input contains whitespace")
)

// ParseDIDPKH accepts a bare did:pkh DID and rejects DID URLs (fragment,
// query or path). Returns the CAIP-2 chain ID (namespace:reference) and
// the account.
func ParseDIDPKH(did string) (chainID, account string, err error) {
	if err := rejectURLComponents(did, true /* rejectFragment */); err != nil {
		return "", "", err
	}
	namespace, reference, account, err := parsePkhSegments(did)
	if err != nil {
		return "", "", err
	}
	return namespace + ":" + reference, account, nil
}

// ParsePkhDIDURL accepts a did:pkh DID URL (DID + optional `#fragment`) and
// rejects path/query components. Returns the namespace, chain reference and
// address.
func ParsePkhDIDURL(didURL string) (namespace, chainRef, address string, err error) {
	if err := rejectURLComponents(didURL, false /* rejectFragment */); err != nil {
		return "", "", "", err
	}
	// Strip the fragment if present — the part after `#` is dereferencing
	// metadata, not part of the DID identifier.
	if idx := strings.IndexByte(didURL, '#'); idx >= 0 {
		didURL = didURL[:idx]
	}
	return parsePkhSegments(didURL)
}

func rejectURLComponents(s string, rejectFragment bool) error {
	for _, r := range s {
		if unicode.IsSpace(r) {
			return errWhitespace
		}
	}
	if strings.ContainsRune(s, '?') {
		return errDIDURLQuery
	}
	// Path detection: any `/` AFTER the prefix marks a DID URL path. The
	// prefix itself ("did:pkh:") has no `/`, so a contains-check is safe.
	if strings.ContainsRune(s, '/') {
		return errDIDURLPath
	}
	if rejectFragment && strings.ContainsRune(s, '#') {
		return errDIDURLFragment
	}
	return nil
}

func parsePkhSegments(did string) (namespace, reference, account string, err error) {
	if !strings.HasPrefix(did, didPKHPrefix) {
		return "", "", "", fmt.Errorf("invalid did:pkh: missing prefix %q", didPKHPrefix)
	}
	parts := strings.Split(did, ":")
	if len(parts) != didPKHSegmentCount {
		return "", "", "", fmt.Errorf("invalid did:pkh: expected %d colon-separated segments, got %d", didPKHSegmentCount, len(parts))
	}
	namespace = parts[2]
	reference = parts[3]
	account = parts[4]
	if namespace == "" {
		return "", "", "", errors.New("invalid did:pkh: empty namespace")
	}
	if reference == "" {
		return "", "", "", errors.New("invalid did:pkh: empty reference")
	}
	if account == "" {
		return "", "", "", errors.New("invalid did:pkh: empty account")
	}
	return namespace, reference, account, nil
}
