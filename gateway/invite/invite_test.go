package invite_test

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"aosui/gateway/invite"
	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jws"
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

func TestSignedInvitationRoundTripHasReadableClaims(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, err := invite.New(key('a'), "https://guest.example")
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.Sign(claims(now))
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		t.Fatalf("expected three non-empty JWT segments: %q", token)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var readable invite.Claims
	if err := json.Unmarshal(payload, &readable); err != nil {
		t.Fatal(err)
	}
	if readable.FirstTurn == nil || readable.FirstTurn.Instruction != "Load the /interview skill for Dan." {
		t.Fatalf("readable claims = %#v", readable)
	}
	got, err := auth.Verify(token)
	if err != nil {
		t.Fatal(err)
	}
	if got.Ref != "dan-2026" || got.FirstTurn == nil || got.FirstTurn.Instruction != "Load the /interview skill for Dan." {
		t.Fatalf("round trip: %#v", got)
	}
}

func TestSignedInvitationRejectsTamperingAndWrongKey(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, _ := invite.New(key('a'), "https://guest.example")
	token, err := auth.Sign(claims(now))
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || len(parts[1]) < 2 {
		t.Fatalf("unexpected compact JWT: %q", token)
	}
	replacement := byte('A')
	if parts[1][1] == replacement {
		replacement = 'B'
	}
	parts[1] = parts[1][:1] + string(replacement) + parts[1][2:]
	tampered := strings.Join(parts, ".")
	if _, err := auth.Verify(tampered); err == nil {
		t.Fatal("tampered invitation accepted")
	}
	other, _ := invite.New(key('b'), "https://guest.example")
	if _, err := other.Verify(token); err == nil {
		t.Fatal("wrong key accepted")
	}
}

func TestSignedInvitationRejectsUnsupportedAndLegacyTokens(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, _ := invite.New(key('a'), "https://guest.example")
	payload, err := json.Marshal(claims(now))
	if err != nil {
		t.Fatal(err)
	}
	wrongAlgorithm, err := jws.Sign(payload, jws.WithKey(jwa.HS384(), bytesOf('a', 32)))
	if err != nil {
		t.Fatal(err)
	}
	jsonSerialization, err := jws.Sign(payload, jws.WithJSON(), jws.WithKey(jwa.HS256(), bytesOf('a', 32)))
	if err != nil {
		t.Fatal(err)
	}
	for name, token := range map[string]string{
		"alternate algorithm": string(wrongAlgorithm),
		"unsigned":            "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(payload) + ".",
		"JSON serialization":  string(jsonSerialization),
		"legacy JWE":          "a.b.c.d.e",
		"malformed":           "not-a-jwt",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := auth.Verify(token); err == nil {
				t.Fatal("invalid invitation accepted")
			}
		})
	}
}

func TestSignedInvitationRejectsUnknownClaims(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, _ := invite.New(key('a'), "https://guest.example")
	payload, err := json.Marshal(map[string]any{
		"v": 1, "iss": "aos-invite", "aud": "https://guest.example",
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
		"agent": "interviewer", "ref": "dan-2026", "unknown": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := jws.Sign(payload, jws.WithKey(jwa.HS256(), bytesOf('a', 32)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := auth.Verify(string(token)); err == nil {
		t.Fatal("unknown claim accepted")
	}
}

func TestInvitationRejectsExpiredAndWrongAudienceClaims(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, _ := invite.New(key('a'), "https://guest.example")

	expired := claims(now.Add(-2 * time.Hour))
	if _, err := auth.Sign(expired); err == nil {
		t.Fatal("expired invitation accepted")
	}

	wrongAudience := claims(now)
	wrongAudience.Audience = "https://other.example"
	if _, err := auth.Sign(wrongAudience); err == nil {
		t.Fatal("wrong-audience invitation accepted")
	}
}

func TestInvitationHasOneReferenceTarget(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, _ := invite.New(key('a'), "https://guest.example")
	invalid := claims(now)
	invalid.Ref = ""
	if _, err := auth.Sign(invalid); err == nil {
		t.Fatal("missing ref accepted")
	}
	invalid.Ref = strings.Repeat("a", 129)
	if _, err := auth.Sign(invalid); err == nil {
		t.Fatal("oversized ref accepted")
	}
}

func TestInvitationRejectsOversizedToken(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	auth, _ := invite.New(key('a'), "https://guest.example")
	invalid := claims(now)
	invalid.FirstTurn.Instruction = strings.Repeat("private", 1000)
	if _, err := auth.Sign(invalid); err == nil {
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
	if _, err := auth.Sign(value); err != nil {
		t.Fatalf("bounded plain text rejected: %v", err)
	}
}
