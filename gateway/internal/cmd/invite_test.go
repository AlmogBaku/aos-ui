package cmd

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"strings"
	"testing"
	"time"

	"aosui/gateway/invite"
)

func inviteEnvironment() map[string]string {
	return map[string]string{
		"AOS_GATEWAY_INVITE_SIGNING_KEY": base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{'k'}, 32)),
		"AOS_GATEWAY_GUEST_ORIGIN":       "https://guest.example",
	}
}

func TestInviteHelpDocumentsSecureUsageWithoutReadingEnvironment(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{"invite", "--help"}, Streams{Out: &stdout, Err: &stderr}, Dependencies{
		Getenv: func(string) string { t.Fatal("help read environment"); return "" },
	})
	if code != 0 || stderr.Len() != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	for _, text := range []string{"--agent", "--ref", "--instruction-file", "AOS_GATEWAY_INVITE_SIGNING_KEY", "AOS_GATEWAY_GUEST_ORIGIN", "bearer credential", "readable", "Examples:"} {
		if !strings.Contains(stdout.String(), text) {
			t.Fatalf("help does not contain %q:\n%s", text, stdout.String())
		}
	}
}

func TestInviteReadsInstructionAndUsesInjectedClock(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "instruction-*.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("Load the /interview skill for Dan."); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	environment := inviteEnvironment()
	now := time.Now().Truncate(time.Second)
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{
		"invite", "--agent", "interviewer", "--ref", "dan", "--expires-in", "1h",
		"--prefill", "Hey, Almog sent me here!", "--instruction-file", file.Name(), "--lang", "he",
	}, Streams{In: strings.NewReader(""), Out: &stdout, Err: &stderr}, Dependencies{
		Getenv: func(key string) string { return environment[key] }, Now: func() time.Time { return now },
	})
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	token := strings.TrimPrefix(strings.TrimSpace(stdout.String()), "https://guest.example/#invite=")
	auth, _ := invite.New(environment["AOS_GATEWAY_INVITE_SIGNING_KEY"], environment["AOS_GATEWAY_GUEST_ORIGIN"])
	claims, err := auth.Verify(token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.IssuedAt != now.Unix() || claims.Agent != "interviewer" || claims.Ref != "dan" || claims.FirstTurn == nil || claims.FirstTurn.Prefill != "Hey, Almog sent me here!" || claims.FirstTurn.Instruction != "Load the /interview skill for Dan." || claims.UI == nil || claims.UI.Lang != "he" {
		t.Fatalf("claims = %#v", claims)
	}
}

func TestInviteRejectsPrivateInstructionArgument(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{"invite", "--agent", "interviewer", "--ref", "dan", "--instruction", "private"}, Streams{Out: &stdout, Err: &stderr}, Dependencies{})
	if code != 1 || !strings.Contains(stderr.String(), "unknown flag") || !strings.Contains(stderr.String(), "aos-gateway invite --help") {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
}

func TestInviteDoesNotEchoPositionalArguments(t *testing.T) {
	const secret = "Load the secret dossier for Dan"
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{"invite", "--agent", "interviewer", "--ref", "dan", secret}, Streams{Out: &stdout, Err: &stderr}, Dependencies{})
	if code != 1 {
		t.Fatalf("exit = %d", code)
	}
	if strings.Contains(stdout.String(), secret) || strings.Contains(stderr.String(), secret) {
		t.Fatalf("private positional argument was echoed: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "positional arguments are not accepted") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}
