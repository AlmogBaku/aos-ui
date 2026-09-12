package server_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aosui/gateway/server"
)

func TestOperatorForwardsNativeAuthWithoutInviteCookie(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/session" || r.URL.Query().Get("directory") != "/external" || r.Header.Get("Authorization") != "Basic native" || strings.Contains(r.Header.Get("Cookie"), "aos-invite") {
			t.Errorf("unsafe native forwarding %s %v", r.URL, r.Header)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: native\n\n")
	}))
	defer upstream.Close()
	h, err := server.NewOperator(server.OperatorConfig{Runtime: "opencode", Upstream: upstream.URL, Directory: "/external"})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "http://localhost:8080/opencode/session?directory=/browser-controlled", nil)
	r.Header.Set("Authorization", "Basic native")
	r.Header.Set("Cookie", "native=ok; __Host-aos-invite=secret")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != "data: native\n\n" {
		t.Fatalf("proxy: %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost:8080/runtime-config.json", nil))
	if !strings.Contains(w.Body.String(), `"baseUrl":"/opencode"`) || !strings.Contains(w.Body.String(), `"directory":"/__aos_opencode__"`) || strings.Contains(w.Body.String(), upstream.URL) || strings.Contains(w.Body.String(), "/external") {
		t.Fatalf("config not same-origin: %s", w.Body)
	}
}

func TestOperatorPublishesCredentialFreeOpenClawConfigAndForwardsWebSockets(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" || r.Header.Get("Origin") != "http://"+r.Host || strings.Contains(r.Header.Get("Cookie"), "aos-invite") {
			t.Errorf("unsafe OpenClaw forwarding: %s %#v", r.URL, r.Header)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	h, err := server.NewOperator(server.OperatorConfig{Runtime: "openclaw", Upstream: upstream.URL})
	if err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest("GET", "http://operator.example/openclaw", nil)
	r.Header.Set("Origin", "http://operator.example")
	r.Header.Set("Cookie", "native=ok; __Host-aos-invite=secret")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("proxy = %d %s", w.Code, w.Body)
	}

	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://operator.example/runtime-config.json", nil))
	if got := w.Body.String(); !strings.Contains(got, `"mode":"openclaw"`) || !strings.Contains(got, `"baseUrl":"/openclaw"`) || strings.Contains(got, "secret") || strings.Contains(got, upstream.URL) {
		t.Fatalf("public config = %s", got)
	}
}

func TestOperatorAllowsWebSocketUpstreamOnlyForOpenClaw(t *testing.T) {
	if _, err := server.NewOperator(server.OperatorConfig{Runtime: "hermes", Upstream: "ws://127.0.0.1:9119"}); err == nil {
		t.Fatal("Hermes unexpectedly accepted a WebSocket-only upstream")
	}
	if _, err := server.NewOperator(server.OperatorConfig{Runtime: "opencode", Upstream: "wss://example.test", Directory: "/work"}); err == nil {
		t.Fatal("OpenCode unexpectedly accepted a WebSocket-only upstream")
	}
}

func TestOperatorServesTheLogoFromItsDeclaredBuild(t *testing.T) {
	dist := t.TempDir()
	if err := os.WriteFile(filepath.Join(dist, "logo-adaptive.svg"), []byte("<svg/>"), 0o600); err != nil {
		t.Fatal(err)
	}
	h, err := server.NewOperator(server.OperatorConfig{Runtime: "hermes", Upstream: "http://127.0.0.1:9119", Dist: dist})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "http://operator.example/logo-adaptive.svg", nil))
	if w.Code != http.StatusOK || w.Body.String() != "<svg/>" {
		t.Fatalf("logo response = %d %q", w.Code, w.Body.String())
	}
}

func TestOperatorKeepsHermesLoginRedirectUnderNativePrefix(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			t.Errorf("upstream path = %q", r.URL.Path)
		}
		http.Redirect(w, r, "/login?next=%2F", http.StatusFound)
	}))
	defer upstream.Close()
	h, err := server.NewOperator(server.OperatorConfig{Runtime: "hermes", Upstream: upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "http://operator.example/hermes", nil))
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/hermes/login?next=%2F" {
		t.Fatalf("redirect = %d %q", w.Code, w.Header().Get("Location"))
	}
}
