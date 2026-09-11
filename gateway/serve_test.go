package gateway

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestAdapterSelectionIncludesOpenClawAndRejectsUnknownRuntime(t *testing.T) {
	adapter, err := newAdapter(Config{Runtime: "openclaw", Upstream: "ws://127.0.0.1:18789", OpenClaw: OpenClawConfig{Token: "secret"}})
	if err != nil || adapter == nil {
		t.Fatalf("openclaw adapter = %T, %v", adapter, err)
	}
	_, err = newAdapter(Config{Runtime: "unknown"})
	if err == nil || !strings.Contains(err.Error(), "openclaw") {
		t.Fatalf("unknown runtime error = %v", err)
	}
}

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
