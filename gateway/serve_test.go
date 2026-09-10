package gateway

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestPublicServerBoundsRequestReadsWithoutTimingOutStreams(t *testing.T) {
	configured := configuredServer(http.NotFoundHandler())
	if configured.ReadHeaderTimeout != 10*time.Second || configured.ReadTimeout != 30*time.Second {
		t.Fatalf("read timeouts = header %s body %s", configured.ReadHeaderTimeout, configured.ReadTimeout)
	}
	if configured.WriteTimeout != 0 {
		t.Fatalf("SSE write timeout = %s", configured.WriteTimeout)
	}
}

func TestServePairStopsWhenContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := servePair(ctx, "127.0.0.1:0", "127.0.0.1:0", http.NotFoundHandler(), http.NotFoundHandler()); err != nil {
		t.Fatalf("serve pair: %v", err)
	}
}
