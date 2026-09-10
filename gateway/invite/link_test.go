package invite_test

import (
	"strings"
	"testing"
	"time"

	"aosui/gateway/invite"
)

func TestCreateLinkBuildsValidatedInvitation(t *testing.T) {
	auth, err := invite.New(key('a'), "https://guest.example")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Truncate(time.Second)
	link, err := invite.CreateLink(auth, now, invite.LinkOptions{
		Agent: " interviewer ", Ref: "dan-2026", Lifetime: time.Hour,
		Prefill: "Hello", Instruction: "Load the interview skill.",
		UI: &invite.UI{Lang: "he", Title: "Interview"},
	})
	if err != nil {
		t.Fatal(err)
	}
	const prefix = "https://guest.example/#invite="
	if !strings.HasPrefix(link, prefix) {
		t.Fatalf("link = %q", link)
	}
	claims, err := auth.Verify(strings.TrimPrefix(link, prefix))
	if err != nil {
		t.Fatal(err)
	}
	if claims.Agent != "interviewer" || claims.Ref != "dan-2026" || claims.IssuedAt != now.Unix() || claims.ExpiresAt != now.Add(time.Hour).Unix() {
		t.Fatalf("claims = %#v", claims)
	}
	if claims.FirstTurn == nil || claims.FirstTurn.Prefill != "Hello" || claims.FirstTurn.Instruction != "Load the interview skill." {
		t.Fatalf("first turn = %#v", claims.FirstTurn)
	}
}

func TestCreateLinkRejectsMissingScopeAndInvalidLifetime(t *testing.T) {
	auth, _ := invite.New(key('a'), "https://guest.example")
	now := time.Now()
	for name, options := range map[string]invite.LinkOptions{
		"agent":    {Ref: "ref", Lifetime: time.Hour},
		"ref":      {Agent: "agent", Lifetime: time.Hour},
		"lifetime": {Agent: "agent", Ref: "ref"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := invite.CreateLink(auth, now, options); err == nil {
				t.Fatal("invalid options accepted")
			}
		})
	}
}
