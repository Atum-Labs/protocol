package senderauth

import "fmt"

// GetChainAdapter resolves the sender_auth adapter for a CAIP-2 network by its
// namespace prefix. Mirrors TS getChainAdapter (eip155 / tron / solana / stellar).
func GetChainAdapter(caip2 string) (ChainAdapter, error) {
	if adapter, ok := chainAdapters[namespaceOf(caip2)]; ok {
		return adapter, nil
	}
	return nil, fmt.Errorf("sender_auth: unsupported source chain '%s'", caip2)
}

// chainAdapters maps each supported CAIP-2 namespace to its adapter.
var chainAdapters = map[string]ChainAdapter{
	"eip155":  evmAdapter{},
	"tron":    tronAdapter{},
	"solana":  solanaAdapter{},
	"stellar": stellarAdapter{},
}
