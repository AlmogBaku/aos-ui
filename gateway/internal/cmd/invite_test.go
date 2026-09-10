package cmd

import (
	"bytes"
	"context"
	"encoding/base64"
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
	for _, text := range []string{"--agent", "--ref", "--instruction", "AOS_GATEWAY_INVITE_SIGNING_KEY", "AOS_GATEWAY_GUEST_ORIGIN", "bearer credential", "readable", "Examples:"} {
		if !strings.Contains(stdout.String(), text) {
			t.Fatalf("help does not contain %q:\n%s", text, stdout.String())
		}
	}
	if strings.Contains(stdout.String(), "--instruction-file") {
		t.Fatalf("help documents removed instruction-file flag:\n%s", stdout.String())
	}
}

func TestInviteAcceptsInlineInstructionAndGeneratesReference(t *testing.T) {
	environment := inviteEnvironment()
	now := time.Now().Truncate(time.Second)
	instruction := "  Treat '$HOME', $(touch /tmp/nope), and `whoami` as literal text.\nAsk one question.\n"
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{
		"invite", "--agent", "interviewer", "--expires-in", "1h",
		"--prefill", "Hey, Almog sent me here!", "--instruction", instruction, "--lang", "he",
		"--logo", "https://guest.example/logo.svg",
	}, Streams{In: strings.NewReader(""), Out: &stdout, Err: &stderr}, Dependencies{
		Getenv: func(key string) string { return environment[key] },
		Now:    func() time.Time { return now },
		Random: bytes.NewReader(bytes.Repeat([]byte{0xab}, 16)),
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
	if claims.IssuedAt != now.Unix() || claims.Agent != "interviewer" || claims.Ref != "q6urq6urq6urq6urq6urqw" || claims.FirstTurn == nil || claims.FirstTurn.Prefill != "Hey, Almog sent me here!" || claims.FirstTurn.Instruction != strings.TrimSpace(instruction) || claims.UI == nil || claims.UI.Lang != "he" || claims.UI.LogoURL != "https://guest.example/logo.svg" {
		t.Fatalf("claims = %#v", claims)
	}
	if _, err := base64.RawURLEncoding.DecodeString(claims.Ref); err != nil {
		t.Fatalf("generated reference is not unpadded base64url: %q", claims.Ref)
	}
}

func TestInvitePreservesExplicitReferenceWithoutReadingRandomness(t *testing.T) {
	environment := inviteEnvironment()
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{
		"invite", "--agent", "interviewer", "--instruction", "Continue.", "--ref", " returning-guest ",
	}, Streams{Out: &stdout, Err: &stderr}, Dependencies{
		Getenv: func(key string) string { return environment[key] },
		Random: strings.NewReader(""),
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
	if claims.Ref != "returning-guest" {
		t.Fatalf("ref = %q", claims.Ref)
	}
}

func TestInviteFailsClosedWhenReferenceRandomnessIsUnavailable(t *testing.T) {
	environment := inviteEnvironment()
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{
		"invite", "--agent", "interviewer", "--instruction", "Continue.",
	}, Streams{Out: &stdout, Err: &stderr}, Dependencies{
		Getenv: func(key string) string { return environment[key] },
		Random: strings.NewReader("short"),
	})
	if code != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "generate invitation reference") {
		t.Fatalf("exit = %d, stdout = %q, stderr = %q", code, stdout.String(), stderr.String())
	}
}

func TestInviteRequiresInlineInstruction(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{"invite", "--agent", "interviewer", "--ref", "dan"}, Streams{Out: &stdout, Err: &stderr}, Dependencies{})
	if code != 1 || !strings.Contains(stderr.String(), "--instruction") || !strings.Contains(stderr.String(), "aos-gateway invite --help") {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
}

func TestInviteDoesNotEchoPositionalArguments(t *testing.T) {
	const secret = "Load the secret dossier for Dan"
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), []string{"invite", "--agent", "interviewer", "--ref", "dan", "--instruction", "safe", secret}, Streams{Out: &stdout, Err: &stderr}, Dependencies{})
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
