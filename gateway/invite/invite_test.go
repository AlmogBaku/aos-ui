package invite_test

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"aosui/gateway/invite"
)

func key(seed byte) string {
	return base64.RawURLEncoding.EncodeToString(bytesOf(seed, 32))
}

func bytesOf(value byte, count int) []byte {
	result := make([]byte, count)
	for index := range result {
		result[index] = value
	}
	return result
}

func claims(now time.Time) invite.Claims {
	return invite.Claims{
		Version:   1,
		Issuer:    "aos-invite",
		Audience:  "https://guest.example",
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(time.Hour).Unix(),
		Agent:     "interviewer",
		Ref:       "dan-2026",
		FirstTurn: &invite.FirstTurn{Prefill: "Hey, Almog sent me here!", Instruction: "Load the /interview skill for Dan."},
	}
}

func TestEncryptedInvitationRoundTripKeepsInstructionPrivate(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, err := invite.New(key('a'), "https://guest.example")
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.Encrypt(claims(now))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(token, "interview") || strings.Contains(token, "Almog") {
		t.Fatal("compact invitation exposed plaintext")
	}
	got, err := auth.Decrypt(token)
	if err != nil {
		t.Fatal(err)
	}
	if got.Ref != "dan-2026" || got.FirstTurn == nil || got.FirstTurn.Instruction != "Load the /interview skill for Dan." {
		t.Fatalf("round trip: %#v", got)
	}
}

func TestEncryptedInvitationRejectsTamperingAndWrongKey(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, _ := invite.New(key('a'), "https://guest.example")
	token, err := auth.Encrypt(claims(now))
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 5 || len(parts[3]) < 2 {
		t.Fatalf("unexpected compact JWE: %q", token)
	}
	replacement := byte('A')
	if parts[3][1] == replacement {
		replacement = 'B'
	}
	parts[3] = parts[3][:1] + string(replacement) + parts[3][2:]
	tampered := strings.Join(parts, ".")
	if _, err := auth.Decrypt(tampered); err == nil {
		t.Fatal("tampered invitation accepted")
	}
	other, _ := invite.New(key('b'), "https://guest.example")
	if _, err := other.Decrypt(token); err == nil {
		t.Fatal("wrong key accepted")
	}
}

func TestInvitationRejectsExpiredAndWrongAudienceClaims(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, _ := invite.New(key('a'), "https://guest.example")

	expired := claims(now.Add(-2 * time.Hour))
	if _, err := auth.Encrypt(expired); err == nil {
		t.Fatal("expired invitation accepted")
	}

	wrongAudience := claims(now)
	wrongAudience.Audience = "https://other.example"
	if _, err := auth.Encrypt(wrongAudience); err == nil {
		t.Fatal("wrong-audience invitation accepted")
	}
}

func TestInvitationHasOneReferenceTarget(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, _ := invite.New(key('a'), "https://guest.example")
	invalid := claims(now)
	invalid.Ref = ""
	if _, err := auth.Encrypt(invalid); err == nil {
		t.Fatal("missing ref accepted")
	}
	invalid.Ref = strings.Repeat("a", 129)
	if _, err := auth.Encrypt(invalid); err == nil {
		t.Fatal("oversized ref accepted")
	}
}

func TestInvitationRejectsOversizedCiphertext(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, _ := invite.New(key('a'), "https://guest.example")
	invalid := claims(now)
	invalid.FirstTurn.Instruction = strings.Repeat("private", 1000)
	if _, err := auth.Encrypt(invalid); err == nil {
		t.Fatal("oversized invitation accepted")
	}
}

func TestInvitationAllowsBoundedMultilineFirstTurnText(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, _ := invite.New(key('a'), "https://guest.example")
	value := claims(now)
	value.FirstTurn = &invite.FirstTurn{
		Prefill:     "Hello Dan,\nthanks for joining.",
		Instruction: "Load the interview skill.\nFocus on product decisions.",
	}
	value.UI = &invite.UI{Message: "Welcome.\nYou can close this note."}
	if _, err := auth.Encrypt(value); err != nil {
		t.Fatalf("bounded plain text rejected: %v", err)
	}
}
