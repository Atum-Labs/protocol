package contracts

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	generated "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"golang.org/x/crypto/sha3"
)

// ErrorInfo contains detailed information about a contract error
type ErrorInfo struct {
	Name        string `json:"name"`
	Signature   string `json:"signature"`
	Selector    string `json:"selector"`
	Description string `json:"description"`
	Inputs      []struct {
		Name string `json:"name"`
		Type string `json:"type"`
	} `json:"inputs"`
}

var (
	// Cache for all known errors
	errorRegistry     map[string]*ErrorInfo
	errorRegistryOnce sync.Once
)

// initErrorRegistry initializes the error registry from contract metadata
func initErrorRegistry() {
	errorRegistry = make(map[string]*ErrorInfo)

	// Extract errors from all contract ABIs
	extractErrorsFromABI("IEscrow", IEscrowMetaData.ABI, "Escrow contract")
	extractErrorsFromABI("IFulfillmentProxy", IFulfillmentProxyMetaData.ABI, "Fulfillment proxy contract")
	extractErrorsFromABI("SignatureVerification", SignatureVerificationMetaData.ABI, "Permit2 signature verification")
	extractErrorsFromABI("IERC20", IERC20MetaData.ABI, "ERC20 token contract")
	extractErrorsFromABI("ITokenConfig", ITokenConfigMetaData.ABI, "Token configuration contract")
	extractErrorsFromABI("IERC20Errors", generated.IERC20ErrorsMetaData.ABI, "ERC20 standard errors")

	// Add some common Solidity errors that might not be in ABIs
	addStandardErrors()
}

// extractErrorsFromABI extracts error definitions from an ABI string
func extractErrorsFromABI(contractName, abiJSON, description string) {
	var abi []map[string]interface{}
	if err := json.Unmarshal([]byte(abiJSON), &abi); err != nil {
		return // Skip if ABI parsing fails
	}

	for _, item := range abi {
		if itemType, ok := item["type"].(string); ok && itemType == "error" {
			if name, ok := item["name"].(string); ok {
				// Build error signature
				signature := buildErrorSignature(name, item)
				selector := generateErrorSelector(signature)

				errorRegistry[selector] = &ErrorInfo{
					Name:        name,
					Signature:   signature,
					Selector:    selector,
					Description: fmt.Sprintf("%s error from %s", name, description),
				}

				// Also extract inputs if available
				if inputs, ok := item["inputs"].([]interface{}); ok {
					for _, input := range inputs {
						if inputMap, ok := input.(map[string]interface{}); ok {
							if inputName, nameOk := inputMap["name"].(string); nameOk {
								if inputType, typeOk := inputMap["type"].(string); typeOk {
									errorRegistry[selector].Inputs = append(errorRegistry[selector].Inputs, struct {
										Name string `json:"name"`
										Type string `json:"type"`
									}{
										Name: inputName,
										Type: inputType,
									})
								}
							}
						}
					}
				}
			}
		}
	}
}

// buildErrorSignature builds the canonical error signature for hashing
func buildErrorSignature(name string, errorDef map[string]interface{}) string {
	signature := name + "("

	if inputs, ok := errorDef["inputs"].([]interface{}); ok {
		var paramTypes []string
		for _, input := range inputs {
			if inputMap, ok := input.(map[string]interface{}); ok {
				if inputType, ok := inputMap["type"].(string); ok {
					paramTypes = append(paramTypes, inputType)
				}
			}
		}
		signature += strings.Join(paramTypes, ",")
	}

	signature += ")"
	return signature
}

// generateErrorSelector generates the 4-byte selector for an error signature
func generateErrorSelector(signature string) string {
	hasher := sha3.NewLegacyKeccak256()
	hasher.Write([]byte(signature))
	hash := hasher.Sum(nil)
	return fmt.Sprintf("%02x%02x%02x%02x", hash[0], hash[1], hash[2], hash[3])
}

// addStandardErrors adds common Solidity errors that might not be in contract ABIs
func addStandardErrors() {
	standardErrors := map[string]string{
		"Error(string)":  "Generic error with message",
		"Panic(uint256)": "Panic with error code",
	}

	for signature, description := range standardErrors {
		selector := generateErrorSelector(signature)
		errorRegistry[selector] = &ErrorInfo{
			Name:        extractErrorName(signature),
			Signature:   signature,
			Selector:    selector,
			Description: description,
		}
	}
}

// extractErrorName extracts the error name from a signature
func extractErrorName(signature string) string {
	if idx := strings.Index(signature, "("); idx > 0 {
		return signature[:idx]
	}
	return signature
}

// GetErrorRegistry returns the complete error registry
func GetErrorRegistry() map[string]*ErrorInfo {
	errorRegistryOnce.Do(initErrorRegistry)
	return errorRegistry
}

// DecodeEscrowError attempts to decode a 4-byte error signature to a human-readable message
func DecodeEscrowError(errorHex string) (string, bool) {
	errorRegistryOnce.Do(initErrorRegistry)

	// Remove 0x prefix if present
	if len(errorHex) >= 2 && errorHex[:2] == "0x" {
		errorHex = errorHex[2:]
	}

	// Ensure we have exactly 8 hex characters (4 bytes)
	if len(errorHex) < 8 {
		return "", false
	}

	// Extract just the error selector (first 4 bytes)
	errorSelector := errorHex[:8]

	if errorInfo, exists := errorRegistry[errorSelector]; exists {
		description := fmt.Sprintf("%s - %s", errorInfo.Signature, errorInfo.Description)
		return description, true
	}

	return "", false
}

// GetErrorInfo returns detailed information about an error
func GetErrorInfo(errorHex string) (*ErrorInfo, bool) {
	errorRegistryOnce.Do(initErrorRegistry)

	// Remove 0x prefix if present
	if len(errorHex) >= 2 && errorHex[:2] == "0x" {
		errorHex = errorHex[2:]
	}

	// Ensure we have exactly 8 hex characters (4 bytes)
	if len(errorHex) < 8 {
		return nil, false
	}

	// Extract just the error selector (first 4 bytes)
	errorSelector := errorHex[:8]

	if errorInfo, exists := errorRegistry[errorSelector]; exists {
		return errorInfo, true
	}

	return nil, false
}

// DecodeErrorWithData decodes an error with additional data (like a bytes32 parameter)
func DecodeErrorWithData(errorHex string) string {
	decoded, found := DecodeEscrowError(errorHex)
	if !found {
		return fmt.Sprintf("Unknown error: 0x%s", errorHex)
	}

	// If there's additional data beyond the 4-byte selector, include it
	if len(errorHex) > 8 {
		additionalData := errorHex[8:]
		return fmt.Sprintf("%s - Additional data: 0x%s", decoded, additionalData)
	}

	return decoded
}

// ListAllErrors returns a formatted string of all known errors for debugging
func ListAllErrors() string {
	errorRegistryOnce.Do(initErrorRegistry)

	var result strings.Builder
	result.WriteString("Known Contract Errors:\n")
	result.WriteString("=====================\n\n")

	for selector, errorInfo := range errorRegistry {
		result.WriteString(fmt.Sprintf("Selector: 0x%s\n", selector))
		result.WriteString(fmt.Sprintf("Signature: %s\n", errorInfo.Signature))
		result.WriteString(fmt.Sprintf("Description: %s\n", errorInfo.Description))
		if len(errorInfo.Inputs) > 0 {
			result.WriteString("Inputs:\n")
			for _, input := range errorInfo.Inputs {
				result.WriteString(fmt.Sprintf("  - %s: %s\n", input.Name, input.Type))
			}
		}
		result.WriteString("\n")
	}

	return result.String()
}
