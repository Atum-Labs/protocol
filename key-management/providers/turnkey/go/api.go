package turnkey

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// apiConfig is the part of a signer's configuration that reaches Turnkey itself: where it is,
// which organization, and the API key that stamps each request.
type apiConfig struct {
	BaseURL        string
	OrganizationID string
	APIPublicKey   string
	APIPrivateKey  string
	HTTPClient     *http.Client
	PollInterval   time.Duration
	PollTimeout    time.Duration
}

// apiClient submits stamped activities to Turnkey and polls them to completion. It is shared by
// every signer in this package, so request stamping and error classification exist once.
type apiClient struct {
	baseURL        string
	organizationID string
	apiPublicKey   string
	apiPriv        *ecdsa.PrivateKey
	http           *http.Client
	pollInterval   time.Duration
	pollTimeout    time.Duration
}

// newAPIClient validates the Turnkey connection settings. It refuses a non-https BaseURL, since
// an http:// endpoint would carry the X-Stamp header, our P-256 signature included, in cleartext.
func newAPIClient(cfg apiConfig) (apiClient, error) {
	if cfg.BaseURL == "" {
		return apiClient{}, errors.New("turnkey: BaseURL is required")
	}
	if !strings.HasPrefix(cfg.BaseURL, "https://") {
		return apiClient{}, errors.New("turnkey: BaseURL must use https:// scheme")
	}
	if cfg.OrganizationID == "" {
		return apiClient{}, errors.New("turnkey: OrganizationID is required")
	}
	if cfg.APIPublicKey == "" || cfg.APIPrivateKey == "" {
		return apiClient{}, errors.New("turnkey: APIPublicKey and APIPrivateKey are required")
	}
	if err := verifyAPIKeyPair(cfg.APIPublicKey, cfg.APIPrivateKey); err != nil {
		return apiClient{}, err
	}
	apiPriv, err := parseP256Private(cfg.APIPrivateKey)
	if err != nil {
		return apiClient{}, err
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	pi := cfg.PollInterval
	if pi <= 0 {
		pi = 250 * time.Millisecond
	}
	pt := cfg.PollTimeout
	if pt <= 0 {
		pt = 30 * time.Second
	}
	return apiClient{
		baseURL:        cfg.BaseURL,
		organizationID: cfg.OrganizationID,
		apiPublicKey:   cfg.APIPublicKey,
		apiPriv:        apiPriv,
		http:           hc,
		pollInterval:   pi,
		pollTimeout:    pt,
	}, nil
}

// --- Turnkey activity shapes shared by every signer ---

type activity struct {
	ID     string         `json:"id"`
	Status string         `json:"status"`
	Result activityResult `json:"result"`
}

type activityResult struct {
	SignTransactionResult signTransactionResult `json:"signTransactionResult"`
	SignRawPayloadResult  signRawPayloadResult  `json:"signRawPayloadResult"`
}

type signTransactionResult struct {
	SignedTransaction string `json:"signedTransaction"`
}

// signRawPayloadResult carries the signature as hex components. On secp256k1 V is the recovery
// id ("00" or "01"); on ed25519 R and S are the two 32-byte halves and V is empty.
type signRawPayloadResult struct {
	R string `json:"r"`
	S string `json:"s"`
	V string `json:"v"`
}

type activityEnvelope struct {
	Activity activity `json:"activity"`
}

type getActivityRequest struct {
	OrganizationID string `json:"organizationId"`
	ActivityID     string `json:"activityId"`
}

func (c *apiClient) submit(ctx context.Context, path string, body any) (activity, error) {
	respBody, err := c.post(ctx, path, body)
	if err != nil {
		return activity{}, err
	}
	var env activityEnvelope
	if err := json.Unmarshal(respBody, &env); err != nil {
		return activity{}, &Error{Op: path, Cause: fmt.Errorf("turnkey: decode: %w", err)}
	}
	return env.Activity, nil
}

// post sends a stamped request and returns the 2xx response body.
func (c *apiClient) post(ctx context.Context, path string, body any) ([]byte, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, &Error{Op: "marshal", Cause: err}
	}
	stamp, err := stampBody(c.apiPublicKey, c.apiPriv, raw)
	if err != nil {
		return nil, &Error{Op: "stamp", Cause: err}
	}
	endpoint, err := url.JoinPath(c.baseURL, path)
	if err != nil {
		return nil, &Error{Op: path, Cause: err}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, &Error{Op: path, Cause: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Stamp", stamp)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{Op: path, Transient: true, Cause: fmt.Errorf("turnkey: request: %w", err)}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return nil, classify(resp.StatusCode, path, respBody)
	}
	return respBody, nil
}

// awaitCompletion polls an activity until it completes. activityType and signWith only label
// the error, so an operator can tell which key and which request shape stalled. With
// waitForConsensus false, CONSENSUS_NEEDED is terminal: a caller that cannot wait for a human
// approver fails at once instead of polling until the timeout.
func (c *apiClient) awaitCompletion(ctx context.Context, a activity, activityType, signWith string, waitForConsensus bool) (activity, error) {
	deadline := time.Now().Add(c.pollTimeout)
	// Explicit timer reused across iterations and stopped on exit, so a
	// cancelled context doesn't leave an orphaned timer pending.
	timer := time.NewTimer(c.pollInterval)
	defer timer.Stop()
	for {
		switch a.Status {
		case "ACTIVITY_STATUS_COMPLETED":
			return a, nil
		case "ACTIVITY_STATUS_PENDING":
			// continue polling
		case "ACTIVITY_STATUS_CONSENSUS_NEEDED":
			if !waitForConsensus {
				return a, &Error{Op: "activity", Cause: fmt.Errorf("%w: activity %s (type=%s, signWith=%s) needs consensus approval, which this signer does not wait for", ErrActivityRejected, a.ID, activityType, signWith)}
			}
		case "ACTIVITY_STATUS_REJECTED", "ACTIVITY_STATUS_FAILED":
			return a, &Error{Op: "activity", Cause: fmt.Errorf("%w: activity %s (type=%s, signWith=%s) terminated with status %s", ErrActivityRejected, a.ID, activityType, signWith, a.Status)}
		default:
			return a, &Error{Op: "activity", Cause: fmt.Errorf("turnkey: activity %s (type=%s, signWith=%s) ended in unexpected status %q", a.ID, activityType, signWith, a.Status)}
		}
		if time.Now().After(deadline) {
			return a, &Error{Op: "activity", Transient: true, Cause: fmt.Errorf("turnkey: activity %s (type=%s, signWith=%s) timed out after %s in status %s", a.ID, activityType, signWith, c.pollTimeout, a.Status)}
		}
		select {
		case <-ctx.Done():
			return a, &Error{Op: "activity", Cause: ctx.Err()}
		case <-timer.C:
			timer.Reset(c.pollInterval)
		}
		polled, err := c.submit(ctx, "/public/v1/query/get_activity", getActivityRequest{
			OrganizationID: c.organizationID, ActivityID: a.ID,
		})
		if err != nil {
			return a, err
		}
		a = polled
	}
}
