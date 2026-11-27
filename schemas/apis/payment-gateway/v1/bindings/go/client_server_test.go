package paymentgateway_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	paymentgateway "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go"
	"github.com/gin-gonic/gin"
)

type defaultsHandler struct {
	paymentgateway.ServerInterface
	requested chan string
}

func (h defaultsHandler) GetDefaults(c *gin.Context, params paymentgateway.GetDefaultsParams) {
	if params.ChainId == nil {
		c.Status(http.StatusBadRequest)
		return
	}
	h.requested <- *params.ChainId
	c.JSON(http.StatusOK, paymentgateway.ChainDefaults{ChainId: *params.ChainId})
}

func TestGeneratedClientServerRoundTrip(t *testing.T) {
	handler := defaultsHandler{requested: make(chan string, 1)}
	router := gin.New()
	paymentgateway.RegisterHandlers(router, handler)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	client, err := paymentgateway.NewClientWithResponses(server.URL, paymentgateway.WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	chainID := "eip155:84532"
	response, err := client.GetDefaultsWithResponse(ctx, &paymentgateway.GetDefaultsParams{ChainId: &chainID})
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode() != http.StatusOK || response.JSON200 == nil {
		t.Fatalf("defaults response: status %d, body %s", response.StatusCode(), response.Body)
	}
	defaults, err := response.JSON200.AsChainDefaults()
	if err != nil {
		t.Fatal(err)
	}
	if defaults.ChainId != chainID {
		t.Fatalf("response chain_id: got %q, want %q", defaults.ChainId, chainID)
	}
	select {
	case got := <-handler.requested:
		if got != chainID {
			t.Fatalf("handler chain_id: got %q, want %q", got, chainID)
		}
	default:
		t.Fatal("request did not reach the generated server handler")
	}
}
