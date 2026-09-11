package openclaw

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"aosui/gateway/conversation"
)

type request struct {
	method string
	params any
}

type fakeRPC struct {
	requests  []request
	responses map[string]any
	errors    map[string]error
	events    chan event
}

func (f *fakeRPC) Request(_ context.Context, method string, params any, out any) error {
	f.requests = append(f.requests, request{method: method, params: params})
	if err := f.errors[method]; err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	b, _ := json.Marshal(f.responses[method])
	return json.Unmarshal(b, out)
}

func (f *fakeRPC) Observe(context.Context) (<-chan event, error) { return f.events, nil }

func newFake() (*Adapter, *fakeRPC) {
	f := &fakeRPC{responses: map[string]any{}, errors: map[string]error{}, events: make(chan event, 2)}
	f.responses["agents.list"] = map[string]any{"agents": []any{map[string]any{"id": "interviewer"}}}
	return newWithRPC(f), f
}

func scope() conversation.Scope { return conversation.Scope{Agent: "interviewer", Ref: "guest_1"} }

func TestStateUsesOwnedDeterministicSession(t *testing.T) {
	a, rpc := newFake()
	rpc.responses["sessions.list"] = map[string]any{"sessions": []any{map[string]any{
		"key": "agent:interviewer:aos-invite:guest_1", "agentId": "interviewer",
	}}}
	got, err := a.State(context.Background(), scope())
	if err != nil || got.Status != conversation.StatusExisting {
		t.Fatalf("state = %#v, %v", got, err)
	}

	rpc.responses["sessions.list"] = map[string]any{"sessions": []any{map[string]any{
		"key": "agent:interviewer:aos-invite:guest_1", "agentId": "someone-else",
	}}}
	if _, err := a.State(context.Background(), scope()); !errors.Is(err, conversation.ErrForbidden) {
		t.Fatalf("wrong owner error = %v", err)
	}
}

func TestCapabilitiesAreConservativeAndScopeChecked(t *testing.T) {
	a, rpc := newFake()
	rpc.responses["sessions.list"] = map[string]any{"sessions": []any{}}
	got, err := a.Capabilities(context.Background(), scope())
	if err != nil {
		t.Fatal(err)
	}
	want := conversation.Capabilities{Attachments: true, Questions: true, Speech: true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("capabilities = %#v", got)
	}
	if _, err := a.Capabilities(context.Background(), conversation.Scope{Agent: "x", Ref: "bad/ref"}); !errors.Is(err, conversation.ErrForbidden) {
		t.Fatalf("invalid scope = %v", err)
	}
	rpc.responses["agents.list"] = map[string]any{"agents": []any{map[string]any{"id": "someone-else"}}}
	if _, err := a.Capabilities(context.Background(), scope()); !errors.Is(err, conversation.ErrForbidden) {
		t.Fatalf("unknown Agent = %v", err)
	}
}

func TestFirstSendCreatesSessionAtomicallyWithoutReinjectingInstruction(t *testing.T) {
	a, rpc := newFake()
	rpc.responses["sessions.list"] = map[string]any{"sessions": []any{}}
	rpc.responses["sessions.create"] = map[string]any{"ok": true, "key": "agent:interviewer:aos-invite:guest_1"}
	input := conversation.SendInput{
		Content:   []conversation.Part{{Type: "text", Text: "Hello"}},
		FirstTurn: &conversation.FirstTurn{Instruction: "Load /interview for guest."},
	}
	if err := a.Send(context.Background(), scope(), input); err != nil {
		t.Fatal(err)
	}
	if rpc.requests[len(rpc.requests)-1].method != "sessions.create" {
		t.Fatalf("requests = %#v", rpc.requests)
	}
	params := rpc.requests[len(rpc.requests)-1].params.(map[string]any)
	if params["task"] != "Load /interview for guest." || params["message"] != "Hello" || params["agentId"] != "interviewer" {
		t.Fatalf("create params = %#v", params)
	}

	rpc.responses["sessions.list"] = map[string]any{"sessions": []any{map[string]any{"key": sessionKey(scope()), "agentId": "interviewer"}}}
	rpc.responses["chat.send"] = map[string]any{"runId": "run-2"}
	if err := a.Send(context.Background(), scope(), input); err != nil {
		t.Fatal(err)
	}
	last := rpc.requests[len(rpc.requests)-1]
	if last.method != "chat.send" {
		t.Fatalf("second send method = %s", last.method)
	}
	if _, exists := last.params.(map[string]any)["task"]; exists {
		t.Fatalf("first-turn instruction reinjected: %#v", last.params)
	}
}

func TestHistoryProjectsTextRunQuestionsAndArtifacts(t *testing.T) {
	a, rpc := newFake()
	rpc.responses["sessions.list"] = map[string]any{"sessions": []any{map[string]any{"key": sessionKey(scope()), "agentId": "interviewer"}}}
	rpc.responses["chat.history"] = map[string]any{
		"messages": []any{
			map[string]any{"id": "u1", "role": "user", "content": "Hello"},
			map[string]any{"id": "a1", "role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Hi"}, map[string]any{"type": "artifact", "artifact": map[string]any{"id": "art-1", "title": "report.pdf", "mimeType": "application/pdf", "sizeBytes": 12}}}},
		},
		"sessionInfo": map[string]any{"hasActiveRun": true, "activeRunIds": []string{"run-1"}},
	}
	rpc.responses["question.list"] = map[string]any{"questions": []any{map[string]any{
		"id": "q1", "agentId": "interviewer", "sessionKey": sessionKey(scope()), "status": "pending", "expiresAtMs": time.Now().Add(time.Hour).UnixMilli(),
		"questions": []any{map[string]any{"questionId": "color", "header": "Color", "question": "Choose", "options": []any{map[string]any{"label": "Blue"}}}},
	}}}
	got, err := a.History(context.Background(), scope())
	if err != nil {
		t.Fatal(err)
	}
	if !got.Running || len(got.Messages) != 2 || got.Messages[1].Content[1].Artifact.Source.Reference != "art-1" || len(got.PendingQuestions) != 1 {
		t.Fatalf("snapshot = %#v", got)
	}
	for _, call := range rpc.requests {
		if call.method == "question.list" && !reflect.DeepEqual(call.params, map[string]any{}) {
			t.Fatalf("question.list params violate native schema: %#v", call.params)
		}
	}
}

func TestQuestionsStopAttachmentsArtifactAndSpeechUseScopedRPCs(t *testing.T) {
	a, rpc := newFake()
	rpc.responses["sessions.list"] = map[string]any{"sessions": []any{map[string]any{"key": sessionKey(scope()), "agentId": "interviewer"}}}
	rpc.responses["chat.history"] = map[string]any{"messages": []any{}, "inFlightRun": map[string]any{"runId": "run-7"}}
	rpc.responses["artifacts.download"] = map[string]any{"artifact": map[string]any{"id": "art-1", "title": "a.txt", "mimeType": "text/plain", "sessionKey": sessionKey(scope()), "download": map[string]any{"mode": "bytes"}}, "encoding": "base64", "data": base64.StdEncoding.EncodeToString([]byte("artifact"))}
	rpc.responses["tts.speak"] = map[string]any{"audioBase64": base64.StdEncoding.EncodeToString([]byte("audio")), "mimeType": "audio/mpeg", "provider": "native"}
	rpc.responses["question.list"] = map[string]any{"questions": []any{map[string]any{
		"id": "q1", "agentId": "interviewer", "sessionKey": sessionKey(scope()), "status": "pending", "expiresAtMs": time.Now().Add(time.Hour).UnixMilli(),
		"questions": []any{map[string]any{"questionId": "color", "header": "Color", "question": "Choose", "options": []any{}}},
	}}}

	if err := a.Stop(context.Background(), scope()); err != nil {
		t.Fatal(err)
	}
	if err := a.ReplyQuestion(context.Background(), scope(), "q1", [][]string{{"Blue"}}); err != nil {
		t.Fatal(err)
	}
	content, err := a.ReadArtifact(context.Background(), scope(), "art-1")
	if err != nil || string(content.Data) != "artifact" {
		t.Fatalf("artifact = %#v, %v", content, err)
	}
	artifactRequest := rpc.requests[len(rpc.requests)-1]
	artifactParams := artifactRequest.params.(map[string]any)
	if artifactRequest.method != "artifacts.download" || artifactParams["artifactId"] != "art-1" || artifactParams["sessionKey"] != sessionKey(scope()) || artifactParams["agentId"] != scope().Agent {
		t.Fatalf("artifact request = %#v", artifactRequest)
	}
	audio, mime, err := a.Speech(context.Background(), scope(), "hello")
	if err != nil || string(audio) != "audio" || mime != "audio/mpeg" {
		t.Fatalf("speech = %q %q %v", audio, mime, err)
	}
	if _, err := a.Transcribe(context.Background(), scope(), []byte("x"), "audio/webm"); !errors.Is(err, conversation.ErrUnsupported) {
		t.Fatalf("transcribe = %v", err)
	}
}

func TestArtifactAndSpeechFailClosedWithoutExactSessionOwnership(t *testing.T) {
	a, rpc := newFake()
	rpc.responses["sessions.list"] = map[string]any{"sessions": []any{map[string]any{"key": sessionKey(scope()), "agentId": "interviewer"}}}
	rpc.responses["artifacts.download"] = map[string]any{"artifact": map[string]any{"id": "art-1", "title": "a.txt"}, "encoding": "base64", "data": base64.StdEncoding.EncodeToString([]byte("wrong session"))}
	if _, err := a.ReadArtifact(context.Background(), scope(), "art-1"); !errors.Is(err, conversation.ErrForbidden) {
		t.Fatalf("unscoped artifact = %v", err)
	}
	rpc.responses["sessions.list"] = map[string]any{"sessions": []any{}}
	if _, _, err := a.Speech(context.Background(), scope(), "hello"); !errors.Is(err, conversation.ErrForbidden) {
		t.Fatalf("speech for absent session = %v", err)
	}
}

func TestObserveFiltersEventsByAgentAndSession(t *testing.T) {
	a, rpc := newFake()
	observations, err := a.Observe(context.Background(), scope())
	if err != nil {
		t.Fatal(err)
	}
	rpc.events <- event{Name: "chat", Payload: json.RawMessage(`{"sessionKey":"other","agentId":"interviewer"}`)}
	rpc.events <- event{Name: "chat", Payload: json.RawMessage(`{"sessionKey":"agent:interviewer:aos-invite:guest_1","agentId":"interviewer"}`)}
	select {
	case <-observations:
	case <-time.After(time.Second):
		t.Fatal("scoped event not observed")
	}
}
