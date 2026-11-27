package events

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// fulfillmentProxyIDLPath is the IDL committed beside the TypeScript binding. check-idl.sh keeps it
// equal to a local Anchor build of the program, so pinning this package against it pins it
// against the program's own event definitions.
const fulfillmentProxyIDLPath = "../../../typescript/escrow-encoding/src/generated/fulfillment_proxy.json"

// The escrow IDLs committed beside the TypeScript binding: the current program's, which
// check-idl.sh keeps equal to a local Anchor build, and the pre-v4 one kept for history.
const (
	escrowIDLPath      = "../../../typescript/escrow-encoding/src/generated/escrow.json"
	escrowPreV4IDLPath = "../../../typescript/escrow-encoding/idl-history/pre-v4/escrow.json"
)

type idlField struct {
	Name string          `json:"name"`
	Type json.RawMessage `json:"type"`
}

type anchorIDL struct {
	Events []struct {
		Name          string  `json:"name"`
		Discriminator []uint8 `json:"discriminator"`
	} `json:"events"`
	Types []struct {
		Name string `json:"name"`
		Type struct {
			Fields []idlField `json:"fields"`
		} `json:"type"`
	} `json:"types"`
}

// loadIDL reads a committed Anchor IDL by its path relative to this package.
func loadIDL(t *testing.T, path string) anchorIDL {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		// A moved IDL must fail loudly: a guard that quietly finds nothing compares nothing.
		t.Fatalf("could not read the IDL at %s: %v -- if it moved, update this "+
			"path rather than deleting the test", path, err)
	}
	var idl anchorIDL
	if err := json.Unmarshal(raw, &idl); err != nil {
		t.Fatalf("could not parse the IDL at %s: %v", path, err)
	}
	return idl
}

func idlDiscriminator(t *testing.T, idl anchorIDL, name string) [8]byte {
	t.Helper()
	for _, ev := range idl.Events {
		if ev.Name != name {
			continue
		}
		if len(ev.Discriminator) != 8 {
			t.Fatalf("IDL discriminator for %s is %d bytes, want 8", name, len(ev.Discriminator))
		}
		var out [8]byte
		copy(out[:], ev.Discriminator)
		return out
	}
	t.Fatalf("the IDL declares no %s event", name)
	return [8]byte{}
}

func tagged(tag [8]byte, body []byte) []byte {
	return append(append([]byte{}, tag[:]...), body...)
}

// idlFieldSize is the Borsh width of the fixed-size types the decoded events use. Any other
// type fails the test: a variable-width field would make offset decoding wrong, not just shifted.
func idlFieldSize(t *testing.T, event string, f idlField) int {
	t.Helper()
	var scalar string
	if json.Unmarshal(f.Type, &scalar) == nil {
		switch scalar {
		case "pubkey":
			return 32
		case "u64":
			return 8
		}
	}
	var arr struct {
		Array [2]json.RawMessage `json:"array"`
	}
	if json.Unmarshal(f.Type, &arr) == nil && string(arr.Array[0]) == `"u8"` {
		var n int
		if json.Unmarshal(arr.Array[1], &n) == nil {
			return n
		}
	}
	t.Fatalf("%s.%s has IDL type %s, which this decoder does not read at a fixed offset",
		event, f.Name, f.Type)
	return 0
}

// idlBody lays out an event's body field by field from the IDL and returns it with each field's
// bytes. Every byte differs from every other, so a field read from the wrong offset or in the
// wrong byte order decodes to a value the test can see is wrong.
//
// The IDL's field names must be exactly names, in order, before anything is decoded: a field
// added, removed, renamed or moved in the program then fails here naming it, rather than as a
// confusing decode error further down.
func idlBody(t *testing.T, idl anchorIDL, event string, names []string) ([]byte, map[string][]byte) {
	t.Helper()
	for _, ty := range idl.Types {
		if ty.Name != event {
			continue
		}
		var got []string
		for _, f := range ty.Type.Fields {
			got = append(got, f.Name)
		}
		if !slices.Equal(got, names) {
			t.Fatalf("IDL %s fields are %v, this decoder reads %v: update the decoder", event, got, names)
		}
		var body []byte
		fields := map[string][]byte{}
		for _, f := range ty.Type.Fields {
			b := make([]byte, idlFieldSize(t, event, f))
			for k := range b {
				b[k] = byte(len(body) + k + 1)
			}
			fields[f.Name] = b
			body = append(body, b...)
		}
		return body, fields
	}
	t.Fatalf("the IDL declares no %s type", event)
	return nil, nil
}
