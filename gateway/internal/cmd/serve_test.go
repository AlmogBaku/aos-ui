package cmd

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	gateway "aosui/gateway"
)

func TestServeHelpDocumentsConfigurationWithoutStartingListeners(t *testing.T) {
	var stdout, stderr bytes.Buffer
	called := false
	code := Execute(context.Background(), []string{"serve", "--help"}, Streams{Out: &stdout, Err: &stderr}, Dependencies{
		Serve:  func(context.Context, gateway.Config) error { called = true; return nil },
		Getenv: func(string) string { t.Fatal("help read environment"); return "" },
	})
	if code != 0 || stderr.Len() != 0 || called {
		t.Fatalf("exit = %d, called = %v, stderr = %q", code, called, stderr.String())
	}
	for _, text := range []string{"AOS_GATEWAY_RUNTIME", "AOS_GATEWAY_UPSTREAM", "AOS_GATEWAY_HERMES_TOKEN", "AOS_GATEWAY_OPENCODE_DIRECTORY", "127.0.0.1:8080", "127.0.0.1:8081", "HTTPS"} {
		if !strings.Contains(stdout.String(), text) {
			t.Fatalf("help does not contain %q:\n%s", text, stdout.String())
		}
	}
}

func TestServeMapsEnvironmentToTypedConfig(t *testing.T) {
	environment := map[string]string{
		"AOS_GATEWAY_RUNTIME":            "opencode",
		"AOS_GATEWAY_UPSTREAM":           "http://127.0.0.1:4096",
		"AOS_GATEWAY_OPENCODE_DIRECTORY": "/worktree",
		"AOS_GATEWAY_OPENCODE_USERNAME":  "operator",
		"AOS_GATEWAY_OPENCODE_PASSWORD":  "secret",
		"AOS_GATEWAY_INVITE_KEY":         "key",
		"AOS_GATEWAY_GUEST_ORIGIN":       "https://guest.example",
		"AOS_GATEWAY_DIST":               "/dist",
		"AOS_GATEWAY_OPERATOR_ADDR":      "127.0.0.1:9000",
		"AOS_GATEWAY_GUEST_ADDR":         "127.0.0.1:9001",
	}
	var received gateway.Config
	code := Execute(context.Background(), []string{"serve"}, Streams{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, Dependencies{
		Getenv: func(key string) string { return environment[key] },
		Serve:  func(_ context.Context, config gateway.Config) error { received = config; return nil },
	})
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if received.Runtime != "opencode" || received.Upstream != "http://127.0.0.1:4096" || received.OpenCode.Directory != "/worktree" || received.OpenCode.Username != "operator" || received.OpenCode.Password != "secret" || received.InviteKey != "key" || received.GuestOrigin != "https://guest.example" || received.Dist != "/dist" || received.OperatorAddress != "127.0.0.1:9000" || received.GuestAddress != "127.0.0.1:9001" {
		t.Fatalf("config = %#v", received)
	}
}

func TestServeUsesLoopbackDefaultsAndPropagatesRunnerError(t *testing.T) {
	var received gateway.Config
	var stderr bytes.Buffer
	code := Execute(context.Background(), []string{"serve"}, Streams{Out: &bytes.Buffer{}, Err: &stderr}, Dependencies{
		Getenv: func(string) string { return "" },
		Serve: func(_ context.Context, config gateway.Config) error {
			received = config
			return errors.New("listener failed")
		},
	})
	if code != 1 || received.Dist != "dist" || received.OperatorAddress != "127.0.0.1:8080" || received.GuestAddress != "127.0.0.1:8081" {
		t.Fatalf("exit = %d, config = %#v", code, received)
	}
	if !strings.Contains(stderr.String(), "listener failed") || !strings.Contains(stderr.String(), "aos-gateway serve --help") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}
