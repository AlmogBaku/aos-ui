package openclaw

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

func TestGatewayClientPerformsProtocolV4TokenHandshake(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		ctx := r.Context()
		_ = connection.Write(ctx, websocket.MessageText, []byte(`{"type":"event","event":"connect.challenge","payload":{"nonce":"n-1","ts":1},"seq":1}`))
		_, raw, err := connection.Read(ctx)
		if err != nil {
			t.Error(err)
			return
		}
		var connect struct {
			ID, Method string
			Params     struct {
				MinProtocol, MaxProtocol int
				Scopes                   []string
				Auth                     struct{ Token string }
			}
		}
		if json.Unmarshal(raw, &connect) != nil || connect.Method != "connect" || connect.Params.MinProtocol != 4 || connect.Params.MaxProtocol != 4 || connect.Params.Auth.Token != "secret" {
			t.Errorf("connect = %s", raw)
			return
		}
		hello := map[string]any{"type": "hello-ok", "protocol": 4, "server": map[string]any{"version": "test", "connId": "1"}, "features": map[string]any{"methods": []string{"sessions.list"}, "events": []string{"chat"}}, "snapshot": map[string]any{"presence": []any{}, "health": map[string]any{}, "stateVersion": 1, "uptimeMs": 1}, "auth": map[string]any{}, "policy": map[string]any{"maxPayload": 1048576, "maxBufferedBytes": 1048576, "tickIntervalMs": 1000}}
		payload, _ := json.Marshal(map[string]any{"type": "res", "id": connect.ID, "ok": true, "payload": hello})
		_ = connection.Write(ctx, websocket.MessageText, payload)
		_, raw, err = connection.Read(ctx)
		if err != nil {
			t.Error(err)
			return
		}
		var request struct{ ID, Method string }
		_ = json.Unmarshal(raw, &request)
		if request.Method != "sessions.list" {
			t.Errorf("request = %s", raw)
			return
		}
		payload, _ = json.Marshal(map[string]any{"type": "res", "id": request.ID, "ok": true, "payload": map[string]any{"sessions": []any{}}})
		_ = connection.Write(ctx, websocket.MessageText, payload)
	}))
	defer server.Close()

	client, err := newGatewayClient("ws"+strings.TrimPrefix(server.URL, "http"), "secret")
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Sessions []any `json:"sessions"`
	}
	if err := client.Request(context.Background(), "sessions.list", map[string]any{"limit": 1}, &result); err != nil {
		t.Fatal(err)
	}
}

func TestGatewayClientRejectsPublicCredentialsAndUnsupportedURL(t *testing.T) {
	for _, tc := range []Config{{BaseURL: "https://user:pass@example.test", Token: "x"}, {BaseURL: "file:///tmp/socket", Token: "x"}, {BaseURL: "wss://example.test", Token: ""}} {
		if _, err := newGatewayClient(tc.BaseURL, tc.Token); err == nil {
			t.Fatalf("accepted %#v", tc)
		}
	}
}
