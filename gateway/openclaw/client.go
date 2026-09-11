package openclaw

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const protocolVersion = 4

type gatewayClient struct {
	url        string
	token      string
	deviceFile string
	deviceMu   sync.Mutex
	device     deviceState
	next       atomic.Uint64
}

type wireFrame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Event   string          `json:"event,omitempty"`
	OK      bool            `json:"ok,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Error   *struct {
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Details json.RawMessage `json:"details"`
	} `json:"error,omitempty"`
}

var requiredScopes = []string{"operator.read", "operator.write", "operator.questions"}

func newGatewayClient(rawURL, token, deviceFile string) (*gatewayClient, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	deviceFile = strings.TrimSpace(deviceFile)
	token = strings.TrimSpace(token)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || deviceFile == "" {
		return nil, errors.New("invalid OpenClaw configuration")
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return nil, errors.New("invalid OpenClaw configuration")
	}
	var state deviceState
	if token == "" {
		state, err = readDeviceState(deviceFile)
		if err == nil && state.DeviceToken == "" {
			err = errors.New("OpenClaw bootstrap token required before device pairing")
		}
	} else {
		state, err = loadOrCreateDeviceState(deviceFile)
	}
	if err != nil {
		return nil, err
	}
	return &gatewayClient{url: u.String(), token: token, deviceFile: deviceFile, device: state}, nil
}

func (c *gatewayClient) id() string { return fmt.Sprintf("aos-%d", c.next.Add(1)) }

func (c *gatewayClient) connect(ctx context.Context) (*websocket.Conn, error) {
	// Pairing and token rotation are one device-state transaction. Serializing
	// this short handshake prevents concurrent first requests from presenting
	// the bootstrap token after another request has already paired the device.
	c.deviceMu.Lock()
	defer c.deviceMu.Unlock()
	connection, response, err := websocket.Dial(ctx, c.url, &websocket.DialOptions{HTTPHeader: http.Header{"User-Agent": []string{"aos-gateway/openclaw"}}})
	if response != nil && response.Body != nil {
		response.Body.Close()
	}
	if err != nil {
		return nil, err
	}
	connection.SetReadLimit(16 << 20)
	closeWithError := func(err error) (*websocket.Conn, error) { connection.CloseNow(); return nil, err }
	handshakeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var challenge wireFrame
	if err := readJSON(handshakeCtx, connection, &challenge); err != nil {
		return closeWithError(err)
	}
	var challengePayload struct {
		Nonce string `json:"nonce"`
		TS    int64  `json:"ts"`
	}
	if challenge.Type != "event" || challenge.Event != "connect.challenge" || json.Unmarshal(challenge.Payload, &challengePayload) != nil || challengePayload.Nonce == "" || challengePayload.TS <= 0 {
		return closeWithError(errors.New("invalid OpenClaw challenge"))
	}
	device := c.device
	authToken := c.token
	if device.DeviceToken != "" {
		authToken = device.DeviceToken
	}
	publicKey, err := device.publicKeyBase64URL()
	if err != nil {
		return closeWithError(err)
	}
	// The reserved gateway-client/backend identity bypasses normal pairing on
	// loopback and therefore cannot mint the persistent device token we require.
	const clientID, clientMode, platform, deviceFamily = "cli", "cli", "go", "server"
	signedPayload := strings.Join([]string{
		"v3", device.DeviceID, clientID, clientMode, "operator", strings.Join(requiredScopes, ","),
		fmt.Sprintf("%d", challengePayload.TS), authToken, challengePayload.Nonce, platform, deviceFamily,
	}, "|")
	signature, err := device.sign(signedPayload)
	if err != nil {
		return closeWithError(err)
	}
	id := c.id()
	params := map[string]any{
		"minProtocol": protocolVersion, "maxProtocol": protocolVersion,
		"client": map[string]any{"id": clientID, "displayName": "AOS Gateway", "version": "1", "platform": platform, "deviceFamily": deviceFamily, "mode": clientMode, "instanceId": id},
		"caps":   []string{"tool-events", "session-events"},
		"role":   "operator", "scopes": requiredScopes,
		"auth":   map[string]any{"token": authToken},
		"device": map[string]any{"id": device.DeviceID, "publicKey": publicKey, "signature": signature, "signedAt": challengePayload.TS, "nonce": challengePayload.Nonce},
	}
	if err := writeJSON(handshakeCtx, connection, map[string]any{"type": "req", "id": id, "method": "connect", "params": params}); err != nil {
		return closeWithError(err)
	}
	var responseFrame wireFrame
	if err := readJSON(handshakeCtx, connection, &responseFrame); err != nil {
		return closeWithError(err)
	}
	if responseFrame.Type != "res" || responseFrame.ID != id || !responseFrame.OK {
		return closeWithError(frameError(responseFrame))
	}
	var hello struct {
		Type     string `json:"type"`
		Protocol int    `json:"protocol"`
		Auth     struct {
			DeviceToken string   `json:"deviceToken"`
			Role        string   `json:"role"`
			Scopes      []string `json:"scopes"`
		} `json:"auth"`
	}
	if json.Unmarshal(responseFrame.Payload, &hello) != nil || hello.Type != "hello-ok" || hello.Protocol != protocolVersion {
		return closeWithError(errors.New("OpenClaw protocol mismatch"))
	}
	if hello.Auth.Role != "operator" || hello.Auth.DeviceToken == "" {
		return closeWithError(errors.New("OpenClaw paired device authority missing"))
	}
	liveScopes := make(map[string]bool, len(hello.Auth.Scopes))
	for _, scope := range hello.Auth.Scopes {
		liveScopes[scope] = true
	}
	for _, scope := range requiredScopes {
		if !liveScopes[scope] {
			return closeWithError(fmt.Errorf("missing required OpenClaw scope %s", scope))
		}
	}
	if device.DeviceToken != hello.Auth.DeviceToken || !equalStrings(device.Scopes, hello.Auth.Scopes) {
		device.DeviceToken = hello.Auth.DeviceToken
		device.Scopes = append([]string(nil), hello.Auth.Scopes...)
		if err := replaceDeviceState(c.deviceFile, device); err != nil {
			return closeWithError(fmt.Errorf("persist OpenClaw device token: %w", err))
		}
		c.device = device
	}
	return connection, nil
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func (c *gatewayClient) Request(ctx context.Context, method string, params any, out any) error {
	connection, err := c.connect(ctx)
	if err != nil {
		return err
	}
	defer connection.Close(websocket.StatusNormalClosure, "complete")
	id := c.id()
	if err := writeJSON(ctx, connection, map[string]any{"type": "req", "id": id, "method": method, "params": params}); err != nil {
		return err
	}
	for {
		var frame wireFrame
		if err := readJSON(ctx, connection, &frame); err != nil {
			return err
		}
		if frame.Type != "res" || frame.ID != id {
			continue
		}
		if !frame.OK {
			return frameError(frame)
		}
		if out == nil {
			return nil
		}
		if len(frame.Payload) == 0 {
			return errors.New("OpenClaw response missing payload")
		}
		if err := json.Unmarshal(frame.Payload, out); err != nil {
			return errors.New("invalid OpenClaw response")
		}
		return nil
	}
}

func (c *gatewayClient) Observe(ctx context.Context) (<-chan event, error) {
	connection, err := c.connect(ctx)
	if err != nil {
		return nil, err
	}
	result := make(chan event, 8)
	go func() {
		defer close(result)
		defer connection.CloseNow()
		for {
			var frame wireFrame
			if err := readJSON(ctx, connection, &frame); err != nil {
				return
			}
			if frame.Type != "event" || frame.Event == "" {
				continue
			}
			select {
			case result <- event{Name: frame.Event, Payload: frame.Payload}:
			case <-ctx.Done():
				return
			}
		}
	}()
	return result, nil
}

func readJSON(ctx context.Context, connection *websocket.Conn, value any) error {
	kind, data, err := connection.Read(ctx)
	if err != nil {
		return err
	}
	if kind != websocket.MessageText || json.Unmarshal(data, value) != nil {
		return errors.New("invalid OpenClaw frame")
	}
	return nil
}

func writeJSON(ctx context.Context, connection *websocket.Conn, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return connection.Write(ctx, websocket.MessageText, data)
}

func frameError(frame wireFrame) error {
	if frame.Error == nil {
		return errors.New("OpenClaw request failed")
	}
	if len(frame.Error.Details) > 0 && string(frame.Error.Details) != "null" {
		return fmt.Errorf("OpenClaw request failed (%s): %s: %s", frame.Error.Code, frame.Error.Message, frame.Error.Details)
	}
	return fmt.Errorf("OpenClaw request failed (%s): %s", frame.Error.Code, frame.Error.Message)
}
