package hermes_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"aosui/gateway/conversation"
	"aosui/gateway/hermes"
	"github.com/coder/websocket"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type rpcCall struct {
	Method string
	Params map[string]any
}

type rpcFixture struct {
	t       *testing.T
	server  *httptest.Server
	mu      sync.Mutex
	calls   []rpcCall
	handler func(rpcCall) (any, bool)
}

func newRPCFixture(t *testing.T, handler func(rpcCall) (any, bool)) *rpcFixture {
	t.Helper()
	f := &rpcFixture{t: t, handler: handler}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != "secret" {
			t.Error("missing native WebSocket token")
		}
		if r.Header.Get("X-Hermes-Session-Token") != "" {
			t.Error("native WebSocket token leaked into a header")
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-gateway-v1"}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var request struct {
			ID     string         `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.Unmarshal(data, &request); err != nil {
			t.Errorf("invalid request: %v", err)
			return
		}
		call := rpcCall{Method: request.Method, Params: request.Params}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls = append(f.calls, call)
		result, reply := f.handler(call)
		if !reply {
			return
		}
		encoded, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
		_ = conn.Write(r.Context(), websocket.MessageText, encoded)
		if request.Method == "session.resume" {
			m, _ := result.(map[string]any)
			event, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"type": "message.complete", "session_id": m["session_id"], "payload": map[string]any{}}})
			_ = conn.Write(r.Context(), websocket.MessageText, event)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *rpcFixture) adapter(t *testing.T) *hermes.Adapter {
	t.Helper()
	a, err := hermes.New(hermes.Config{BaseURL: f.server.URL, Token: "secret", HTTPClient: f.server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func (f *rpcFixture) snapshot() []rpcCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]rpcCall(nil), f.calls...)
}

func inviteScope(ref string) conversation.Scope { return conversation.Scope{Agent: "writer", Ref: ref} }

func TestNewRejectsInvalidConfiguration(t *testing.T) {
	for _, cfg := range []hermes.Config{{}, {BaseURL: "://bad", Token: "token"}, {BaseURL: "http://hermes.test", Token: ""}} {
		if _, err := hermes.New(cfg); err == nil {
			t.Fatalf("New(%+v) succeeded", cfg)
		}
	}
}

func TestStateIsReadOnlyAndFollowsResolvedID(t *testing.T) {
	f := newRPCFixture(t, func(call rpcCall) (any, bool) {
		if call.Method != "session.list" {
			t.Fatalf("State performed %q", call.Method)
		}
		if call.Params["profile"] != "writer" || call.Params["title"] != "aos-invite:known" || call.Params["include_hidden"] != true {
			t.Fatalf("lookup params = %#v", call.Params)
		}
		return map[string]any{"sessions": []any{map[string]any{"id": "ancestor", "resolved_id": "tip", "profile": "writer"}}}, true
	})
	got, err := f.adapter(t).State(context.Background(), inviteScope("known"))
	if err != nil || got.Status != conversation.StatusExisting {
		t.Fatalf("State = %#v, %v", got, err)
	}
	if calls := f.snapshot(); len(calls) != 1 {
		t.Fatalf("calls = %#v", calls)
	}
}

func TestStateReportsNewWithoutCreating(t *testing.T) {
	f := newRPCFixture(t, func(rpcCall) (any, bool) { return map[string]any{"sessions": []any{}}, true })
	got, err := f.adapter(t).State(context.Background(), inviteScope("new"))
	if err != nil || got.Status != conversation.StatusNew {
		t.Fatalf("State = %#v, %v", got, err)
	}
	if calls := f.snapshot(); len(calls) != 1 || calls[0].Method != "session.list" {
		t.Fatalf("calls = %#v", calls)
	}
}

func TestStateRejectsRowsWithConflictingOwnerOrReturnedTitle(t *testing.T) {
	for _, test := range []struct {
		name string
		row  map[string]any
	}{
		{name: "different owner", row: map[string]any{"id": "stored", "profile": "other", "title": "aos-invite:secured"}},
		{name: "different title", row: map[string]any{"id": "stored", "profile": "writer", "title": "aos-invite:other"}},
		{name: "empty returned title", row: map[string]any{"id": "stored", "profile": "writer", "title": ""}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newRPCFixture(t, func(rpcCall) (any, bool) {
				return map[string]any{"sessions": []any{test.row}}, true
			})
			if _, err := f.adapter(t).State(context.Background(), inviteScope("secured")); !errors.Is(err, conversation.ErrForbidden) {
				t.Fatalf("State accepted row %#v: %v", test.row, err)
			}
		})
	}
}

func TestStateAcceptsProfileScopedNativeRowWithoutOwnerField(t *testing.T) {
	f := newRPCFixture(t, func(rpcCall) (any, bool) {
		return map[string]any{"sessions": []any{map[string]any{"id": "stored", "title": "aos-invite:secured"}}}, true
	})
	got, err := f.adapter(t).State(context.Background(), inviteScope("secured"))
	if err != nil || got.Status != conversation.StatusExisting {
		t.Fatalf("State = %#v, %v", got, err)
	}
}

func TestStateAcceptsExactOwnerWhenNativePayloadOmitsTitle(t *testing.T) {
	f := newRPCFixture(t, func(rpcCall) (any, bool) {
		return map[string]any{"sessions": []any{map[string]any{"id": "stored", "profile": "writer"}}}, true
	})
	got, err := f.adapter(t).State(context.Background(), inviteScope("legacy"))
	if err != nil || got.Status != conversation.StatusExisting {
		t.Fatalf("State = %#v, %v", got, err)
	}
}

func TestFirstSendSeedsPrivateInstructionBeforeTitleAndSubmitsVisibleText(t *testing.T) {
	exists := false
	f := newRPCFixture(t, func(call rpcCall) (any, bool) {
		switch call.Method {
		case "session.list":
			if !exists {
				return map[string]any{"sessions": []any{}}, true
			}
			return map[string]any{"sessions": []any{map[string]any{"id": "winner-root", "resolved_id": "winner-tip", "profile": "writer"}}}, true
		case "session.create":
			return map[string]any{"session_id": "loser-live", "stored_session_id": "loser-stored"}, true
		case "session.title":
			exists = true
			return map[string]any{}, true
		case "session.resume":
			if call.Params["session_id"] != "winner-tip" {
				t.Fatalf("resumed collision loser: %#v", call.Params)
			}
			return map[string]any{"session_id": "winner-live", "running": false}, true
		case "prompt.submit":
			return map[string]any{}, true
		default:
			t.Fatalf("unexpected method %q", call.Method)
			return nil, false
		}
	})
	input := conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "Hello guest"}}, FirstTurn: &conversation.FirstTurn{Instruction: "Load /interview for Dan."}}
	if err := f.adapter(t).Send(context.Background(), inviteScope("invite_123"), input); err != nil {
		t.Fatal(err)
	}
	calls := f.snapshot()
	want := []string{"session.list", "session.create", "session.title", "session.list", "session.resume", "prompt.submit"}
	if len(calls) < len(want) {
		t.Fatalf("calls = %#v", calls)
	}
	for i := range want {
		if calls[i].Method != want[i] {
			t.Fatalf("methods = %#v", calls)
		}
	}
	wantedMessages := []any{map[string]any{"role": "user", "content": "Load /interview for Dan."}}
	if got := calls[1].Params["messages"]; !jsonEqual(got, wantedMessages) {
		t.Fatalf("seed messages = %#v", got)
	}
	if got := calls[2].Params["title"]; got != "aos-invite:invite_123" {
		t.Fatalf("title = %#v", got)
	}
	if got := calls[5].Params["text"]; got != "Hello guest" {
		t.Fatalf("visible prompt = %#v", got)
	}
}

func jsonEqual(left, right any) bool {
	a, _ := json.Marshal(left)
	b, _ := json.Marshal(right)
	return string(a) == string(b)
}

func TestHistoryIsReadOnlyAndHidesSystemSeed(t *testing.T) {
	history := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/api/sessions/tip/messages" {
			return nil, errors.New("unexpected HTTP request: " + r.URL.String())
		}
		body := `{"messages":[{"_row_id":1,"role":"system","content":"private instruction"},{"_row_id":2,"role":"user","content":"question"},{"_row_id":3,"role":"assistant","content":"answer","reasoning":"secret","tool_calls":[{"id":"x"}]},{"role":"tool","content":"private"},{"role":"assistant","content":"hidden","display_kind":"hidden"}]}`
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	f := newRPCFixture(t, func(call rpcCall) (any, bool) {
		switch call.Method {
		case "session.list":
			return map[string]any{"sessions": []any{map[string]any{"id": "root", "resolved_id": "tip", "profile": "writer"}}}, true
		case "session.active_list":
			return map[string]any{"sessions": []any{}}, true
		default:
			t.Fatalf("History performed %q", call.Method)
			return nil, false
		}
	})
	client := &http.Client{Transport: routeTransport{rpc: f.server.Client().Transport, history: history}}
	a, err := hermes.New(hermes.Config{BaseURL: f.server.URL, Token: "secret", HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := a.History(context.Background(), inviteScope("history"))
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Messages) != 2 || snapshot.Messages[0].Content[0].Text != "question" || snapshot.Messages[1].Content[0].Text != "answer" {
		t.Fatalf("messages = %#v", snapshot.Messages)
	}
}

func TestHistoryProjectsOnlyValidatedCompletedPresentationTools(t *testing.T) {
	plan := map[string]any{"id": "release", "title": "Release", "steps": []any{map[string]any{"id": "test", "label": "Test", "status": "active"}}}
	locations := []any{map[string]any{"id": "hq", "label": "HQ", "latitude": 32.1, "longitude": 34.8}}
	toolCalls := []any{
		hermesToolCall("plan-1", "present_plan", plan),
		hermesToolCall("map-1", "render_map", map[string]any{"title": "Sites", "locations": locations}),
		hermesToolCall("chart-1", "render_chart", map[string]any{"title": "Traffic", "type": "bar", "xKey": "month", "series": []any{map[string]any{"key": "value", "label": "Visits"}}, "data": []any{map[string]any{"month": "Jan", "value": 12}}}),
		hermesToolCall("stats-1", "render_stats", map[string]any{"title": "Summary", "stats": []any{map[string]any{"key": "users", "label": "Users", "value": 12, "format": map[string]any{"kind": "number", "decimals": 0}}}}),
		hermesToolCall("bad-plan", "present_plan", map[string]any{"id": "bad", "title": "Bad", "steps": []any{map[string]any{"id": "x", "label": "X", "status": "secret"}}}),
		hermesToolCall("bad-map", "render_map", map[string]any{"title": "Bad", "locations": []any{map[string]any{"id": "x", "label": "X", "latitude": 200, "longitude": 0}}}),
		hermesToolCall("bad-chart", "render_chart", map[string]any{"title": "Bad", "xKey": "month", "series": []any{map[string]any{"key": "value", "label": "Visits"}}, "data": []any{map[string]any{"month": "Jan", "value": "secret"}}}),
		hermesToolCall("bad-stats", "render_stats", map[string]any{"stats": []any{map[string]any{"key": "x", "label": "X", "value": map[string]any{"secret": true}}}}),
		hermesToolCall("pending", "present_plan", plan),
		hermesToolCall("failed", "present_plan", plan),
		hermesToolCall("question-internal", "question", map[string]any{"question": "Leak controls?"}),
		hermesToolCall("shell", "bash", map[string]any{"command": "cat secret"}),
		hermesToolCall("subagent", "delegate_task", map[string]any{"prompt": "private subagent work"}),
		hermesToolCall("artifact", "tool_call", map[string]any{"name": "present_artifact", "arguments": map[string]any{"path": "report.pdf"}}),
	}
	rows := []any{
		map[string]any{"id": "a1", "role": "assistant", "content": "Working", "reasoning": "private chain", "tool_calls": toolCalls},
		map[string]any{"role": "tool", "tool_call_id": "plan-1", "content": `{"ok":true,"secret":"discarded result"}`},
		map[string]any{"role": "tool", "tool_call_id": "map-1", "content": `{"ok":true}`},
		map[string]any{"role": "tool", "tool_call_id": "chart-1", "content": `{"ok":true}`},
		map[string]any{"role": "tool", "tool_call_id": "stats-1", "content": `{"ok":true}`},
		map[string]any{"role": "tool", "tool_call_id": "bad-plan", "content": `{"ok":true}`},
		map[string]any{"role": "tool", "tool_call_id": "bad-map", "content": `{"ok":true}`},
		map[string]any{"role": "tool", "tool_call_id": "bad-chart", "content": `{"ok":true}`},
		map[string]any{"role": "tool", "tool_call_id": "bad-stats", "content": `{"ok":true}`},
		map[string]any{"role": "tool", "tool_call_id": "failed", "content": `{"ok":false,"error":"private failure"}`, "is_error": true},
		map[string]any{"role": "tool", "tool_call_id": "question-internal", "content": `{"ok":true}`},
		map[string]any{"role": "tool", "tool_call_id": "shell", "content": `{"stdout":"secret"}`},
		map[string]any{"role": "tool", "tool_call_id": "subagent", "content": `{"result":"private subagent output"}`},
		map[string]any{"role": "tool", "tool_call_id": "artifact", "tool_name": "present_artifact", "content": `{"ok":true,"type":"aos.artifact","artifact":{"id":"artifact-1","path":"report.pdf","filename":"Report.pdf","mimeType":"application/pdf","sizeBytes":42}}`},
	}
	encodedRows, _ := json.Marshal(map[string]any{"messages": rows})
	history := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(encodedRows)))}, nil
	})
	f := newRPCFixture(t, func(call rpcCall) (any, bool) {
		switch call.Method {
		case "session.list":
			return map[string]any{"sessions": []any{map[string]any{"id": "stored", "profile": "writer"}}}, true
		case "session.active_list":
			return map[string]any{"sessions": []any{}}, true
		default:
			t.Fatalf("unexpected method %q", call.Method)
			return nil, false
		}
	})
	client := &http.Client{Transport: routeTransport{rpc: f.server.Client().Transport, history: history}}
	a, err := hermes.New(hermes.Config{BaseURL: f.server.URL, Token: "secret", HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	got, err := a.History(context.Background(), inviteScope("display"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Messages) != 1 || len(got.Messages[0].Content) != 6 || got.Messages[0].Content[0].Text != "Working" {
		t.Fatalf("projection = %#v", got.Messages)
	}
	wantKinds := []string{"plan", "map", "chart", "stats"}
	for index, kind := range wantKinds {
		part := got.Messages[0].Content[index+1]
		if part.Type != "display" || part.Display == nil || part.Display.Kind != kind {
			t.Fatalf("display %d = %#v", index, part)
		}
	}
	artifact := got.Messages[0].Content[5].Artifact
	if artifact == nil || artifact.ID != "artifact-1" || artifact.Filename != "Report.pdf" || artifact.Source.Reference != "report.pdf" {
		t.Fatalf("artifact = %#v", artifact)
	}
	serialized, _ := json.Marshal(got.Messages)
	for _, forbidden := range []string{"private chain", "discarded result", "bad-plan", "bad-map", "bad-chart", "bad-stats", "pending", "failed", "question-internal", "shell", "command", "secret", "subagent"} {
		if strings.Contains(string(serialized), forbidden) {
			t.Fatalf("%q leaked in projection: %s", forbidden, serialized)
		}
	}
}

func hermesToolCall(id, name string, args map[string]any) map[string]any {
	encoded, _ := json.Marshal(args)
	return map[string]any{"id": id, "function": map[string]any{"name": name, "arguments": string(encoded)}}
}

type routeTransport struct{ rpc, history http.RoundTripper }

func (r routeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if strings.HasPrefix(req.URL.Path, "/api/sessions/") || strings.HasPrefix(req.URL.Path, "/api/fs/") {
		return r.history.RoundTrip(req)
	}
	return r.rpc.RoundTrip(req)
}

func TestReadArtifactUsesTheResolvedSessionAndNativeReference(t *testing.T) {
	f := newRPCFixture(t, func(call rpcCall) (any, bool) {
		if call.Method == "session.list" {
			return map[string]any{"sessions": []any{map[string]any{"id": "stored", "profile": "writer"}}}, true
		}
		t.Fatalf("unexpected method %q", call.Method)
		return nil, false
	})
	native := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/api/fs/read-data-url" || r.URL.Query().Get("path") != "private/report.pdf" || r.URL.Query().Get("profile") != "writer" || r.URL.Query().Get("session_id") != "stored" {
			t.Fatalf("artifact request = %s", r.URL.String())
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"dataUrl":"data:application/pdf;base64,cGRm"}`))}, nil
	})
	client := &http.Client{Transport: routeTransport{rpc: f.server.Client().Transport, history: native}}
	adapter, err := hermes.New(hermes.Config{BaseURL: f.server.URL, Token: "secret", HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}

	content, err := adapter.ReadArtifact(context.Background(), inviteScope("artifact"), "private/report.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if string(content.Data) != "pdf" || content.MimeType != "application/pdf" {
		t.Fatalf("content = %#v", content)
	}
}

func TestReconnectDoesNotReinjectFirstTurn(t *testing.T) {
	exists := false
	f := newRPCFixture(t, func(call rpcCall) (any, bool) {
		switch call.Method {
		case "session.list":
			if exists {
				return map[string]any{"sessions": []any{map[string]any{"id": "stored", "resolved_id": "stored", "profile": "writer"}}}, true
			}
			return map[string]any{"sessions": []any{}}, true
		case "session.create":
			return map[string]any{"session_id": "created-live", "stored_session_id": "stored"}, true
		case "session.title":
			exists = true
			return map[string]any{}, true
		case "session.resume":
			return map[string]any{"session_id": "resumed-live", "running": false}, true
		case "prompt.submit":
			return map[string]any{}, true
		default:
			return map[string]any{}, true
		}
	})
	input := conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "one"}}, FirstTurn: &conversation.FirstTurn{Instruction: "private"}}
	if err := f.adapter(t).Send(context.Background(), inviteScope("restart"), input); err != nil {
		t.Fatal(err)
	}
	input.Content[0].Text = "two"
	if err := f.adapter(t).Send(context.Background(), inviteScope("restart"), input); err != nil {
		t.Fatal(err)
	}
	var creates int
	var createMessages any
	var prompts []string
	for _, call := range f.snapshot() {
		switch call.Method {
		case "session.create":
			creates++
			createMessages = call.Params["messages"]
		case "prompt.submit":
			prompts = append(prompts, call.Params["text"].(string))
		}
	}
	if creates != 1 || !jsonEqual(createMessages, []any{map[string]any{"role": "user", "content": "private"}}) || len(prompts) != 2 || prompts[0] != "one" || prompts[1] != "two" {
		t.Fatalf("creates=%d seeds=%#v prompts=%#v", creates, createMessages, prompts)
	}
}

func TestConcurrentSendsCreateOneNativeConversation(t *testing.T) {
	exists := false
	f := newRPCFixture(t, func(call rpcCall) (any, bool) {
		switch call.Method {
		case "session.list":
			if exists {
				return map[string]any{"sessions": []any{map[string]any{"id": "stored", "resolved_id": "stored", "profile": "writer"}}}, true
			}
			return map[string]any{"sessions": []any{}}, true
		case "session.create":
			return map[string]any{"session_id": "live", "stored_session_id": "stored"}, true
		case "session.title":
			exists = true
			return map[string]any{}, true
		case "session.resume":
			return map[string]any{"session_id": "live", "running": false}, true
		default:
			return map[string]any{}, true
		}
	})
	a := f.adapter(t)
	start := make(chan struct{})
	errs := make(chan error, 2)
	for _, text := range []string{"one", "two"} {
		text := text
		go func() {
			<-start
			errs <- a.Send(context.Background(), inviteScope("concurrent"), conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: text}}})
		}()
	}
	close(start)
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	creates := 0
	for _, call := range f.snapshot() {
		if call.Method == "session.create" {
			creates++
		}
	}
	if creates != 1 {
		t.Fatalf("session.create calls = %d", creates)
	}
}

func TestUncertainSendIsNotBlindlyRetried(t *testing.T) {
	f := newRPCFixture(t, func(call rpcCall) (any, bool) {
		switch call.Method {
		case "session.list":
			return map[string]any{"sessions": []any{map[string]any{"id": "stored", "resolved_id": "stored", "profile": "writer"}}}, true
		case "session.resume":
			return map[string]any{"session_id": "live", "running": false}, true
		case "prompt.submit":
			return nil, false
		default:
			return map[string]any{}, true
		}
	})
	a := f.adapter(t)
	input := conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "hello"}}}
	if err := a.Send(context.Background(), inviteScope("uncertain"), input); !errors.Is(err, conversation.ErrUncertain) {
		t.Fatalf("first Send = %v", err)
	}
	if err := a.Send(context.Background(), inviteScope("uncertain"), input); !errors.Is(err, conversation.ErrUncertain) {
		t.Fatalf("second Send = %v", err)
	}
	prompts := 0
	for _, call := range f.snapshot() {
		if call.Method == "prompt.submit" {
			prompts++
		}
	}
	if prompts != 1 {
		t.Fatalf("prompt.submit calls = %d", prompts)
	}
}

func TestSuccessfulHistoryClearsUncertainSendWithoutReplayingIt(t *testing.T) {
	firstPrompt := true
	f := newRPCFixture(t, func(call rpcCall) (any, bool) {
		switch call.Method {
		case "session.list":
			return map[string]any{"sessions": []any{map[string]any{"id": "stored", "resolved_id": "stored", "profile": "writer"}}}, true
		case "session.resume":
			return map[string]any{"session_id": "live", "running": false}, true
		case "prompt.submit":
			if firstPrompt {
				firstPrompt = false
				return nil, false
			}
			return map[string]any{}, true
		case "session.active_list":
			return map[string]any{"sessions": []any{}}, true
		default:
			t.Fatalf("unexpected method %q", call.Method)
			return nil, false
		}
	})
	history := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/api/sessions/stored/messages" {
			return nil, errors.New("unexpected HTTP request: " + r.URL.String())
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"messages":[{"role":"user","content":"possibly accepted"}]}`))}, nil
	})
	client := &http.Client{Transport: routeTransport{rpc: f.server.Client().Transport, history: history}}
	a, err := hermes.New(hermes.Config{BaseURL: f.server.URL, Token: "secret", HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	scope := inviteScope("recover")
	first := conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "possibly accepted"}}}
	if err := a.Send(context.Background(), scope, first); !errors.Is(err, conversation.ErrUncertain) {
		t.Fatalf("first Send = %v", err)
	}
	if _, err := a.History(context.Background(), scope); err != nil {
		t.Fatalf("History = %v", err)
	}
	second := conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "distinct follow-up"}}}
	if err := a.Send(context.Background(), scope, second); err != nil {
		t.Fatalf("second Send = %v", err)
	}
	var prompts []string
	for _, call := range f.snapshot() {
		if call.Method == "prompt.submit" {
			prompts = append(prompts, call.Params["text"].(string))
		}
	}
	if len(prompts) != 2 || prompts[0] != "possibly accepted" || prompts[1] != "distinct follow-up" {
		t.Fatalf("prompt submissions = %#v", prompts)
	}
}

func TestHistoryReconcilesWhitespaceNormalizedPersistedReplyWithStreamBuffer(t *testing.T) {
	complete := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/sessions/") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"messages":[{"role":"assistant","content":"Hello"}]}`)
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-gateway-v1"}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var request struct {
			ID     string `json:"id"`
			Method string `json:"method"`
		}
		if json.Unmarshal(data, &request) != nil {
			return
		}
		result := any(map[string]any{})
		switch request.Method {
		case "session.list":
			result = map[string]any{"sessions": []any{map[string]any{"id": "stored", "profile": "writer"}}}
		case "session.resume":
			result = map[string]any{"session_id": "live", "running": false}
		case "session.active_list":
			result = map[string]any{"sessions": []any{}}
		}
		response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
		if conn.Write(r.Context(), websocket.MessageText, response) != nil || request.Method != "session.resume" {
			return
		}
		delta, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"type": "message.delta", "session_id": "live", "payload": map[string]any{"text": "\n\nHello"}}})
		if conn.Write(r.Context(), websocket.MessageText, delta) != nil {
			return
		}
		<-complete
		done, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"type": "message.complete", "session_id": "live", "payload": map[string]any{}}})
		if conn.Write(r.Context(), websocket.MessageText, done) != nil {
			return
		}
		<-r.Context().Done()
	}))
	defer server.Close()
	a, err := hermes.New(hermes.Config{BaseURL: server.URL, Token: "secret", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observations, err := a.Observe(ctx, inviteScope("normalized"))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-observations:
	case <-time.After(time.Second):
		t.Fatal("stream delta was not observed")
	}
	close(complete)
	select {
	case <-observations:
	case <-time.After(time.Second):
		t.Fatal("stream completion was not observed")
	}
	snapshot, err := a.History(context.Background(), inviteScope("normalized"))
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Messages) != 1 || snapshot.Messages[0].Content[0].Text != "Hello" {
		t.Fatalf("messages = %#v", snapshot.Messages)
	}
}

func TestObserveSharesOneWatcherAndFiltersUnrelatedSessionEvents(t *testing.T) {
	var resumes atomic.Int32
	attached := make(chan struct{})
	sendUnrelated := make(chan struct{})
	unrelatedSent := make(chan struct{})
	sendRelevant := make(chan struct{})
	var attachedOnce sync.Once
	var unrelatedOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-gateway-v1"}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var request struct {
			ID     string         `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if json.Unmarshal(data, &request) != nil {
			return
		}
		var result any
		switch request.Method {
		case "session.list":
			result = map[string]any{"sessions": []any{map[string]any{"id": "stored", "profile": "writer"}}}
		case "session.resume":
			resumes.Add(1)
			result = map[string]any{"session_id": "watched-live", "running": false}
		default:
			result = map[string]any{}
		}
		response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
		if conn.Write(r.Context(), websocket.MessageText, response) != nil || request.Method != "session.resume" {
			return
		}
		attachedOnce.Do(func() { close(attached) })
		<-sendUnrelated
		unrelated, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"type": "message.complete", "session_id": "different-live", "payload": map[string]any{}}})
		_ = conn.Write(r.Context(), websocket.MessageText, unrelated)
		unrelatedOnce.Do(func() { close(unrelatedSent) })
		<-sendRelevant
		relevant, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"type": "message.complete", "session_id": "watched-live", "payload": map[string]any{}}})
		_ = conn.Write(r.Context(), websocket.MessageText, relevant)
	}))
	defer server.Close()
	a, err := hermes.New(hermes.Config{BaseURL: server.URL, Token: "secret", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	first, err := a.Observe(firstCtx, inviteScope("observed"))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-attached:
	case <-time.After(time.Second):
		t.Fatal("native watcher did not attach")
	}
	secondCtx, cancelSecond := context.WithCancel(context.Background())
	defer cancelSecond()
	second, err := a.Observe(secondCtx, inviteScope("observed"))
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("observers unexpectedly share a consumer channel")
	}
	cancelFirst()
	time.Sleep(50 * time.Millisecond)
	if got := resumes.Load(); got != 1 {
		t.Fatalf("native session.resume calls = %d", got)
	}
	close(sendUnrelated)
	select {
	case <-unrelatedSent:
	case <-time.After(time.Second):
		t.Fatal("unrelated event was not sent")
	}
	select {
	case observation := <-second:
		t.Fatalf("unrelated session notified observer: %#v", observation)
	case <-time.After(75 * time.Millisecond):
	}
	close(sendRelevant)
	select {
	case observation := <-second:
		if observation.Err != nil {
			t.Fatalf("observation error = %v", observation.Err)
		}
	case <-time.After(time.Second):
		t.Fatal("relevant event did not notify observer")
	}
}

func TestObserveReportsTerminalResumeFailure(t *testing.T) {
	for _, test := range []struct {
		name     string
		response func(string) map[string]any
	}{
		{name: "rpc error", response: func(id string) map[string]any {
			return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32000, "message": "cannot resume"}}
		}},
		{name: "malformed result", response: func(id string) map[string]any {
			return map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"running": false}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-gateway-v1"}})
				if err != nil {
					return
				}
				defer conn.CloseNow()
				_, data, err := conn.Read(r.Context())
				if err != nil {
					return
				}
				var request struct {
					ID     string `json:"id"`
					Method string `json:"method"`
				}
				if json.Unmarshal(data, &request) != nil {
					return
				}
				var response map[string]any
				if request.Method == "session.list" {
					response = map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"sessions": []any{map[string]any{"id": "stored", "profile": "writer"}}}}
				} else {
					response = test.response(request.ID)
				}
				encoded, _ := json.Marshal(response)
				_ = conn.Write(r.Context(), websocket.MessageText, encoded)
			}))
			defer server.Close()
			a, err := hermes.New(hermes.Config{BaseURL: server.URL, Token: "secret", HTTPClient: server.Client()})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			observations, err := a.Observe(ctx, inviteScope("resume-failure"))
			if err != nil {
				t.Fatal(err)
			}
			select {
			case observation := <-observations:
				if !errors.Is(observation.Err, conversation.ErrUnavailable) {
					t.Fatalf("observation error = %v", observation.Err)
				}
			case <-time.After(time.Second):
				t.Fatal("terminal resume failure did not notify observer")
			}
		})
	}
}

func TestObserveTerminalFailureReplacesBufferedChange(t *testing.T) {
	terminalWritten := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-gateway-v1"}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var request struct {
			ID     string `json:"id"`
			Method string `json:"method"`
		}
		if json.Unmarshal(data, &request) != nil {
			return
		}
		if request.Method == "session.list" {
			response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"sessions": []any{map[string]any{"id": "stored", "profile": "writer"}}}})
			_ = conn.Write(r.Context(), websocket.MessageText, response)
			return
		}
		response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"session_id": "live", "running": true}})
		_ = conn.Write(r.Context(), websocket.MessageText, response)
		event, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"type": "message.delta", "session_id": "live", "payload": map[string]any{"text": "partial"}}})
		_ = conn.Write(r.Context(), websocket.MessageText, event)
		malformed, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"running": false}})
		_ = conn.Write(r.Context(), websocket.MessageText, malformed)
		close(terminalWritten)
	}))
	defer server.Close()
	a, err := hermes.New(hermes.Config{BaseURL: server.URL, Token: "secret", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observations, err := a.Observe(ctx, inviteScope("buffered-failure"))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-terminalWritten:
	case <-time.After(2 * time.Second):
		t.Fatal("terminal watcher response was not written")
	}
	time.Sleep(50 * time.Millisecond)
	select {
	case observation := <-observations:
		if !errors.Is(observation.Err, conversation.ErrUnavailable) {
			t.Fatalf("buffered observation was not replaced: %#v", observation)
		}
	case <-time.After(time.Second):
		t.Fatal("terminal failure did not reach observer")
	}
}

func TestObserveReportsWatcherTransportLoss(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-gateway-v1"}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var request struct {
			ID     string `json:"id"`
			Method string `json:"method"`
		}
		if json.Unmarshal(data, &request) != nil {
			return
		}
		if request.Method == "session.list" {
			response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"sessions": []any{map[string]any{"id": "stored", "profile": "writer"}}}})
			_ = conn.Write(r.Context(), websocket.MessageText, response)
		}
		// The watcher connection closes before session.resume can answer.
	}))
	defer server.Close()
	a, err := hermes.New(hermes.Config{BaseURL: server.URL, Token: "secret", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observations, err := a.Observe(ctx, inviteScope("transport-loss"))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case observation := <-observations:
		if !errors.Is(observation.Err, conversation.ErrUnavailable) {
			t.Fatalf("observation error = %v", observation.Err)
		}
	case <-time.After(time.Second):
		t.Fatal("watcher transport loss did not notify observer")
	}
}

func TestObservePublishesRunningStateLearnedDuringResume(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-gateway-v1"}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var request struct {
			ID     string `json:"id"`
			Method string `json:"method"`
		}
		if json.Unmarshal(data, &request) != nil {
			return
		}
		var result map[string]any
		if request.Method == "session.list" {
			result = map[string]any{"sessions": []any{map[string]any{"id": "stored", "profile": "writer"}}}
		} else {
			result = map[string]any{"session_id": "live", "running": true}
		}
		response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
		if conn.Write(r.Context(), websocket.MessageText, response) != nil || request.Method != "session.resume" {
			return
		}
		<-r.Context().Done()
	}))
	defer server.Close()
	a, err := hermes.New(hermes.Config{BaseURL: server.URL, Token: "secret", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observations, err := a.Observe(ctx, inviteScope("running-resume"))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case observation := <-observations:
		if observation.Err != nil {
			t.Fatalf("observation error = %v", observation.Err)
		}
	case <-time.After(time.Second):
		t.Fatal("running resume state did not notify observer")
	}
}

func TestStopResolvesScopeWithoutCreating(t *testing.T) {
	f := newRPCFixture(t, func(call rpcCall) (any, bool) {
		switch call.Method {
		case "session.list":
			return map[string]any{"sessions": []any{map[string]any{"id": "root", "resolved_id": "tip", "profile": "writer"}}}, true
		case "session.resume":
			if call.Params["session_id"] != "tip" {
				t.Fatalf("resume params = %#v", call.Params)
			}
			return map[string]any{"session_id": "live", "running": true}, true
		case "session.interrupt":
			return map[string]any{}, true
		default:
			t.Fatalf("unexpected method %q", call.Method)
			return nil, false
		}
	})
	if err := f.adapter(t).Stop(context.Background(), inviteScope("stop")); err != nil {
		t.Fatal(err)
	}
	calls := f.snapshot()
	if len(calls) != 3 || calls[2].Method != "session.interrupt" || calls[2].Params["session_id"] != "live" {
		t.Fatalf("calls = %#v", calls)
	}
}

func TestAudioUsesNativeTokenAndProfile(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if got := r.Header.Get("X-Hermes-Session-Token"); got != "secret" {
			t.Fatalf("token = %q", got)
		}
		if got := r.URL.Query().Get("profile"); got != "writer" {
			t.Fatalf("profile = %q", got)
		}
		if r.URL.Path != "/api/audio/transcribe" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"ok":true,"transcript":"hello"}`))}, nil
	})}
	adapter, err := hermes.New(hermes.Config{BaseURL: "http://hermes.test/", Token: "secret", HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	got, err := adapter.Transcribe(context.Background(), inviteScope("voice"), []byte("wav"), "audio/wav")
	if err != nil {
		t.Fatal(err)
	}
	if got != "hello" {
		t.Fatalf("transcript = %q", got)
	}
}

func TestCapabilitiesReflectNativeRegularRuntimeSurface(t *testing.T) {
	adapter, err := hermes.New(hermes.Config{BaseURL: "http://hermes.test", Token: "secret", HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body := `{"name":"stt","has_category":true,"providers":[]}`
		if strings.Contains(r.URL.Path, "/tts/") {
			body = `{"name":"tts","has_category":true,"active_provider":"edge","providers":[{"name":"edge","is_active":true,"status":"ready","tts_provider":"edge"}]}`
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := adapter.Capabilities(context.Background(), inviteScope("capabilities"))
	if err != nil {
		t.Fatal(err)
	}
	// Match the regular Hermes UI: picker metadata is only a hint. With no
	// selected STT provider, native auto-selection may still transcribe.
	if got.Attachments || got.Edit || got.Regenerate || got.Branches || got.Questions || !got.Transcription || !got.Speech {
		t.Fatalf("capabilities = %+v", got)
	}
	if _, ok := any(adapter).(conversation.Editor); ok {
		t.Fatal("Hermes exposed edit/regenerate without native support")
	}
	if _, ok := any(adapter).(conversation.QuestionResponder); ok {
		t.Fatal("Hermes exposed interactive questions without a native answer API")
	}
}

func TestCapabilitiesKeepUnverifiedActiveHermesAudioAvailable(t *testing.T) {
	adapter, err := hermes.New(hermes.Config{BaseURL: "http://hermes.test", Token: "secret", HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		name := "stt"
		if strings.Contains(r.URL.Path, "/tts/") {
			name = "tts"
		}
		body := fmt.Sprintf(`{"name":%q,"has_category":true,"active_provider":"OpenAI","providers":[{"name":"OpenAI","is_active":true,"status":"needs_keys"}]}`, name)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := adapter.Capabilities(context.Background(), inviteScope("unverified-audio"))
	if err != nil {
		t.Fatal(err)
	}
	if !got.Transcription || !got.Speech {
		t.Fatalf("capabilities = %+v", got)
	}
}

func TestInvalidScopeIsRejectedBeforeNativeIO(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid scope reached native transport")
		return nil, nil
	})}
	a, _ := hermes.New(hermes.Config{BaseURL: "http://hermes.test", Token: "secret", HTTPClient: client})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for _, scope := range []conversation.Scope{{Agent: "writer"}, {Agent: "", Ref: "ref"}, {Agent: "writer", Ref: "not allowed"}} {
		if _, err := a.State(ctx, scope); !errors.Is(err, conversation.ErrForbidden) {
			t.Fatalf("State(%#v) = %v", scope, err)
		}
	}
}
