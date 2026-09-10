package invite

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// LinkOptions contains the operator-controlled fields for a guest invitation.
type LinkOptions struct {
	Agent       string
	Ref         string
	Lifetime    time.Duration
	Prefill     string
	Instruction string
	UI          *UI
}

// CreateLink validates options, encrypts the invitation, and returns its full URL.
func CreateLink(auth *Auth, now time.Time, options LinkOptions) (string, error) {
	if auth == nil {
		return "", errors.New("invitation authentication is required")
	}
	agent := strings.TrimSpace(options.Agent)
	ref := strings.TrimSpace(options.Ref)
	if agent == "" || ref == "" || options.Lifetime <= 0 {
		return "", errors.New("agent, ref, and a positive lifetime are required")
	}
	claims := Claims{
		Version: 1, Issuer: "aos-invite", Audience: auth.Origin(),
		IssuedAt: now.Unix(), ExpiresAt: now.Add(options.Lifetime).Unix(),
		Agent: agent, Ref: ref, UI: options.UI,
	}
	if options.Prefill != "" || options.Instruction != "" {
		claims.FirstTurn = &FirstTurn{Prefill: options.Prefill, Instruction: options.Instruction}
	}
	token, err := auth.Encrypt(claims)
	if err != nil {
		return "", fmt.Errorf("create invitation: %w", err)
	}
	return auth.Origin() + "/#invite=" + token, nil
}
