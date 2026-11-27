package senderauth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// readerMemberPaths are the request members the payee check and VerifyPaymentRequestJSON read by
// exact name. Mirrors the TS request-members test.
var readerMemberPaths = [][]string{
	{"source", "asset_identifier"},
	{"source", "account"},
	{"destination", "asset_identifier"},
	{"destination", "account"},
	{"request_id"},
	{"max_source_amount"},
	{"sender_auth", "message_scheme"},
	{"sender_auth", "signed_messages", "message"},
	{"sender_auth", "signed_messages", "signature"},
	{"sender_auth", "signed_messages", "message_prehash"},
	{"sender_auth", "signed_messages", "payload"},
}

// Every member the request reader names must exist in the PaymentRequest schema, so renaming one
// there fails here instead of leaving the reader looking for the old name.
func TestRequestReaderMembersAreSchemaMembers(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "schema.json"))
	require.NoError(t, err)
	var schema map[string]any
	require.NoError(t, json.Unmarshal(raw, &schema))
	defs, _ := schema["$defs"].(map[string]any)
	resolve := func(node map[string]any) map[string]any {
		for {
			if ref, ok := node["$ref"].(string); ok {
				node, _ = defs[strings.TrimPrefix(ref, "#/$defs/")].(map[string]any)
				continue
			}
			if items, ok := node["items"].(map[string]any); ok {
				node = items
				continue
			}
			return node
		}
	}
	for _, path := range readerMemberPaths {
		node := schema
		for _, name := range path {
			properties, _ := resolve(node)["properties"].(map[string]any)
			child, ok := properties[name].(map[string]any)
			require.True(t, ok, "%s is not in the PaymentRequest schema", strings.Join(path, "."))
			node = child
		}
	}
}
