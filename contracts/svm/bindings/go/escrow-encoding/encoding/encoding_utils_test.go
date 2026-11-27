package svm_escrow_encoding

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestEncodeU64LE(t *testing.T) {
	tests := []struct {
		name     string
		value    uint64
		expected []byte
	}{
		{
			name:     "zero",
			value:    0,
			expected: []byte{0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
		},
		{
			name:     "one",
			value:    1,
			expected: []byte{0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
		},
		{
			name:     "small value",
			value:    256,
			expected: []byte{0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
		},
		{
			name:     "max u64",
			value:    ^uint64(0),
			expected: []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
		},
		{
			name:     "known value",
			value:    0x0102030405060708,
			expected: []byte{0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := EncodeU64LE(tc.value)
			if !bytes.Equal(result, tc.expected) {
				t.Errorf("got %x, want %x", result, tc.expected)
			}
		})
	}
}

func TestKeccak256(t *testing.T) {
	// Test vector: keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
	emptyHash := Keccak256()
	expectedEmpty, _ := hex.DecodeString("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
	if !bytes.Equal(emptyHash[:], expectedEmpty) {
		t.Errorf("empty hash: got %x, want %x", emptyHash[:], expectedEmpty)
	}

	// Test vector: keccak256("hello") = 1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8
	helloHash := Keccak256([]byte("hello"))
	expectedHello, _ := hex.DecodeString("1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8")
	if !bytes.Equal(helloHash[:], expectedHello) {
		t.Errorf("hello hash: got %x, want %x", helloHash[:], expectedHello)
	}

	// Test multiple inputs are concatenated correctly
	// keccak256("helloworld") = fa26db7ca85ead399216e7c6316bc50ed24393c3122b582735e7f3b0f91b93f0
	concatHash := Keccak256([]byte("hello"), []byte("world"))
	singleHash := Keccak256([]byte("helloworld"))
	if concatHash != singleHash {
		t.Errorf("concatenation test failed: %x != %x", concatHash[:], singleHash[:])
	}
}

func TestKeccak256_Deterministic(t *testing.T) {
	data := []byte("test data for determinism check")

	hash1 := Keccak256(data)
	hash2 := Keccak256(data)

	if hash1 != hash2 {
		t.Errorf("hashing is not deterministic: %x != %x", hash1[:], hash2[:])
	}
}
