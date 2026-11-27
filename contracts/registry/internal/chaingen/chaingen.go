// Package chaingen builds the registry's chains/*.json from versions.json and the deployments
// files it cites, so every address is written once, in its deployments file.
package chaingen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"strings"

	"github.com/atum-labs/protocol/contracts/registry"
)

// Spec is versions.json: the signature domain of each deployments file the registry trusts, and
// the trusted proxies no deployments file records.
type Spec struct {
	Comment    string       `json:"$comment,omitempty"`
	Versions   []Source     `json:"versions"`
	Unrecorded []Unrecorded `json:"unrecordedFulfillmentProxies"`
}

// Source makes every chain in one deployments file a registry version.
type Source struct {
	ID        string             `json:"id"`
	Source    string             `json:"source"`
	Signature registry.Signature `json:"signature"`
}

// Unrecorded is a trusted proxy that no deployments file records, with why.
type Unrecorded struct {
	Address string   `json:"address"`
	Version string   `json:"version"`
	Chains  []string `json:"chains"`
	Reason  string   `json:"reason"`
}

type deployment struct {
	Name    string `json:"name"`
	Mainnet bool   `json:"mainnet"`
	// Deployed false (Stellar records it) means recorded but not deployed: not a registry version.
	Deployed  *bool             `json:"deployed"`
	Contracts map[string]string `json:"contracts"`
}

// ParseSpec reads versions.json, refusing unknown fields.
func ParseSpec(raw []byte) (Spec, error) {
	var s Spec
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		return Spec{}, fmt.Errorf("versions.json: %w", err)
	}
	return s, nil
}

// namespace is the CAIP-2 namespace of a deployments file, from the VM directory it lives in.
func namespace(source string) (string, error) {
	switch {
	case strings.HasPrefix(source, "contracts/evm/"):
		return "eip155", nil
	case strings.HasPrefix(source, "contracts/svm/"):
		return "solana", nil
	case strings.HasPrefix(source, "contracts/tvm/"):
		return "tron", nil
	case strings.HasPrefix(source, "contracts/stellar/"):
		return "stellar", nil
	}
	return "", fmt.Errorf("source %s: unknown VM", source)
}

// Build returns the chain files, keyed by file name. repo holds the deployments files at the paths
// the spec cites. The result passes registry.LoadFS.
func Build(repo fs.FS, spec Spec) (map[string][]byte, error) {
	chains := map[string]*registry.Chain{}
	var order []string
	for _, s := range spec.Versions {
		ns, err := namespace(s.Source)
		if err != nil {
			return nil, err
		}
		raw, err := fs.ReadFile(repo, s.Source)
		if err != nil {
			return nil, err
		}
		var all map[string]json.RawMessage
		if err := json.Unmarshal(raw, &all); err != nil {
			return nil, fmt.Errorf("parse %s: %w", s.Source, err)
		}
		n := 0
		for key, msg := range all {
			var d deployment
			if json.Unmarshal(msg, &d) != nil || d.Contracts == nil {
				continue // metadata keys such as $schema or notes
			}
			if d.Deployed != nil && !*d.Deployed {
				continue
			}
			n++
			// Stellar's file keys chains by their full CAIP-2 id, the others by the reference alone.
			id := key
			if !strings.HasPrefix(key, ns+":") {
				id = ns + ":" + key
			}
			c := chains[id]
			if c == nil {
				c = &registry.Chain{Chain: id, Name: d.Name, Mainnet: d.Mainnet}
				chains[id] = c
				order = append(order, id)
			} else if c.Name != d.Name || c.Mainnet != d.Mainnet {
				return nil, fmt.Errorf("%s: %s says name/mainnet %q/%v, another deployments file says %q/%v", id, s.Source, d.Name, d.Mainnet, c.Name, c.Mainnet)
			}
			if d.Contracts["Escrow"] == "" || d.Contracts["FulfillmentProxy"] == "" {
				return nil, fmt.Errorf("%s: %s has no Escrow or FulfillmentProxy", id, s.Source)
			}
			proxies := []string{d.Contracts["FulfillmentProxy"]}
			if p := d.Contracts["FulfillmentProxyPreview"]; p != "" {
				proxies = append(proxies, p)
			}
			c.Versions = append(c.Versions, registry.Version{
				ID:                 s.ID,
				Source:             s.Source,
				Escrow:             d.Contracts["Escrow"],
				FulfillmentProxies: proxies,
				Permit2:            d.Contracts["Permit2"],
				Signature:          s.Signature,
			})
		}
		if n == 0 {
			return nil, fmt.Errorf("source %s: no chain entries", s.Source)
		}
	}
	for _, u := range spec.Unrecorded {
		if u.Address == "" || u.Reason == "" || len(u.Chains) == 0 {
			return nil, fmt.Errorf("unrecorded proxy %q: address, reason and chains are required", u.Address)
		}
		for _, id := range u.Chains {
			v := findVersion(chains[id], u.Version)
			if v == nil {
				return nil, fmt.Errorf("unrecorded proxy %s: %s has no version %s", u.Address, id, u.Version)
			}
			for _, p := range v.FulfillmentProxies {
				if strings.EqualFold(p, u.Address) {
					return nil, fmt.Errorf("unrecorded proxy %s: %s %s already lists it", u.Address, id, u.Version)
				}
			}
			v.FulfillmentProxies = append(v.FulfillmentProxies, u.Address)
			if v.UnrecordedFulfillmentProxies == nil {
				v.UnrecordedFulfillmentProxies = map[string]string{}
			}
			v.UnrecordedFulfillmentProxies[u.Address] = u.Reason
		}
	}
	out := map[string][]byte{}
	for _, id := range order {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(chains[id]); err != nil {
			return nil, err
		}
		out[strings.ReplaceAll(id, ":", "_")+".json"] = buf.Bytes()
	}
	return out, nil
}

func findVersion(c *registry.Chain, id string) *registry.Version {
	if c == nil {
		return nil
	}
	for i := range c.Versions {
		if c.Versions[i].ID == id {
			return &c.Versions[i]
		}
	}
	return nil
}
