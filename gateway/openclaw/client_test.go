package openclaw

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"
)

func TestGatewayClientPersistsAndSignsProtocolV4DeviceHandshake(t *testing.T) {
	var connections atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		ctx := r.Context()
		attempt := connections.Add(1)
		_ = connection.Write(ctx, websocket.MessageText, []byte(`{"type":"event","event":"connect.challenge","payload":{"nonce":"n-1","ts":1710000000000},"seq":1}`))
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
				Client                   struct{ ID, Mode, Platform string }
				Device                   struct {
					ID, PublicKey, Signature, Nonce string
					SignedAt                        int64
				}
			}
		}
		wantToken := "secret"
		if attempt > 1 {
			wantToken = "paired-device-token"
		}
		if json.Unmarshal(raw, &connect) != nil || connect.Method != "connect" || connect.Params.MinProtocol != 4 || connect.Params.MaxProtocol != 4 || connect.Params.Auth.Token != wantToken {
			t.Errorf("connect = %s", raw)
			return
		}
		publicKey, err := base64.RawURLEncoding.DecodeString(connect.Params.Device.PublicKey)
		signature, signatureErr := base64.RawURLEncoding.DecodeString(connect.Params.Device.Signature)
		fingerprint := sha256.Sum256(publicKey)
		signedPayload := strings.Join([]string{"v3", connect.Params.Device.ID, connect.Params.Client.ID, connect.Params.Client.Mode, "operator", strings.Join(connect.Params.Scopes, ","), strconv.FormatInt(connect.Params.Device.SignedAt, 10), wantToken, "n-1", strings.ToLower(connect.Params.Client.Platform), "server"}, "|")
		if err != nil || signatureErr != nil || connect.Params.Device.ID != fmt.Sprintf("%x", fingerprint) || connect.Params.Device.Nonce != "n-1" || connect.Params.Device.SignedAt != 1710000000000 || !ed25519.Verify(publicKey, []byte(signedPayload), signature) {
			t.Errorf("invalid signed device handshake: %s", raw)
			return
		}
		hello := map[string]any{"type": "hello-ok", "protocol": 4, "server": map[string]any{"version": "test", "connId": "1"}, "features": map[string]any{"methods": []string{"sessions.list"}, "events": []string{"chat"}}, "snapshot": map[string]any{"presence": []any{}, "health": map[string]any{}, "stateVersion": 1, "uptimeMs": 1}, "auth": map[string]any{"deviceToken": "paired-device-token", "role": "operator", "scopes": connect.Params.Scopes}, "policy": map[string]any{"maxPayload": 1048576, "maxBufferedBytes": 1048576, "tickIntervalMs": 1000}}
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

	deviceFile := filepath.Join(t.TempDir(), "openclaw-device.json")
	client, err := newGatewayClient("ws"+strings.TrimPrefix(server.URL, "http"), "secret", deviceFile)
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	errorsChannel := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			var result struct {
				Sessions []any `json:"sessions"`
			}
			errorsChannel <- client.Request(context.Background(), "sessions.list", map[string]any{"limit": 1}, &result)
		}()
	}
	wait.Wait()
	close(errorsChannel)
	for err := range errorsChannel {
		if err != nil {
			t.Fatal(err)
		}
	}
	second, err := newGatewayClient("ws"+strings.TrimPrefix(server.URL, "http"), "", deviceFile)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Sessions []any `json:"sessions"`
	}
	if err := second.Request(context.Background(), "sessions.list", map[string]any{"limit": 1}, &result); err != nil {
		t.Fatal(err)
	}
	if connections.Load() != 3 {
		t.Fatalf("connections = %d", connections.Load())
	}
	if info, err := os.Stat(deviceFile); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("device file mode = %v, %v", info, err)
	}
}

func TestGatewayClientRejectsMissingLiveScopes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		ctx := r.Context()
		_ = connection.Write(ctx, websocket.MessageText, []byte(`{"type":"event","event":"connect.challenge","payload":{"nonce":"n","ts":1}}`))
		_, raw, _ := connection.Read(ctx)
		var request struct{ ID string }
		_ = json.Unmarshal(raw, &request)
		payload, _ := json.Marshal(map[string]any{"type": "res", "id": request.ID, "ok": true, "payload": map[string]any{"type": "hello-ok", "protocol": 4, "auth": map[string]any{"deviceToken": "limited", "role": "operator", "scopes": []string{"operator.read"}}}})
		_ = connection.Write(ctx, websocket.MessageText, payload)
	}))
	defer server.Close()
	client, err := newGatewayClient("ws"+strings.TrimPrefix(server.URL, "http"), "secret", filepath.Join(t.TempDir(), "device.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Request(context.Background(), "sessions.list", map[string]any{}, &struct{}{}); err == nil || !strings.Contains(err.Error(), "missing required OpenClaw scope") {
		t.Fatalf("scope error = %v", err)
	}
}

func TestGatewayClientRejectsMalformedOrInsecureDeviceState(t *testing.T) {
	for name, prepare := range map[string]func(string){
		"malformed":         func(path string) { _ = os.WriteFile(path, []byte("not json"), 0o600) },
		"broad permissions": func(path string) { _ = os.WriteFile(path, []byte(`{}`), 0o644) },
		"symlink": func(path string) {
			target := path + ".target"
			_ = os.WriteFile(target, []byte(`{}`), 0o600)
			_ = os.Symlink(target, path)
		},
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "device.json")
			prepare(path)
			if _, err := newGatewayClient("wss://example.test", "secret", path); err == nil {
				t.Fatal("accepted unsafe device state")
			}
		})
	}
}

func TestGatewayClientRejectsPersistedDeviceTokenWithoutRequiredScopes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.json")
	state, err := newDeviceState()
	if err != nil {
		t.Fatal(err)
	}
	state.DeviceToken = "paired"
	state.Scopes = []string{"operator.read"}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newGatewayClient("wss://example.test", "secret", path); err == nil || !strings.Contains(err.Error(), "scope") {
		t.Fatalf("wrong-scope state error = %v", err)
	}
}

func TestGatewayClientRejectsPublicCredentialsAndUnsupportedURL(t *testing.T) {
	deviceFile := filepath.Join(t.TempDir(), "unpaired.json")
	for _, tc := range []Config{{BaseURL: "https://user:pass@example.test", Token: "x", DeviceFile: deviceFile}, {BaseURL: "file:///tmp/socket", Token: "x", DeviceFile: deviceFile}, {BaseURL: "wss://example.test", Token: "", DeviceFile: deviceFile}, {BaseURL: "wss://example.test", Token: "x"}} {
		if _, err := newGatewayClient(tc.BaseURL, tc.Token, tc.DeviceFile); err == nil {
			t.Fatalf("accepted %#v", tc)
		}
	}
}
