package openclaw

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const protocolVersion = 4

type gatewayClient struct {
	url   string
	token string
	next  atomic.Uint64
}

type wireFrame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Event   string          `json:"event,omitempty"`
	OK      bool            `json:"ok,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Error   *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func newGatewayClient(rawURL, token string) (*gatewayClient, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.TrimSpace(token) == "" {
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
	return &gatewayClient{url: u.String(), token: strings.TrimSpace(token)}, nil
}

func (c *gatewayClient) id() string { return fmt.Sprintf("aos-%d", c.next.Add(1)) }

func (c *gatewayClient) connect(ctx context.Context) (*websocket.Conn, error) {
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
	var nonce struct {
		Nonce string `json:"nonce"`
	}
	if challenge.Type != "event" || challenge.Event != "connect.challenge" || json.Unmarshal(challenge.Payload, &nonce) != nil || nonce.Nonce == "" {
		return closeWithError(errors.New("invalid OpenClaw challenge"))
	}
	id := c.id()
	params := map[string]any{
		"minProtocol": protocolVersion, "maxProtocol": protocolVersion,
		"client": map[string]any{"id": "gateway-client", "displayName": "AOS Gateway", "version": "1", "platform": "go", "mode": "backend", "instanceId": id},
		"caps":   []string{"tool-events", "session-events"},
		"role":   "operator", "scopes": []string{"operator.read", "operator.write", "operator.questions"},
		"auth": map[string]any{"token": c.token},
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
	}
	if json.Unmarshal(responseFrame.Payload, &hello) != nil || hello.Type != "hello-ok" || hello.Protocol != protocolVersion {
		return closeWithError(errors.New("OpenClaw protocol mismatch"))
	}
	return connection, nil
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
	return fmt.Errorf("OpenClaw request failed (%s): %s", frame.Error.Code, frame.Error.Message)
}
