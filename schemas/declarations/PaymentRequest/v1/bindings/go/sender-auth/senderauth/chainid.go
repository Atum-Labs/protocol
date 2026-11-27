package senderauth

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	stellar "github.com/atum-labs/protocol/contracts/stellar/bindings/go/escrow-encoding/encoding"
)

// namespaceOf returns the CAIP-2 namespace of a network id (the part before the
// first colon). Mirrors TS namespaceOf.
func namespaceOf(network string) string {
	return strings.SplitN(network, ":", 2)[0]
}

var eip155Re = regexp.MustCompile(`^eip155:([0-9]+)$`)

// maxEvmChainID is the largest chain id either binding accepts, per EIP-2294. Above it the TS
// mirror's Number() stops being injective, so it reads eip155:9007199254740993 back as
// 9007199254740992. Refusing on both sides keeps one binding from signing a reference the other
// reads differently.
const maxEvmChainID = int64(1)<<53 - 1

// evmChainID parses the numeric chain id from an `eip155:<id>` CAIP-2 network, or errors.
// Mirrors TS evmChainId.
func evmChainID(network string) (int64, error) {
	m := eip155Re.FindStringSubmatch(network)
	if m == nil {
		return 0, fmt.Errorf("sender_auth: expected an eip155 network, got %s", network)
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		// A reference past int64 is an eip155 network, just an unusable one, so it gets the
		// range message rather than the "not an eip155 network" one the TS mirror never sends.
		if errors.Is(err, strconv.ErrRange) {
			return 0, chainIDRangeError(m[1])
		}
		return 0, fmt.Errorf("sender_auth: expected an eip155 network, got %s", network)
	}
	if n > maxEvmChainID {
		return 0, chainIDRangeError(m[1])
	}
	return n, nil
}

// chainIDRangeError is the single message both out-of-range paths report, so the two bindings
// stay comparable by message as well as by verdict.
func chainIDRangeError(reference string) error {
	return fmt.Errorf("sender_auth: eip155 chain id %s exceeds the EIP-2294 maximum (%d)", reference, maxEvmChainID)
}

// TronChainIDs maps a known Tron cluster to its TIP-712 numeric chain id.
var TronChainIDs = map[string]int64{
	"mainnet": 728126428,
	"shasta":  2494104990,
}

// maxTronChainID is the largest Tron chain id either binding accepts from a caller. TIP712.sol
// refuses to deploy on a chain whose id does not fit 32 bits, so no Tron escrow can sign over a
// larger one. Mirrors TS MAX_TRON_CHAIN_ID.
const maxTronChainID int64 = math.MaxUint32

// tronChainIDError is a caller-supplied Tron chain id that cannot be used. detail is the reason,
// as a commitment check reports it with verifier_misconfigured. Mirrors TS TronChainIdError.
type tronChainIDError struct{ detail string }

func (e *tronChainIDError) Error() string { return "sender_auth: " + e.detail }

// tronNumericChainID returns the Tron TIP-712 numeric chain id for a `tron:<cluster>`
// network, or errors. supplied gives, by cluster, the id of a network TronChainIDs does not know,
// such as a local node's; nil supplies none. The table stays authoritative: an entry for a cluster
// it knows must repeat its id, an entry for any other cluster must not repeat an id the table
// gives a cluster, and every entry read must be in 1..maxTronChainID, or the error is a
// *tronChainIDError. Only the entry for this network's cluster is read. Mirrors TS
// tronNumericChainId.
func tronNumericChainID(network string, supplied map[string]int64) (int64, error) {
	// Namespace first: the cluster name alone does not identify a chain, so eip155:mainnet must
	// not resolve to Tron mainnet's id.
	if namespaceOf(network) != "tron" {
		return 0, fmt.Errorf("sender_auth: expected a tron network, got %s", network)
	}
	// Exactly two segments, mirroring TS, so tron:mainnet:extra does not resolve to mainnet's id.
	// An empty cluster names no network, so no supplied entry can give it one.
	parts := strings.Split(network, ":")
	if len(parts) != 2 || parts[1] == "" {
		return 0, fmt.Errorf("sender_auth: unsupported Tron network '%s'", network)
	}
	cluster := parts[1]
	known, isKnown := TronChainIDs[cluster]
	if id, ok := supplied[cluster]; ok {
		if id < 1 || id > maxTronChainID {
			return 0, &tronChainIDError{fmt.Sprintf("the Tron chain id supplied for cluster %s is not an integer in 1..%d", quoteValue(cluster), maxTronChainID)}
		}
		if isKnown && id != known {
			return 0, &tronChainIDError{fmt.Sprintf("the Tron chain id supplied for cluster %s is %d, but the built-in table has %d", quoteValue(cluster), id, known)}
		}
		// The chain id is all that tells one Tron network's TIP-712 domain from another's, so a
		// built-in id under a new name would make that name an alias of the network, and a permit
		// signed there would verify under it. The table's ids are distinct, so at most one matches.
		if !isKnown {
			for name, builtIn := range TronChainIDs {
				if id == builtIn {
					return 0, &tronChainIDError{fmt.Sprintf("the Tron chain id supplied for cluster %s is %d, which the built-in table gives cluster %s", quoteValue(cluster), id, quoteValue(name))}
				}
			}
		}
		return id, nil
	}
	if !isKnown {
		return 0, fmt.Errorf("sender_auth: unsupported Tron network '%s'", network)
	}
	return known, nil
}

// TronPermit2Fallbacks are the pinned Tron Permit2 addresses. Resolved server-side
// only — never from a client-supplied value — so a forged verifying contract cannot
// recover the signature to the wrong signer.
var TronPermit2Fallbacks = map[string]string{
	"tron:mainnet": "TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m",
	"tron:shasta":  "TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp",
}

// resolveTronPermit2 resolves the Tron Permit2 address for a network from the pinned
// map, or errors. Mirrors TS resolveTronPermit2.
func resolveTronPermit2(network string) (string, error) {
	resolved, ok := TronPermit2Fallbacks[network]
	if !ok || resolved == "" {
		return "", fmt.Errorf("sender_auth: no Permit2 address known for Tron network '%s'", network)
	}
	return resolved, nil
}

// clusterIDFromName builds the 32-byte cluster_id from a cluster name (UTF-8,
// right-padded with zeros), mirroring the on-chain escrow's cluster-id layout and
// TS clusterIdFromName.
func clusterIDFromName(name string) ([32]byte, error) {
	encoded := []byte(name)
	if len(encoded) > 32 {
		return [32]byte{}, fmt.Errorf("sender_auth: Solana cluster name too long (%d > 32 bytes): %s", len(encoded), name)
	}
	var out [32]byte
	copy(out[:], encoded)
	return out, nil
}

// stellarNetworks maps a Stellar CAIP-2 reference to its network passphrase, the public network
// constants whose sha256 is the escrow's network_id. A reference not listed is refused rather than
// guessed: a wrong network yields a well-formed digest no deployed escrow can accept. Mirrors TS
// STELLAR_NETWORKS.
var stellarNetworks = map[string]string{
	"pubnet":     stellar.PassphrasePublic,
	"testnet":    stellar.PassphraseTestnet,
	"futurenet":  "Test SDF Future Network ; October 2022",
	"standalone": "Standalone Network ; February 2017",
}

// stellarNetworkString is the network passphrase of a `stellar:<reference>` CAIP-2 network, or
// an error. The caller hashes it with the escrow encoder's NewEscrowDomain; nothing here is secret.
// Mirrors TS stellarNetworkString.
func stellarNetworkString(network string) (string, error) {
	parts := strings.Split(network, ":")
	if len(parts) == 2 && parts[0] == "stellar" {
		if known, ok := stellarNetworks[parts[1]]; ok {
			return known, nil
		}
	}
	return "", fmt.Errorf("sender_auth: %s is not a supported stellar network (expected stellar:pubnet, stellar:testnet, stellar:futurenet or stellar:standalone)", quoteValue(network))
}
