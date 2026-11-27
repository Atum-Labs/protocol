package turnkey

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/rlp"
)

// erc20TransferSelector is the 4-byte selector for transfer(address,uint256).
var erc20TransferSelector = crypto.Keccak256([]byte("transfer(address,uint256)"))[:4]

// erc20TransferCalldata builds the ABI calldata for an ERC-20
// transfer(to, amount) call.
func erc20TransferCalldata(to common.Address, amount *big.Int) []byte {
	out := make([]byte, 0, 4+32+32)
	out = append(out, erc20TransferSelector...)
	padded := make([]byte, 32)
	copy(padded[12:], to.Bytes())
	out = append(out, padded...)
	amtBytes := amount.Bytes()
	amtPadded := make([]byte, 32)
	copy(amtPadded[32-len(amtBytes):], amtBytes)
	out = append(out, amtPadded...)
	return out
}

// encodeUnsignedEIP1559 returns the canonical unsigned EIP-1559
// transaction encoding (type byte 0x02 followed by RLP of the unsigned
// fields, with an empty access list). This is the format Turnkey
// expects as `unsignedTransaction`.
func encodeUnsignedEIP1559(
	chainID *big.Int, nonce uint64, gas GasParams, to common.Address, data []byte,
) ([]byte, error) {
	if chainID == nil {
		return nil, fmt.Errorf("turnkey: chainID is nil")
	}
	fields := []interface{}{
		chainID,
		nonce,
		gas.MaxPriorityFeePerGas,
		gas.MaxFeePerGas,
		gas.GasLimit,
		to.Bytes(),
		big.NewInt(0),
		data,
		[]interface{}{},
	}
	body, err := rlp.EncodeToBytes(fields)
	if err != nil {
		return nil, fmt.Errorf("turnkey: rlp encode: %w", err)
	}
	return append([]byte{0x02}, body...), nil
}
