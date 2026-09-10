package cmd

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestRootHelpIsDiscoverable(t *testing.T) {
	tests := [][]string{nil, {"--help"}, {"help"}}
	for _, args := range tests {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := Execute(context.Background(), args, Streams{Out: &stdout, Err: &stderr}, Dependencies{})
			if code != 0 {
				t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
			}
			for _, text := range []string{"aos-gateway", "invite", "serve", "aos-gateway [command] --help"} {
				if !strings.Contains(stdout.String(), text) {
					t.Fatalf("help does not contain %q:\n%s", text, stdout.String())
				}
			}
			if stderr.Len() != 0 {
				t.Fatalf("stderr = %q", stderr.String())
			}
			if strings.Contains(stdout.String(), "completion") {
				t.Fatalf("out-of-scope completion command was registered:\n%s", stdout.String())
			}
		})
	}
}

func TestUnknownCommandReturnsConciseErrorAndHelpHint(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{"unknown"}, Streams{Out: &stdout, Err: &stderr}, Dependencies{})
	if code != 1 {
		t.Fatalf("exit code = %d", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout = %q", stdout.String())
	}
	for _, text := range []string{"unknown command", "aos-gateway --help"} {
		if !strings.Contains(stderr.String(), text) {
			t.Fatalf("stderr does not contain %q: %s", text, stderr.String())
		}
	}
}
