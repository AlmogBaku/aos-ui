package opencode_test

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
	"testing"
	"time"

	"aosui/gateway/conversation"
	"aosui/gateway/opencode"
)

type nativeCall struct {
	Method string
	Path   string
	Body   map[string]any
}

type nativeServer struct {
	t         *testing.T
	mu        sync.Mutex
	sessions  []map[string]any
	questions []map[string]any
	calls     []nativeCall
	nextID    int
}

func (n *nativeServer) serve(w http.ResponseWriter, r *http.Request) {
	n.mu.Lock()
	defer n.mu.Unlock()
	var body map[string]any
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	n.calls = append(n.calls, nativeCall{Method: r.Method, Path: r.URL.Path, Body: body})
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/agent":
		_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "primary", "hidden": false}})
	case r.Method == http.MethodGet && r.URL.Path == "/experimental/session":
		_ = json.NewEncoder(w).Encode(n.sessions)
	case r.Method == http.MethodGet && r.URL.Path == "/question":
		_ = json.NewEncoder(w).Encode(n.questions)
	case r.Method == http.MethodPost && r.URL.Path == "/session":
		n.nextID++
		s := map[string]any{"id": "created-" + string(rune('0'+n.nextID)), "agent": body["agent"], "title": body["title"], "metadata": body["metadata"]}
		n.sessions = append(n.sessions, s)
		_ = json.NewEncoder(w).Encode(s)
	case r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/session/"):
		id := strings.TrimPrefix(r.URL.Path, "/session/")
		for _, session := range n.sessions {
			if session["id"] == id {
				session["metadata"] = body["metadata"]
				_ = json.NewEncoder(w).Encode(session)
				return
			}
		}
		http.NotFound(w, r)
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/children"):
		_ = json.NewEncoder(w).Encode([]any{})
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/message"):
		_ = json.NewEncoder(w).Encode([]any{
			map[string]any{"info": map[string]any{"id": "u1", "role": "user"}, "parts": []any{map[string]any{"type": "text", "text": "hello"}, map[string]any{"type": "reasoning", "text": "secret"}}},
			map[string]any{"info": map[string]any{"id": "a1", "role": "assistant"}, "parts": []any{map[string]any{"type": "text", "text": "hi"}, map[string]any{"type": "file", "mime": "image/png", "filename": "x.png", "url": "data:image/png;base64,AA=="}, map[string]any{"type": "tool", "tool": "bash"}, map[string]any{"type": "tool", "id": "artifact-part", "tool": "present_artifact", "state": map[string]any{"status": "completed", "metadata": map[string]any{"aos_ui": map[string]any{"kind": "artifact", "id": "artifact-1", "filename": "Report.txt", "mimeType": "text/plain", "sizeBytes": 3}}, "attachments": []any{map[string]any{"type": "file", "filename": "Report.txt", "mime": "text/plain", "url": "data:text/plain;base64,eWVz"}}}}}},
		})
	case r.Method == http.MethodGet && r.URL.Path == "/session/status":
		statuses := map[string]any{}
		for _, s := range n.sessions {
			statuses[s["id"].(string)] = map[string]any{"type": "busy"}
		}
		_ = json.NewEncoder(w).Encode(statuses)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/prompt_async"):
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/abort"):
		_ = json.NewEncoder(w).Encode(true)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/revert"):
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "ok", "agent": "writer"})
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/reply"):
		_ = json.NewEncoder(w).Encode(true)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/reject"):
		_ = json.NewEncoder(w).Encode(true)
	default:
		http.NotFound(w, r)
	}
}

func newAdapter(t *testing.T, n *nativeServer) (*opencode.Adapter, *httptest.Server) {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(n.serve))
	a, err := opencode.New(opencode.Config{BaseURL: s.URL, Directory: "/work", Username: "u", Password: "p", HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return a, s
}

func scope(ref string) conversation.Scope { return conversation.Scope{Agent: "writer", Ref: ref} }

func session(ref, id string) map[string]any {
	return map[string]any{"id": id, "agent": "writer", "metadata": map[string]any{"aos": map[string]any{"externalRef": ref}, "keep": "yes"}}
}

func TestStateAndHistoryAreReadOnly(t *testing.T) {
	n := &nativeServer{t: t}
	a, server := newAdapter(t, n)
	defer server.Close()

	state, err := a.State(context.Background(), scope("invite-1"))
	if err != nil || state.Status != conversation.StatusNew {
		t.Fatalf("state = %#v, %v", state, err)
	}
	snapshot, err := a.History(context.Background(), scope("invite-1"))
	if err != nil || len(snapshot.Messages) != 0 {
		t.Fatalf("snapshot = %#v, %v", snapshot, err)
	}
	for _, call := range n.calls {
		if call.Method != http.MethodGet {
			t.Fatalf("read path wrote with %s %s", call.Method, call.Path)
		}
	}
}

func TestFirstSendCreatesOneRefAndUsesNativeSystemField(t *testing.T) {
	n := &nativeServer{t: t}
	a, server := newAdapter(t, n)
	defer server.Close()
	input := conversation.SendInput{
		Content:   []conversation.Part{{Type: "text", Text: "hello"}, {Type: "file", Mime: "image/png", Filename: "x.png", URL: "data:image/png;base64,AA=="}},
		FirstTurn: &conversation.FirstTurn{Instruction: "Load the interview skill for Dan."},
	}
	if err := a.Send(context.Background(), scope("invite-1"), input); err != nil {
		t.Fatal(err)
	}

	var create, prompt *nativeCall
	for i := range n.calls {
		switch {
		case n.calls[i].Method == http.MethodPost && n.calls[i].Path == "/session":
			create = &n.calls[i]
		case strings.HasSuffix(n.calls[i].Path, "/prompt_async"):
			prompt = &n.calls[i]
		}
	}
	if create == nil || prompt == nil {
		t.Fatalf("calls = %#v", n.calls)
	}
	metadata := create.Body["metadata"].(map[string]any)
	if got := metadata["aos"].(map[string]any)["externalRef"]; got != "invite-1" {
		t.Fatalf("metadata = %#v", metadata)
	}
	if got := prompt.Body["system"]; got != "Load the interview skill for Dan." {
		t.Fatalf("system = %#v", got)
	}
	parts := prompt.Body["parts"].([]any)
	if got := parts[0].(map[string]any)["text"]; got != "hello" {
		t.Fatalf("visible prompt was modified: %q", got)
	}
	if _, ok := prompt.Body["model"]; ok {
		t.Fatalf("model leaked: %#v", prompt.Body)
	}
	if prompt.Path != "/session/created-1/prompt_async" {
		t.Fatalf("prompt target = %s", prompt.Path)
	}
}

func TestRestartFindsRefAndNeverReinjectsFirstTurn(t *testing.T) {
	n := &nativeServer{t: t}
	first, server := newAdapter(t, n)
	defer server.Close()
	input := conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "one"}}, FirstTurn: &conversation.FirstTurn{Instruction: "only once"}}
	if err := first.Send(context.Background(), scope("stable"), input); err != nil {
		t.Fatal(err)
	}
	restarted, err := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Send(context.Background(), scope("stable"), conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "two"}}, FirstTurn: &conversation.FirstTurn{Instruction: "must be ignored"}}); err != nil {
		t.Fatal(err)
	}

	creates := 0
	var prompts []map[string]any
	for _, call := range n.calls {
		if call.Method == http.MethodPost && call.Path == "/session" {
			creates++
		}
		if strings.HasSuffix(call.Path, "/prompt_async") {
			prompts = append(prompts, call.Body)
		}
	}
	if creates != 1 || len(prompts) != 2 {
		t.Fatalf("creates=%d prompts=%d", creates, len(prompts))
	}
	if _, ok := prompts[1]["system"]; ok {
		t.Fatalf("first-turn instruction reinjected: %#v", prompts[1])
	}
}

func TestRestartRecoversRefTaggedEmptySessionAsUninitialized(t *testing.T) {
	var mu sync.Mutex
	sessionInfo := session("partial", "persisted")
	sessionInfo["metadata"].(map[string]any)["keep"] = "yes"
	var promptBodies []map[string]any
	var metadataWrites []map[string]any
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/agent":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "primary"}})
		case r.URL.Path == "/experimental/session":
			mu.Lock()
			defer mu.Unlock()
			_ = json.NewEncoder(w).Encode([]any{sessionInfo})
		case strings.HasSuffix(r.URL.Path, "/message") && r.Method == http.MethodGet:
			// Simulate delayed native history visibility even after acceptance.
			_ = json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodPatch && r.URL.Path == "/session/persisted":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			metadata := body["metadata"].(map[string]any)
			mu.Lock()
			sessionInfo["metadata"] = metadata
			metadataWrites = append(metadataWrites, metadata)
			response := map[string]any{"id": "persisted", "agent": "writer", "metadata": metadata}
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(response)
		case strings.HasSuffix(r.URL.Path, "/prompt_async"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			writes++
			promptBodies = append(promptBodies, body)
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	first, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	state, err := first.State(context.Background(), scope("partial"))
	if err != nil || state.Status != conversation.StatusNew || writes != 0 {
		t.Fatalf("pre-restart state=%#v err=%v writes=%d", state, err, writes)
	}

	restarted, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	input := conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "resume"}}, FirstTurn: &conversation.FirstTurn{Instruction: "initialize once"}}
	if err := restarted.Send(context.Background(), scope("partial"), input); err != nil {
		t.Fatal(err)
	}
	state, err = restarted.State(context.Background(), scope("partial"))
	if err != nil || state.Status != conversation.StatusExisting {
		t.Fatalf("initialized state with delayed messages=%#v err=%v", state, err)
	}
	if err := restarted.Send(context.Background(), scope("partial"), conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "again"}}, FirstTurn: &conversation.FirstTurn{Instruction: "must not repeat"}}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if writes != 2 || len(metadataWrites) != 2 || promptBodies[0]["system"] != "initialize once" {
		t.Fatalf("writes=%d metadata=%#v prompts=%#v", writes, metadataWrites, promptBodies)
	}
	firstID, _ := promptBodies[0]["messageID"].(string)
	initialization := metadataWrites[1]["aos"].(map[string]any)["initialization"].(map[string]any)
	if firstID == "" || initialization["messageID"] != firstID || initialization["state"] != "complete" || metadataWrites[1]["keep"] != "yes" {
		t.Fatalf("durable initialization identity was not preserved: id=%q metadata=%#v", firstID, metadataWrites[1])
	}
	if _, ok := promptBodies[1]["system"]; ok {
		t.Fatalf("first-turn instruction repeated: %#v", promptBodies[1])
	}
	if _, ok := promptBodies[1]["messageID"]; ok {
		t.Fatalf("initialization identity reused for an ordinary send: %#v", promptBodies[1])
	}
}

func TestRestartResumesPendingInitializationWithSameMessageIdentity(t *testing.T) {
	metadata := map[string]any{
		"keep": "yes",
		"aos": map[string]any{
			"externalRef":    "pending",
			"initialization": map[string]any{"messageID": "msg_aos_0123456789abcdef0123456789abcdef", "state": "pending"},
		},
	}
	sessionInfo := map[string]any{"id": "persisted", "agent": "writer", "metadata": metadata}
	var prompt map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/agent":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "primary"}})
		case r.URL.Path == "/experimental/session":
			_ = json.NewEncoder(w).Encode([]any{sessionInfo})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/message"):
			_ = json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/prompt_async"):
			_ = json.NewDecoder(r.Body).Decode(&prompt)
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPatch && r.URL.Path == "/session/persisted":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			metadata = body["metadata"].(map[string]any)
			sessionInfo["metadata"] = metadata
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "persisted", "agent": "writer", "metadata": metadata})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	input := conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "resume"}}, FirstTurn: &conversation.FirstTurn{Instruction: "initialize once"}}
	if err := a.Send(context.Background(), scope("pending"), input); err != nil {
		t.Fatal(err)
	}
	if prompt["messageID"] != "msg_aos_0123456789abcdef0123456789abcdef" || prompt["system"] != "initialize once" {
		t.Fatalf("prompt = %#v", prompt)
	}
	initialization := metadata["aos"].(map[string]any)["initialization"].(map[string]any)
	if initialization["state"] != "complete" || metadata["keep"] != "yes" {
		t.Fatalf("metadata = %#v", metadata)
	}
}

func TestSendPromotesPendingInitializationWhenNativeMessageIsVisible(t *testing.T) {
	metadata := map[string]any{
		"keep": "yes",
		"aos": map[string]any{
			"externalRef":    "pending-visible",
			"initialization": map[string]any{"messageID": "msg_aos_0123456789abcdef0123456789abcdef", "state": "pending"},
		},
	}
	sessionInfo := map[string]any{"id": "persisted", "agent": "writer", "metadata": metadata}
	var prompt map[string]any
	patches := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/agent":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "primary"}})
		case r.URL.Path == "/experimental/session":
			_ = json.NewEncoder(w).Encode([]any{sessionInfo})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/message"):
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"info": map[string]any{"id": "u1", "role": "user"}}})
		case r.Method == http.MethodPatch && r.URL.Path == "/session/persisted":
			patches++
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			metadata = body["metadata"].(map[string]any)
			sessionInfo["metadata"] = metadata
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "persisted", "agent": "writer", "metadata": metadata})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/prompt_async"):
			_ = json.NewDecoder(r.Body).Decode(&prompt)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	input := conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "next"}}, FirstTurn: &conversation.FirstTurn{Instruction: "must not repeat"}}
	if err := a.Send(context.Background(), scope("pending-visible"), input); err != nil {
		t.Fatal(err)
	}
	initialization := metadata["aos"].(map[string]any)["initialization"].(map[string]any)
	if patches != 1 || initialization["state"] != "complete" || metadata["keep"] != "yes" {
		t.Fatalf("patches=%d metadata=%#v", patches, metadata)
	}
	if _, ok := prompt["system"]; ok {
		t.Fatalf("first-turn instruction repeated: %#v", prompt)
	}
	if _, ok := prompt["messageID"]; ok {
		t.Fatalf("initialization identity reused for an ordinary send: %#v", prompt)
	}
}

func TestRepeatedSendUsesExactlyOneSessionForRef(t *testing.T) {
	n := &nativeServer{t: t}
	a, server := newAdapter(t, n)
	defer server.Close()
	for _, text := range []string{"one", "two"} {
		if err := a.Send(context.Background(), scope("same"), conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: text}}}); err != nil {
			t.Fatal(err)
		}
	}
	creates := 0
	for _, call := range n.calls {
		if call.Method == http.MethodPost && call.Path == "/session" {
			creates++
		}
	}
	if creates != 1 || len(n.sessions) != 1 {
		t.Fatalf("creates=%d sessions=%#v", creates, n.sessions)
	}
}

func TestConcurrentFirstSendsCreateExactlyOneSession(t *testing.T) {
	var mu sync.Mutex
	var sessions []map[string]any
	creates := 0
	firstLookup := make(chan struct{})
	releaseFirstLookup := make(chan struct{})
	lookupCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/agent":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "primary"}})
		case r.URL.Path == "/experimental/session":
			mu.Lock()
			lookupCount++
			currentLookup := lookupCount
			mu.Unlock()
			if currentLookup == 1 {
				close(firstLookup)
				<-releaseFirstLookup
			}
			mu.Lock()
			defer mu.Unlock()
			_ = json.NewEncoder(w).Encode(sessions)
		case r.Method == http.MethodPost && r.URL.Path == "/session":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			creates++
			created := session("concurrent", "created")
			sessions = append(sessions, created)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(created)
		case r.Method == http.MethodPatch && r.URL.Path == "/session/created":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			sessions[0]["metadata"] = body["metadata"]
			updated := sessions[0]
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(updated)
		case strings.HasSuffix(r.URL.Path, "/children"):
			_ = json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/message"):
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"info": map[string]any{"id": "u1", "role": "user"}}})
		case strings.HasSuffix(r.URL.Path, "/prompt_async"):
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})

	errorsBySend := make(chan error, 2)
	go func() {
		errorsBySend <- a.Send(context.Background(), scope("concurrent"), conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "one"}}})
	}()
	<-firstLookup
	go func() {
		errorsBySend <- a.Send(context.Background(), scope("concurrent"), conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "two"}}})
	}()
	close(releaseFirstLookup)
	for range 2 {
		if err := <-errorsBySend; err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if creates != 1 || len(sessions) != 1 {
		t.Fatalf("creates=%d sessions=%#v", creates, sessions)
	}
}

func TestCreateMetadataFallbackPreservesUnrelatedKeys(t *testing.T) {
	var patchBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/agent":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "primary"}})
		case r.URL.Path == "/experimental/session":
			_ = json.NewEncoder(w).Encode([]any{})
		case r.Method == http.MethodPost && r.URL.Path == "/session":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "created", "agent": "writer", "metadata": map[string]any{"keep": "yes", "aos": map[string]any{"version": 7}}})
		case r.Method == http.MethodPatch && r.URL.Path == "/session/created":
			_ = json.NewDecoder(r.Body).Decode(&patchBody)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "created", "agent": "writer", "metadata": patchBody["metadata"]})
		case strings.HasSuffix(r.URL.Path, "/children"):
			_ = json.NewEncoder(w).Encode([]any{})
		case strings.HasSuffix(r.URL.Path, "/prompt_async"):
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	if err := a.Send(context.Background(), scope("metadata"), conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "hello"}}}); err != nil {
		t.Fatal(err)
	}
	metadata := patchBody["metadata"].(map[string]any)
	if metadata["keep"] != "yes" {
		t.Fatalf("unrelated metadata was lost: %#v", metadata)
	}
	namespace := metadata["aos"].(map[string]any)
	if namespace["version"] != float64(7) || namespace["externalRef"] != "metadata" {
		t.Fatalf("namespace was not merged: %#v", namespace)
	}
}

func TestAmbiguousRefAndOtherAgentAreRejected(t *testing.T) {
	n := &nativeServer{t: t, sessions: []map[string]any{session("same", "one"), session("same", "two")}}
	a, server := newAdapter(t, n)
	defer server.Close()
	if _, err := a.State(context.Background(), scope("same")); !errors.Is(err, conversation.ErrAmbiguous) {
		t.Fatalf("ambiguous state error = %v", err)
	}
	n.sessions = []map[string]any{{"id": "other", "agent": "other", "metadata": map[string]any{"aos": map[string]any{"externalRef": "same"}}}}
	state, err := a.State(context.Background(), scope("same"))
	if err != nil || state.Status != conversation.StatusNew {
		t.Fatalf("other agent state = %#v, %v", state, err)
	}
}

func TestStateFollowsExperimentalNativeCursor(t *testing.T) {
	var cursors []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "primary"}})
		case "/experimental/session":
			cursor := r.URL.Query().Get("cursor")
			cursors = append(cursors, cursor)
			if cursor == "" {
				w.Header().Set("X-Next-Cursor", "42")
				_ = json.NewEncoder(w).Encode([]any{session("other", "unrelated")})
				return
			}
			_ = json.NewEncoder(w).Encode([]any{session("paged", "found")})
		case "/session/found/message":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"info": map[string]any{"id": "u1", "role": "user"}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a, err := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	state, err := a.State(context.Background(), scope("paged"))
	if err != nil || state.Status != conversation.StatusExisting {
		t.Fatalf("state = %#v, %v", state, err)
	}
	if strings.Join(cursors, ",") != ",42" {
		t.Fatalf("cursors = %#v", cursors)
	}
}

func TestHistoryProjectsOnlySafeConversationParts(t *testing.T) {
	n := &nativeServer{t: t, sessions: []map[string]any{session("invite-1", "existing")}}
	a, server := newAdapter(t, n)
	defer server.Close()
	got, err := a.History(context.Background(), scope("invite-1"))
	if err != nil {
		t.Fatal(err)
	}
	if !got.Running || len(got.Messages) != 2 || len(got.Messages[0].Content) != 1 || len(got.Messages[1].Content) != 3 {
		t.Fatalf("unsafe projection: %#v", got)
	}
	if got.Messages[1].Content[1].Type != "image" || got.Messages[1].Content[1].URL != "data:image/png;base64,AA==" {
		t.Fatalf("attachment missing: %#v", got)
	}
	artifact := got.Messages[1].Content[2].Artifact
	if artifact == nil || artifact.ID != "artifact-1" || artifact.Source.Type != "inline" || artifact.Source.Data != "eWVz" {
		t.Fatalf("artifact missing: %#v", got)
	}
}

func TestHistoryProjectsOnlyValidatedCompletedPresentationTools(t *testing.T) {
	n := &nativeServer{t: t, sessions: []map[string]any{session("invite-1", "existing")}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/agent":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "primary"}})
		case r.URL.Path == "/experimental/session":
			_ = json.NewEncoder(w).Encode(n.sessions)
		case strings.HasSuffix(r.URL.Path, "/children"):
			_ = json.NewEncoder(w).Encode([]any{})
		case strings.HasSuffix(r.URL.Path, "/message"):
			plan := map[string]any{
				"id": "release", "title": "Release",
				"steps": []any{map[string]any{"id": "test", "label": "Test", "status": "active"}},
			}
			locations := []any{map[string]any{"id": "hq", "label": "HQ", "latitude": 32.1, "longitude": 34.8}}
			parts := []any{
				toolPart("plan-1", "present_plan", "completed", plan),
				toolPart("map-1", "render_map", "completed", map[string]any{"title": "Sites", "locations": locations}),
				toolPart("chart-1", "render_chart", "completed", map[string]any{"title": "Traffic", "type": "bar", "xKey": "month", "series": []any{map[string]any{"key": "value", "label": "Visits"}}, "data": []any{map[string]any{"month": "Jan", "value": 12}}}),
				toolPart("stats-1", "render_stats", "completed", map[string]any{"title": "Summary", "stats": []any{map[string]any{"key": "users", "label": "Users", "value": 12, "format": map[string]any{"kind": "number", "decimals": 0}}}}),
				toolPart("bad-plan", "present_plan", "completed", map[string]any{"id": "x", "title": "Bad", "steps": []any{map[string]any{"id": "x", "label": "X", "status": "secret"}}}),
				toolPart("bad-map", "render_map", "completed", map[string]any{"title": "Bad", "locations": []any{map[string]any{"id": "x", "label": "X", "latitude": 200, "longitude": 0}}}),
				toolPart("bad-chart", "render_chart", "completed", map[string]any{"title": "Bad", "xKey": "month", "series": []any{map[string]any{"key": "value", "label": "Visits"}}, "data": []any{map[string]any{"month": "Jan", "value": "secret"}}}),
				toolPart("bad-stats", "render_stats", "completed", map[string]any{"stats": []any{map[string]any{"key": "x", "label": "X", "value": map[string]any{"secret": true}}}}),
				toolPart("pending", "render_map", "running", map[string]any{"title": "Hidden", "locations": []any{}}),
				toolPart("shell", "bash", "completed", map[string]any{"command": "cat secret"}),
			}
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"info": map[string]any{"id": "a1", "role": "assistant"}, "parts": parts}})
		case r.URL.Path == "/session/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": map[string]any{"type": "idle"}})
		case r.URL.Path == "/question":
			_ = json.NewEncoder(w).Encode([]any{})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	got, err := a.History(context.Background(), scope("invite-1"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Messages) != 1 || len(got.Messages[0].Content) != 4 {
		t.Fatalf("projection = %#v", got.Messages)
	}
	wantKinds := []string{"plan", "map", "chart", "stats"}
	for index, kind := range wantKinds {
		if got.Messages[0].Content[index].Display.Kind != kind {
			t.Fatalf("display %d = %#v", index, got.Messages[0].Content[index])
		}
	}
	if got.Messages[0].Content[0].Display == nil {
		t.Fatalf("displays = %#v", got.Messages[0].Content)
	}
	encoded, _ := json.Marshal(got.Messages)
	for _, forbidden := range []string{"bad-plan", "bad-map", "bad-chart", "bad-stats", "pending", "shell", "secret", "command"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("%q leaked in projection: %s", forbidden, encoded)
		}
	}
}

func toolPart(id, tool, status string, input map[string]any) map[string]any {
	return map[string]any{"id": id, "type": "tool", "tool": tool, "state": map[string]any{"status": status, "input": input}}
}

func TestHistoryProjectsBoundedQuestionsForExactSessionWithOpaqueStableID(t *testing.T) {
	questions := []map[string]any{
		{
			"id": "native-request-secret", "sessionID": "existing",
			"questions": []any{
				map[string]any{"header": "Mode", "question": "How should this run?", "options": []any{map[string]any{"label": "Fast", "description": "Run focused checks"}}, "multiple": false, "custom": true},
				map[string]any{"header": "Checks", "question": "Which checks?", "options": []any{map[string]any{"label": "Tests", "description": "Run tests"}, map[string]any{"label": "Vet", "description": "Run vet"}}, "multiple": true, "custom": false},
			},
		},
		{"id": "other-native", "sessionID": "other", "questions": []any{map[string]any{"header": "Secret", "question": "Other?", "options": []any{}, "custom": true}}},
		{"id": "malformed-native", "sessionID": "existing", "questions": []any{map[string]any{"header": "Bad", "question": "Unsafe?", "options": []any{}, "multiple": false, "custom": false}}},
	}
	n := &nativeServer{t: t, sessions: []map[string]any{session("invite-1", "existing")}, questions: questions}
	a, server := newAdapter(t, n)
	defer server.Close()
	first, err := a.History(context.Background(), scope("invite-1"))
	if err != nil {
		t.Fatal(err)
	}
	restarted, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	second, err := restarted.History(context.Background(), scope("invite-1"))
	if err != nil {
		t.Fatal(err)
	}
	if len(first.PendingQuestions) != 1 || len(second.PendingQuestions) != 1 || len(first.PendingQuestions[0].Questions) != 2 {
		t.Fatalf("pending questions = %#v / %#v", first.PendingQuestions, second.PendingQuestions)
	}
	publicID := first.PendingQuestions[0].ID
	if publicID == "" || publicID == "native-request-secret" || strings.Contains(publicID, "native") || second.PendingQuestions[0].ID != publicID {
		t.Fatalf("public ids = %q, %q", publicID, second.PendingQuestions[0].ID)
	}
	if got := first.PendingQuestions[0].Questions[1]; !got.Multiple || got.Custom || len(got.Options) != 2 || got.Options[0].Description != "Run tests" {
		t.Fatalf("projected question = %#v", got)
	}
}

func TestQuestionReplyAndRejectRelistAuthorizeAndTranslateNativeBatch(t *testing.T) {
	n := &nativeServer{
		t:        t,
		sessions: []map[string]any{session("invite-1", "existing")},
		questions: []map[string]any{{
			"id": "native-question", "sessionID": "existing",
			"questions": []any{
				map[string]any{"header": "Mode", "question": "Mode?", "options": []any{map[string]any{"label": "Fast", "description": "Focused"}}, "custom": true},
				map[string]any{"header": "Checks", "question": "Checks?", "options": []any{map[string]any{"label": "Tests", "description": "Tests"}, map[string]any{"label": "Vet", "description": "Vet"}}, "multiple": true},
			},
		}},
	}
	a, server := newAdapter(t, n)
	defer server.Close()
	snapshot, err := a.History(context.Background(), scope("invite-1"))
	if err != nil {
		t.Fatal(err)
	}
	publicID := snapshot.PendingQuestions[0].ID
	answers := [][]string{{}, {"Tests", "Vet"}}
	if err := a.ReplyQuestion(context.Background(), scope("invite-1"), publicID, answers); err != nil {
		t.Fatal(err)
	}
	if err := a.RejectQuestion(context.Background(), scope("invite-1"), publicID); err != nil {
		t.Fatal(err)
	}
	var reply, reject *nativeCall
	questionLists := 0
	for index := range n.calls {
		call := &n.calls[index]
		if call.Method == http.MethodGet && call.Path == "/question" {
			questionLists++
		}
		if call.Method == http.MethodPost && strings.HasSuffix(call.Path, "/reply") {
			reply = call
		}
		if call.Method == http.MethodPost && strings.HasSuffix(call.Path, "/reject") {
			reject = call
		}
	}
	if questionLists != 3 || reply == nil || reply.Path != "/question/native-question/reply" || reject == nil || reject.Path != "/question/native-question/reject" {
		t.Fatalf("calls = %#v", n.calls)
	}
	encodedAnswers, _ := json.Marshal(reply.Body["answers"])
	if string(encodedAnswers) != `[[],["Tests","Vet"]]` {
		t.Fatalf("reply = %#v", reply.Body)
	}
}

func TestQuestionReplyRejectsInvalidOrStalePublicRequest(t *testing.T) {
	n := &nativeServer{
		t:        t,
		sessions: []map[string]any{session("invite-1", "existing")},
		questions: []map[string]any{{
			"id": "native-question", "sessionID": "existing",
			"questions": []any{map[string]any{"header": "Mode", "question": "Mode?", "options": []any{map[string]any{"label": "Fast", "description": "Focused"}}, "multiple": false, "custom": false}}}},
	}
	a, server := newAdapter(t, n)
	defer server.Close()
	snapshot, _ := a.History(context.Background(), scope("invite-1"))
	publicID := snapshot.PendingQuestions[0].ID
	for _, answers := range [][][]string{
		{},
		{{"Fast", "Fast"}},
		{{"not an option"}},
	} {
		if err := a.ReplyQuestion(context.Background(), scope("invite-1"), publicID, answers); !errors.Is(err, conversation.ErrForbidden) {
			t.Fatalf("answers=%#v error=%v", answers, err)
		}
	}
	postsBefore := 0
	for _, call := range n.calls {
		if call.Method == http.MethodPost {
			postsBefore++
		}
	}
	n.questions[0]["sessionID"] = "other"
	if err := a.ReplyQuestion(context.Background(), scope("invite-1"), publicID, [][]string{{"Fast"}}); !errors.Is(err, conversation.ErrForbidden) {
		t.Fatalf("stale error = %v", err)
	}
	postsAfter := 0
	for _, call := range n.calls {
		if call.Method == http.MethodPost {
			postsAfter++
		}
	}
	if postsAfter != postsBefore {
		t.Fatalf("stale request reached native mutation: %#v", n.calls)
	}
}

func TestQuestionMutationServerFailuresAreUncertainAndNotRetried(t *testing.T) {
	for _, test := range []struct {
		name string
		run  func(*opencode.Adapter, string) error
	}{
		{name: "reply", run: func(a *opencode.Adapter, id string) error {
			return a.ReplyQuestion(context.Background(), scope("ref"), id, [][]string{{"Fast"}})
		}},
		{name: "reject", run: func(a *opencode.Adapter, id string) error {
			return a.RejectQuestion(context.Background(), scope("ref"), id)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			mutations := 0
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				switch {
				case r.URL.Path == "/agent":
					return jsonResponse(`[{"name":"writer","mode":"primary"}]`), nil
				case r.URL.Path == "/experimental/session":
					return jsonResponse(`[{"id":"existing","agent":"writer","metadata":{"aos":{"externalRef":"ref"}}}]`), nil
				case r.URL.Path == "/session/existing/message":
					return jsonResponse(`[]`), nil
				case r.URL.Path == "/session/status":
					return jsonResponse(`{"existing":{"type":"idle"}}`), nil
				case r.URL.Path == "/question" && r.Method == http.MethodGet:
					return jsonResponse(`[{"id":"native-question","sessionID":"existing","questions":[{"header":"Mode","question":"Mode?","options":[{"label":"Fast","description":"Focused"}]}]}]`), nil
				case strings.HasPrefix(r.URL.Path, "/question/native-question/") && r.Method == http.MethodPost:
					mutations++
					return statusResponse(http.StatusInternalServerError), nil
				default:
					return statusResponse(http.StatusNotFound), nil
				}
			})}
			a, _ := opencode.New(opencode.Config{BaseURL: "http://native.invalid", Directory: "/work", HTTPClient: client})
			snapshot, err := a.History(context.Background(), scope("ref"))
			if err != nil || len(snapshot.PendingQuestions) != 1 {
				t.Fatalf("history=%#v error=%v", snapshot, err)
			}
			if err := test.run(a, snapshot.PendingQuestions[0].ID); !errors.Is(err, conversation.ErrUncertain) || mutations != 1 {
				t.Fatalf("error=%v mutations=%d", err, mutations)
			}
		})
	}
}

func TestCapabilitiesMatchSafeSupportedSurface(t *testing.T) {
	n := &nativeServer{t: t}
	a, server := newAdapter(t, n)
	defer server.Close()
	got, err := a.Capabilities(context.Background(), scope("any"))
	if err != nil || !got.Attachments || !got.Edit || !got.Regenerate || got.Branches || !got.Questions || got.Speech {
		t.Fatalf("capabilities = %#v, %v", got, err)
	}
	_, err = a.Capabilities(context.Background(), conversation.Scope{Agent: "missing", Ref: "any"})
	if !errors.Is(err, conversation.ErrForbidden) {
		t.Fatalf("missing agent error = %v", err)
	}
}

func TestSendRejectsNonInlineAttachmentsBeforeCreating(t *testing.T) {
	n := &nativeServer{t: t}
	a, server := newAdapter(t, n)
	defer server.Close()
	err := a.Send(context.Background(), scope("invite-1"), conversation.SendInput{Content: []conversation.Part{{Type: "file", URL: "https://example.com/x"}}})
	if !errors.Is(err, conversation.ErrForbidden) || len(n.calls) != 0 {
		t.Fatalf("error=%v calls=%#v", err, n.calls)
	}
}

func TestSendAcceptsSafeInlineAttachmentWithoutFilename(t *testing.T) {
	n := &nativeServer{t: t}
	a, server := newAdapter(t, n)
	defer server.Close()
	err := a.Send(context.Background(), scope("invite-1"), conversation.SendInput{Content: []conversation.Part{{Type: "image", Mime: "image/png", URL: "data:image/png;base64,AA=="}}})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSendAcceptsAdvertisedMarkdownAndJSONAttachments(t *testing.T) {
	for _, mime := range []string{"text/markdown", "application/json"} {
		t.Run(mime, func(t *testing.T) {
			n := &nativeServer{t: t}
			a, server := newAdapter(t, n)
			defer server.Close()
			url := "data:" + mime + ";base64,e30="
			err := a.Send(context.Background(), scope("invite-1"), conversation.SendInput{Content: []conversation.Part{{Type: "file", Mime: mime, Filename: "attachment", URL: url}}})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSendTransportFailureIsUncertainAndNotRetried(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Path == "/agent" {
			return jsonResponse(`[{"name":"writer","mode":"primary"}]`), nil
		}
		if r.URL.Path == "/experimental/session" {
			return jsonResponse(`[{"id":"existing","agent":"writer","metadata":{"aos":{"externalRef":"ref"}}}]`), nil
		}
		if strings.HasSuffix(r.URL.Path, "/message") {
			return jsonResponse(`[{"info":{"id":"u1","role":"user"}}]`), nil
		}
		return nil, errors.New("lost")
	})}
	a, err := opencode.New(opencode.Config{BaseURL: "http://native.invalid", Directory: "/work", HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	err = a.Send(context.Background(), scope("ref"), conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "x"}}})
	if !errors.Is(err, conversation.ErrUncertain) || calls != 4 {
		t.Fatalf("error=%v calls=%d", err, calls)
	}
}

func TestSendHTTPFailureClassificationPreventsBlindRetryAfterServerErrors(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		want   error
	}{
		{name: "validation", status: http.StatusBadRequest, want: conversation.ErrUnavailable},
		{name: "authentication", status: http.StatusForbidden, want: conversation.ErrForbidden},
		{name: "server_error", status: http.StatusInternalServerError, want: conversation.ErrUncertain},
		{name: "bad_gateway", status: http.StatusBadGateway, want: conversation.ErrUncertain},
	} {
		t.Run(test.name, func(t *testing.T) {
			prompts := 0
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				switch {
				case r.URL.Path == "/agent":
					return jsonResponse(`[{"name":"writer","mode":"primary"}]`), nil
				case r.URL.Path == "/experimental/session":
					return jsonResponse(`[{"id":"existing","agent":"writer","metadata":{"aos":{"externalRef":"ref"}}}]`), nil
				case strings.HasSuffix(r.URL.Path, "/message"):
					return jsonResponse(`[{"info":{"id":"u1","role":"user"}}]`), nil
				case strings.HasSuffix(r.URL.Path, "/prompt_async"):
					prompts++
					return statusResponse(test.status), nil
				default:
					return statusResponse(http.StatusNotFound), nil
				}
			})}
			a, _ := opencode.New(opencode.Config{BaseURL: "http://native.invalid", Directory: "/work", HTTPClient: client})
			err := a.Send(context.Background(), scope("ref"), conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "x"}}})
			if !errors.Is(err, test.want) || prompts != 1 {
				t.Fatalf("error=%v prompts=%d", err, prompts)
			}
		})
	}
}

func TestEditPromptTransportFailureIsUncertainAndNotRetried(t *testing.T) {
	prompts := 0
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch {
		case r.URL.Path == "/agent":
			return jsonResponse(`[{"name":"writer","mode":"primary"}]`), nil
		case r.URL.Path == "/experimental/session":
			return jsonResponse(`[{"id":"existing","agent":"writer","metadata":{"aos":{"externalRef":"ref"}}}]`), nil
		case strings.HasSuffix(r.URL.Path, "/message"):
			return jsonResponse(`[{"info":{"id":"u1","role":"user"},"parts":[{"type":"text","text":"original"}]}]`), nil
		case strings.HasSuffix(r.URL.Path, "/revert"):
			return jsonResponse(`{"id":"existing","agent":"writer"}`), nil
		case strings.HasSuffix(r.URL.Path, "/prompt_async"):
			prompts++
			return nil, errors.New("lost")
		default:
			return jsonResponse(`{}`), nil
		}
	})}
	a, _ := opencode.New(opencode.Config{BaseURL: "http://native.invalid", Directory: "/work", HTTPClient: client})
	err := a.Edit(context.Background(), scope("ref"), "u1", conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "replacement"}}})
	if !errors.Is(err, conversation.ErrUncertain) || prompts != 1 {
		t.Fatalf("error=%v prompts=%d", err, prompts)
	}
}

func TestPostRevertPromptClientFailureIsUncertain(t *testing.T) {
	for _, operation := range []struct {
		name string
		run  func(*opencode.Adapter) error
	}{
		{name: "edit", run: func(a *opencode.Adapter) error {
			return a.Edit(context.Background(), scope("ref"), "u1", conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "replacement"}}})
		}},
		{name: "regenerate", run: func(a *opencode.Adapter) error {
			return a.Regenerate(context.Background(), scope("ref"), "u1")
		}},
	} {
		for _, status := range []int{http.StatusBadRequest, http.StatusForbidden} {
			t.Run(fmt.Sprintf("%s/%d", operation.name, status), func(t *testing.T) {
				prompts := 0
				client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					switch {
					case r.URL.Path == "/agent":
						return jsonResponse(`[{"name":"writer","mode":"primary"}]`), nil
					case r.URL.Path == "/experimental/session":
						return jsonResponse(`[{"id":"existing","agent":"writer","metadata":{"aos":{"externalRef":"ref"}}}]`), nil
					case strings.HasSuffix(r.URL.Path, "/message"):
						return jsonResponse(`[{"info":{"id":"u1","role":"user"},"parts":[{"type":"text","text":"original"}]}]`), nil
					case strings.HasSuffix(r.URL.Path, "/abort"):
						return jsonResponse(`true`), nil
					case strings.HasSuffix(r.URL.Path, "/revert"):
						return jsonResponse(`{"id":"existing","agent":"writer"}`), nil
					case strings.HasSuffix(r.URL.Path, "/prompt_async"):
						prompts++
						return statusResponse(status), nil
					default:
						return statusResponse(http.StatusNotFound), nil
					}
				})}
				a, _ := opencode.New(opencode.Config{BaseURL: "http://native.invalid", Directory: "/work", HTTPClient: client})
				if err := operation.run(a); !errors.Is(err, conversation.ErrUncertain) || prompts != 1 {
					t.Fatalf("error=%v prompts=%d", err, prompts)
				}
			})
		}
	}
}

func TestMutationServerFailuresAreUncertain(t *testing.T) {
	for _, test := range []struct {
		name string
		run  func(*opencode.Adapter) error
	}{
		{name: "stop", run: func(a *opencode.Adapter) error { return a.Stop(context.Background(), scope("ref")) }},
		{name: "regenerate", run: func(a *opencode.Adapter) error { return a.Regenerate(context.Background(), scope("ref"), "u1") }},
		{name: "edit revert", run: func(a *opencode.Adapter) error {
			return a.Edit(context.Background(), scope("ref"), "u1", conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "replacement"}}})
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				switch {
				case r.URL.Path == "/agent":
					return jsonResponse(`[{"name":"writer","mode":"primary"}]`), nil
				case r.URL.Path == "/experimental/session":
					return jsonResponse(`[{"id":"existing","agent":"writer","metadata":{"aos":{"externalRef":"ref"}}}]`), nil
				case strings.HasSuffix(r.URL.Path, "/message"):
					return jsonResponse(`[{"info":{"id":"u1","role":"user"},"parts":[{"type":"text","text":"original"}]}]`), nil
				default:
					return statusResponse(http.StatusInternalServerError), nil
				}
			})}
			a, _ := opencode.New(opencode.Config{BaseURL: "http://native.invalid", Directory: "/work", HTTPClient: client})
			if err := test.run(a); !errors.Is(err, conversation.ErrUncertain) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestEditRegenerateAndStopResolveOnlyTheirScope(t *testing.T) {
	n := &nativeServer{t: t, sessions: []map[string]any{session("invite-1", "existing")}}
	a, server := newAdapter(t, n)
	defer server.Close()
	if err := a.Edit(context.Background(), scope("invite-1"), "u1", conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "replacement"}}}); err != nil {
		t.Fatal(err)
	}
	if err := a.Regenerate(context.Background(), scope("invite-1"), "u1"); err != nil {
		t.Fatal(err)
	}
	if err := a.Stop(context.Background(), scope("invite-1")); err != nil {
		t.Fatal(err)
	}
	var operationPaths []string
	for _, call := range n.calls {
		if call.Method == http.MethodPost && call.Path != "/session" {
			operationPaths = append(operationPaths, call.Path)
		}
	}
	want := []string{"/session/existing/revert", "/session/existing/prompt_async", "/session/existing/abort", "/session/existing/revert", "/session/existing/prompt_async", "/session/existing/abort"}
	if strings.Join(operationPaths, ",") != strings.Join(want, ",") {
		t.Fatalf("paths = %#v", operationPaths)
	}
	var prompts []map[string]any
	for _, call := range n.calls {
		if call.Path == "/session/existing/prompt_async" {
			prompts = append(prompts, call.Body)
		}
	}
	if len(prompts) != 2 || prompts[1]["agent"] != "writer" {
		t.Fatalf("prompt replays = %#v", prompts)
	}
	parts, _ := prompts[1]["parts"].([]any)
	if len(parts) != 1 || parts[0].(map[string]any)["text"] != "hello" {
		t.Fatalf("regenerated parts = %#v", prompts[1]["parts"])
	}
}

func TestEditAndRegenerateRejectMessagesOutsideScopedVisibleHistory(t *testing.T) {
	for _, test := range []struct {
		name      string
		messageID string
		run       func(*opencode.Adapter, string) error
	}{
		{name: "edit foreign message", messageID: "foreign", run: func(a *opencode.Adapter, id string) error {
			return a.Edit(context.Background(), scope("invite-1"), id, conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "replacement"}}})
		}},
		{name: "regenerate foreign message", messageID: "foreign", run: func(a *opencode.Adapter, id string) error {
			return a.Regenerate(context.Background(), scope("invite-1"), id)
		}},
		{name: "edit assistant message", messageID: "a1", run: func(a *opencode.Adapter, id string) error {
			return a.Edit(context.Background(), scope("invite-1"), id, conversation.SendInput{Content: []conversation.Part{{Type: "text", Text: "replacement"}}})
		}},
		{name: "regenerate assistant message", messageID: "a1", run: func(a *opencode.Adapter, id string) error {
			return a.Regenerate(context.Background(), scope("invite-1"), id)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			n := &nativeServer{t: t, sessions: []map[string]any{session("invite-1", "existing")}}
			a, server := newAdapter(t, n)
			defer server.Close()

			if err := test.run(a, test.messageID); !errors.Is(err, conversation.ErrForbidden) {
				t.Fatalf("error = %v", err)
			}
			for _, call := range n.calls {
				if call.Method == http.MethodPost {
					t.Fatalf("unauthorized mutation reached native runtime: %#v", call)
				}
			}
		})
	}
}

func TestRootWithChildrenRemainsTheConversationOwner(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "all"}})
		case "/experimental/session":
			_ = json.NewEncoder(w).Encode([]any{session("forked", "root")})
		case "/session/root/message":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"id": "child", "parentID": "root"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	state, err := a.State(context.Background(), scope("forked"))
	if err != nil || state.Status != conversation.StatusExisting {
		t.Fatalf("state = %#v, %v", state, err)
	}
}

func TestChildSessionCannotOwnAConversationRef(t *testing.T) {
	n := &nativeServer{t: t, sessions: []map[string]any{{
		"id": "child", "agent": "writer", "parentID": "root",
		"metadata": map[string]any{"aos": map[string]any{"externalRef": "child-ref"}},
	}}}
	a, server := newAdapter(t, n)
	defer server.Close()
	state, err := a.State(context.Background(), scope("child-ref"))
	if err != nil || state.Status != conversation.StatusNew {
		t.Fatalf("state = %#v, %v", state, err)
	}
}

func TestObserveFiltersNativeSSEToExistingReferencedSession(t *testing.T) {
	unrelatedSent := make(chan struct{})
	releaseRelevant := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "primary"}})
		case "/experimental/session":
			_ = json.NewEncoder(w).Encode([]any{session("observed", "target")})
		case "/event":
			if r.URL.Query().Get("directory") != "/work" {
				t.Errorf("directory = %q", r.URL.Query().Get("directory"))
			}
			w.Header().Set("Content-Type", "text/event-stream")
			flusher := w.(http.Flusher)
			flusher.Flush()
			_, _ = fmt.Fprint(w, "data: {\"type\":\"message.updated\",\"properties\":{\"sessionID\":\"other\"}}\n\n")
			flusher.Flush()
			close(unrelatedSent)
			<-releaseRelevant
			_, _ = fmt.Fprint(w, "data: {\"type\":\"message.part.updated\",\"properties\":{\"sessionID\":\"target\"}}\n\n")
			flusher.Flush()
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	a, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	observations, err := a.Observe(ctx, scope("observed"))
	if err != nil {
		t.Fatal(err)
	}
	<-unrelatedSent
	select {
	case observation := <-observations:
		t.Fatalf("unrelated event notified: %#v", observation)
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseRelevant)
	select {
	case observation := <-observations:
		if observation.Err != nil {
			t.Fatal(observation.Err)
		}
	case <-time.After(time.Second):
		t.Fatal("relevant event did not notify")
	}
	cancel()
	select {
	case _, ok := <-observations:
		if ok {
			t.Fatal("observation stream remained open after cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("observation stream did not close")
	}
}

func TestObserveDiscoversInitiallyNewRefWithoutLeakingUnrelatedCreation(t *testing.T) {
	releaseMatch := make(chan struct{})
	unrelatedSent := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "primary"}})
		case "/experimental/session":
			_ = json.NewEncoder(w).Encode([]any{})
		case "/event":
			w.Header().Set("Content-Type", "text/event-stream")
			flusher := w.(http.Flusher)
			flusher.Flush()
			_, _ = fmt.Fprint(w, "data: {not-json}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"type\":\"session.created\",\"properties\":{\"sessionID\":\"other\",\"info\":{\"id\":\"other\",\"agent\":\"other\",\"metadata\":{\"aos\":{\"externalRef\":\"new-ref\"}}}}}\n\n")
			flusher.Flush()
			close(unrelatedSent)
			<-releaseMatch
			_, _ = fmt.Fprint(w, "data: {\"type\":\"session.created\",\"properties\":{\"sessionID\":\"created\",\"info\":{\"id\":\"created\",\"agent\":\"writer\",\"metadata\":{\"aos\":{\"externalRef\":\"new-ref\"}}}}}\n\n")
			flusher.Flush()
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: server.Client()})
	observations, err := a.Observe(ctx, scope("new-ref"))
	if err != nil {
		t.Fatal(err)
	}
	<-unrelatedSent
	select {
	case observation := <-observations:
		t.Fatalf("unrelated creation notified: %#v", observation)
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseMatch)
	select {
	case observation := <-observations:
		if observation.Err != nil {
			t.Fatal(observation.Err)
		}
	case <-time.After(time.Second):
		t.Fatal("matching creation did not notify")
	}
}

func TestObserveSurvivesFiniteRequestClientTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"name": "writer", "mode": "primary"}})
		case "/experimental/session":
			_ = json.NewEncoder(w).Encode([]any{session("observed", "target")})
		case "/event":
			w.Header().Set("Content-Type", "text/event-stream")
			flusher := w.(http.Flusher)
			flusher.Flush()
			time.Sleep(75 * time.Millisecond)
			_, _ = fmt.Fprint(w, "data: {\"type\":\"message.updated\",\"properties\":{\"sessionID\":\"target\"}}\n\n")
			flusher.Flush()
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := server.Client()
	client.Timeout = 25 * time.Millisecond
	a, _ := opencode.New(opencode.Config{BaseURL: server.URL, Directory: "/work", HTTPClient: client})
	observations, err := a.Observe(ctx, scope("observed"))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case observation := <-observations:
		if observation.Err != nil {
			t.Fatalf("stream inherited finite request timeout: %v", observation.Err)
		}
	case <-time.After(time.Second):
		t.Fatal("delayed native event did not notify")
	}
}

func TestNewRejectsAuthorityAndQueryInjection(t *testing.T) {
	for _, raw := range []string{"http://user:pass@native.test", "http://native.test?x=1", "http://native.test/#frag"} {
		if _, err := opencode.New(opencode.Config{BaseURL: raw, Directory: "/work"}); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
}

func jsonResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func statusResponse(status int) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
