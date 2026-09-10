package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"aosui/gateway/conversation"
	"aosui/gateway/invite"
)

const cookieName = "__Host-aos-invite"
const maxBody = 8 * 1024 * 1024

type Guest struct {
	auth       *invite.Auth
	adapter    conversation.Adapter
	static     http.Handler
	locks      keyedLocks
	eventLocks keyedLocks
	eventMu    sync.Mutex
	eventCache map[string]cachedSnapshot
}

type cachedSnapshot struct {
	snapshot conversation.Snapshot
	at       time.Time
}

func NewGuest(auth *invite.Auth, adapter conversation.Adapter, dist string) *Guest {
	return &Guest{auth: auth, adapter: adapter, static: staticFiles(dist), eventCache: map[string]cachedSnapshot{}}
}

func jsonResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, status int, code string) {
	jsonResponse(w, status, map[string]string{"error": code})
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return errors.New("expected JSON")
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return errors.New("trailing data")
	}
	return nil
}
func adapterFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, conversation.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, conversation.ErrAmbiguous):
		failure(w, 409, "ambiguous")
	case errors.Is(err, conversation.ErrUnsupported):
		failure(w, 422, "unsupported")
	case errors.Is(err, conversation.ErrUncertain):
		failure(w, 409, "uncertain")
	default:
		failure(w, 503, "unavailable")
	}
}

func (g *Guest) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	if r.URL.Path == "/runtime-config.json" && r.Method == http.MethodGet {
		jsonResponse(w, 200, map[string]string{"surface": "guest"})
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/guest/") {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		g.static.ServeHTTP(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("Origin") != g.auth.Origin() {
		failure(w, 403, "origin")
		return
	}
	if r.URL.Path == "/api/guest/redeem" {
		if r.Method != http.MethodPost {
			failure(w, 405, "method")
			return
		}
		var body struct {
			Token string `json:"token"`
		}
		if decode(w, r, &body) != nil {
			failure(w, 400, "invalid-request")
			return
		}
		c, err := g.auth.Decrypt(body.Token)
		if err != nil {
			failure(w, 401, "invalid-invite")
			return
		}
		caps, err := g.adapter.Capabilities(r.Context(), c.Scope())
		if err != nil {
			adapterFailure(w, err)
			return
		}
		state, err := g.adapter.State(r.Context(), c.Scope())
		if err != nil {
			adapterFailure(w, err)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: body.Token, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, Expires: time.Unix(c.ExpiresAt, 0)})
		bootstrap(w, c, caps, state)
		return
	}
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		failure(w, 401, "invalid-invite")
		return
	}
	c, err := g.auth.Decrypt(cookie.Value)
	if err != nil {
		failure(w, 401, "invalid-invite")
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), time.Unix(c.ExpiresAt, 0))
	defer cancel()
	r = r.WithContext(ctx)
	if r.URL.Path == "/api/guest/bootstrap" && r.Method == http.MethodGet {
		caps, err := g.adapter.Capabilities(ctx, c.Scope())
		if err != nil {
			adapterFailure(w, err)
			return
		}
		state, err := g.adapter.State(ctx, c.Scope())
		if err != nil {
			adapterFailure(w, err)
			return
		}
		bootstrap(w, c, caps, state)
		return
	}
	key := r.Header.Get("X-AOS-Conversation")
	if r.URL.Path == "/api/guest/events" && r.Method == http.MethodGet {
		key = r.URL.Query().Get("conversation")
	}
	if key != c.ConversationKey() {
		failure(w, 409, "conversation-changed")
		return
	}
	g.operation(w, r, c)
}

func bootstrap(w http.ResponseWriter, c invite.Claims, caps conversation.Capabilities, state conversation.State) {
	prefill := ""
	if state.Status == conversation.StatusNew && c.FirstTurn != nil {
		prefill = c.FirstTurn.Prefill
	}
	jsonResponse(w, 200, struct {
		Conversation string                    `json:"conversation"`
		ExpiresAt    int64                     `json:"expiresAt"`
		State        conversation.Status       `json:"state"`
		Prefill      string                    `json:"prefill,omitempty"`
		UI           *invite.UI                `json:"ui,omitempty"`
		Capabilities conversation.Capabilities `json:"capabilities"`
	}{c.ConversationKey(), c.ExpiresAt, state.Status, prefill, c.UI, caps})
}
