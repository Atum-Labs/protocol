package main

import (
	"encoding/json"
	"os"
	"reflect"
)

func readFileForTest(p string) ([]byte, error) { return os.ReadFile(p) }

func jsonEqualForTest(a, b any) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	var x, y any
	json.Unmarshal(ab, &x)
	json.Unmarshal(bb, &y)
	return reflect.DeepEqual(x, y)
}
