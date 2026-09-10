package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"aosui/gateway/invite"
)

func TestInviteInspectHelpDocumentsPrivateLocalUsage(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{"invite", "inspect", "--help"}, Streams{Out: &stdout, Err: &stderr}, Dependencies{
		Getenv: func(string) string { t.Fatal("help read environment"); return "" },
	})
	if code != 0 || stderr.Len() != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	for _, text := range []string{"--link-file", "AOS_GATEWAY_INVITE_KEY", "AOS_GATEWAY_GUEST_ORIGIN", "private", "does not contact"} {
		if !strings.Contains(stdout.String(), text) {
			t.Fatalf("help does not contain %q:\n%s", text, stdout.String())
		}
	}
}

func TestInviteInspectDecryptsFullLinkOrRawToken(t *testing.T) {
	environment := inviteEnvironment()
	auth, err := invite.New(environment["AOS_GATEWAY_INVITE_KEY"], environment["AOS_GATEWAY_GUEST_ORIGIN"])
	if err != nil {
		t.Fatal(err)
	}
	link, err := invite.CreateLink(auth, time.Now().Add(-time.Minute), invite.LinkOptions{
		Agent: "interviewer", Ref: "dan", Lifetime: time.Hour,
		Prefill: "Hey, Almog sent me here!", Instruction: "Load the /interview skill for Dan.",
		UI: &invite.UI{Lang: "he", Title: "Interview"},
	})
	if err != nil {
		t.Fatal(err)
	}
	token := strings.TrimPrefix(link, environment["AOS_GATEWAY_GUEST_ORIGIN"]+"/#invite=")

	for _, test := range []struct {
		name  string
		input string
	}{
		{name: "full link", input: link},
		{name: "raw token", input: token},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := Execute(context.Background(), []string{"invite", "inspect", "--link-file", "-"}, Streams{
				In: strings.NewReader(test.input), Out: &stdout, Err: &stderr,
			}, Dependencies{Getenv: func(key string) string { return environment[key] }})
			if code != 0 {
				t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
			}
			var claims invite.Claims
			if err := json.Unmarshal(stdout.Bytes(), &claims); err != nil {
				t.Fatalf("output is not JSON: %v\n%s", err, stdout.String())
			}
			if claims.Agent != "interviewer" || claims.Ref != "dan" || claims.FirstTurn == nil || claims.FirstTurn.Instruction != "Load the /interview skill for Dan." || claims.UI == nil || claims.UI.Lang != "he" {
				t.Fatalf("claims = %#v", claims)
			}
			if strings.Contains(stdout.String(), token) || stderr.Len() != 0 {
				t.Fatalf("credential leaked or stderr written: stdout=%q stderr=%q", stdout.String(), stderr.String())
			}
		})
	}
}

func TestInviteInspectReadsFileAndDoesNotEchoInvalidCredential(t *testing.T) {
	const invalid = "secret-invalid-invitation"
	path := t.TempDir() + "/invite.txt"
	if err := os.WriteFile(path, []byte(invalid), 0o600); err != nil {
		t.Fatal(err)
	}
	environment := inviteEnvironment()
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{"invite", "inspect", "--link-file", path}, Streams{Out: &stdout, Err: &stderr}, Dependencies{
		Getenv: func(key string) string { return environment[key] },
	})
	if code != 1 || !strings.Contains(stderr.String(), "invalid or expired invitation") {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	if strings.Contains(stdout.String(), invalid) || strings.Contains(stderr.String(), invalid) {
		t.Fatalf("credential echoed: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}
