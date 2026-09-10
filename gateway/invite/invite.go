// Package invite encrypts and validates stateless conversation invitations.
package invite

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"

	"aosui/gateway/conversation"
	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jwe"
)

const MaxTokenBytes = 3 * 1024

var ErrInvalid = errors.New("invalid or expired invitation")

type FirstTurn struct {
	Prefill     string `json:"prefill,omitempty"`
	Instruction string `json:"instruction,omitempty"`
}

type UI struct {
	Lang    string `json:"lang,omitempty"`
	Name    string `json:"name,omitempty"`
	LogoURL string `json:"logoUrl,omitempty"`
	Accent  string `json:"accent,omitempty"`
	Title   string `json:"title,omitempty"`
	Message string `json:"message,omitempty"`
}

type Claims struct {
	Version   int        `json:"v"`
	Issuer    string     `json:"iss"`
	Audience  string     `json:"aud"`
	IssuedAt  int64      `json:"iat"`
	ExpiresAt int64      `json:"exp"`
	Agent     string     `json:"agent"`
	Ref       string     `json:"ref"`
	FirstTurn *FirstTurn `json:"firstTurn,omitempty"`
	UI        *UI        `json:"ui,omitempty"`
}

type Auth struct {
	key    []byte
	origin string
}

func (c Claims) Scope() conversation.Scope { return conversation.Scope{Agent: c.Agent, Ref: c.Ref} }

func New(encodedKey, origin string) (*Auth, error) {
	key, err := base64.RawURLEncoding.DecodeString(encodedKey)
	if err != nil || len(key) != 32 {
		return nil, errors.New("invite encryption key must be 32 base64url-encoded bytes")
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("guest origin must be an HTTPS origin without a path")
	}
	return &Auth{key: key, origin: strings.TrimSuffix(origin, "/")}, nil
}

func (a *Auth) Origin() string { return a.origin }

func (a *Auth) Encrypt(c Claims) (string, error) {
	if err := a.validate(c); err != nil {
		return "", err
	}
	payload, err := json.Marshal(c)
	if err != nil {
		return "", ErrInvalid
	}
	sealed, err := jwe.Encrypt(payload, jwe.WithKey(jwa.DIRECT(), a.key), jwe.WithContentEncryption(jwa.A256GCM()), jwe.WithCompact())
	if err != nil || len(sealed) > MaxTokenBytes {
		return "", ErrInvalid
	}
	return string(sealed), nil
}

func (a *Auth) Decrypt(raw string) (Claims, error) {
	if raw == "" || len(raw) > MaxTokenBytes {
		return Claims{}, ErrInvalid
	}
	message, err := jwe.Parse([]byte(raw))
	if err != nil || message.ProtectedHeaders() == nil {
		return Claims{}, ErrInvalid
	}
	algorithm, hasAlgorithm := message.ProtectedHeaders().Algorithm()
	contentEncryption, hasContentEncryption := message.ProtectedHeaders().ContentEncryption()
	if !hasAlgorithm || algorithm != jwa.DIRECT() || !hasContentEncryption || contentEncryption != jwa.A256GCM() {
		return Claims{}, ErrInvalid
	}
	payload, err := jwe.Decrypt([]byte(raw), jwe.WithKey(jwa.DIRECT(), a.key))
	if err != nil {
		return Claims{}, ErrInvalid
	}
	var c Claims
	d := json.NewDecoder(bytes.NewReader(payload))
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil || d.Decode(&struct{}{}) != io.EOF {
		return Claims{}, ErrInvalid
	}
	if err := a.validate(c); err != nil {
		return Claims{}, err
	}
	return c, nil
}

func (c Claims) ConversationKey() string {
	b, _ := json.Marshal(struct {
		Agent string `json:"agent"`
		Ref   string `json:"ref"`
	}{c.Agent, c.Ref})
	h := sha256.Sum256(b)
	return base64.RawURLEncoding.EncodeToString(h[:])
}

var refPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func boundedSingleLine(s string, n int, required bool) bool {
	return len(s) <= n && (!required || strings.TrimSpace(s) != "") && !strings.ContainsFunc(s, unicode.IsControl)
}

func boundedPlainText(s string, n int) bool {
	return len(s) <= n && !strings.ContainsFunc(s, func(r rune) bool {
		return unicode.IsControl(r) && r != '\n' && r != '\t'
	})
}

func (a *Auth) validate(c Claims) error {
	now := time.Now().Unix()
	if c.Version != 1 || c.Issuer != "aos-invite" || c.Audience != a.origin || c.IssuedAt <= 0 || c.IssuedAt > now || c.ExpiresAt <= now || c.ExpiresAt <= c.IssuedAt || !boundedSingleLine(c.Agent, 128, true) || !refPattern.MatchString(c.Ref) {
		return ErrInvalid
	}
	if first := c.FirstTurn; first != nil {
		if !boundedPlainText(first.Prefill, 2000) || !boundedPlainText(first.Instruction, 2000) || (first.Prefill == "" && first.Instruction == "") {
			return ErrInvalid
		}
	}
	if u := c.UI; u != nil {
		if (u.Lang != "" && u.Lang != "en" && u.Lang != "he") || !boundedSingleLine(u.Name, 128, false) || !boundedSingleLine(u.Title, 256, false) || !boundedPlainText(u.Message, 1500) || (u.Accent != "" && !colorPattern.MatchString(u.Accent)) {
			return ErrInvalid
		}
		if u.LogoURL != "" {
			p, err := url.Parse(u.LogoURL)
			if err != nil || len(u.LogoURL) > 512 || p.Scheme != "https" || p.Host == "" || p.User != nil {
				return fmt.Errorf("%w: logo URL", ErrInvalid)
			}
		}
	}
	return nil
}
