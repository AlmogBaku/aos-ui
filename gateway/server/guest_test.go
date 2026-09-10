package server_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"aosui/gateway/conversation"
	"aosui/gateway/invite"
	"aosui/gateway/server"
)

type native struct {
	mu            sync.Mutex
	caps          conversation.Capabilities
	state         conversation.Status
	sends         int
	firstTurns    int
	replies       int
	rejections    int
	answers       [][]string
	historyCalls  int
	history       conversation.Snapshot
	observations  chan conversation.Observation
	artifactReads int
	artifactRef   string
}

func (n *native) Capabilities(context.Context, conversation.Scope) (conversation.Capabilities, error) {
	return n.caps, nil
}
func (n *native) State(context.Context, conversation.Scope) (conversation.State, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	status := n.state
	if status == "" {
		status = conversation.StatusNew
	}
	return conversation.State{Status: status}, nil
}
func (n *native) History(context.Context, conversation.Scope) (conversation.Snapshot, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.historyCalls++
	return n.history, nil
}
func (n *native) Send(_ context.Context, _ conversation.Scope, input conversation.SendInput) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sends++
	if n.state == "" || n.state == conversation.StatusNew {
		if input.FirstTurn != nil {
			n.firstTurns++
		}
		n.state = conversation.StatusExisting
	}
	return nil
}
func (n *native) Stop(context.Context, conversation.Scope) error { return nil }
func (n *native) ReplyQuestion(_ context.Context, _ conversation.Scope, _ string, answers [][]string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.replies++
	n.answers = answers
	return nil
}
func (n *native) RejectQuestion(context.Context, conversation.Scope, string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.rejections++
	return nil
}
func (n *native) Observe(context.Context, conversation.Scope) (<-chan conversation.Observation, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.observations == nil {
		n.observations = make(chan conversation.Observation, 1)
	}
	return n.observations, nil
}
func (n *native) ReadArtifact(_ context.Context, _ conversation.Scope, reference string) (conversation.ArtifactContent, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.artifactReads++
	n.artifactRef = reference
	return conversation.ArtifactContent{Data: []byte("pdf"), MimeType: "application/pdf", Filename: "Report.pdf"}, nil
}

func auth(t *testing.T) *invite.Auth {
	t.Helper()
	key := base64.RawURLEncoding.EncodeToString(bytesRepeat('k', 32))
	a, err := invite.New(key, "https://guest.example")
	if err != nil {
		t.Fatal(err)
	}
	return a
}
func bytesRepeat(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}
func claims() invite.Claims {
	now := time.Now()
	return invite.Claims{Version: 1, Issuer: "aos-invite", Audience: "https://guest.example", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(), Agent: "interviewer", Ref: "john", FirstTurn: &invite.FirstTurn{Prefill: "Hey, Almog sent me here!", Instruction: "Load the /interview skill for John."}}
}
func setup(t *testing.T) (http.Handler, *invite.Auth, invite.Claims, *native) {
	t.Helper()
	a := auth(t)
	c := claims()
	n := &native{}
	return server.NewGuest(a, n, ""), a, c, n
}
func request(t *testing.T, h http.Handler, a *invite.Auth, c invite.Claims, method, path, body string, scope bool) *httptest.ResponseRecorder {
	t.Helper()
	token, err := a.Encrypt(c)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Origin", a.Origin())
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(&http.Cookie{Name: "__Host-aos-invite", Value: token})
	if scope {
		r.Header.Set("X-AOS-Conversation", c.ConversationKey())
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestRedeemReturnsNewPrefillButNeverInstruction(t *testing.T) {
	h, a, c, _ := setup(t)
	token, _ := a.Encrypt(c)
	r := httptest.NewRequest("POST", "/api/guest/redeem", strings.NewReader(`{"token":"`+token+`"}`))
	r.Header.Set("Origin", a.Origin())
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"state":"new"`) || !strings.Contains(w.Body.String(), "Almog") || strings.Contains(w.Body.String(), "interview skill") {
		t.Fatalf("unsafe bootstrap: %d %s", w.Code, w.Body)
	}
	if cookie := w.Header().Get("Set-Cookie"); !strings.Contains(cookie, "Secure") || !strings.Contains(cookie, "HttpOnly") || !strings.Contains(cookie, "SameSite=Strict") {
		t.Fatalf("unsafe cookie: %s", cookie)
	}
}

func TestGuestRejectsAnonymousAndWrongConversation(t *testing.T) {
	h, a, c, _ := setup(t)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/guest/history", nil))
	if w.Code != 401 {
		t.Fatalf("anonymous=%d", w.Code)
	}
	w = request(t, h, a, c, "POST", "/api/guest/send", `{"content":[{"type":"text","text":"Hi"}]}`, false)
	if w.Code != 409 {
		t.Fatalf("unbound=%d %s", w.Code, w.Body)
	}
	w = request(t, h, a, c, "GET", "/api/guest/bootstrap", "", false)
	if w.Code != 200 {
		t.Fatalf("bootstrap=%d %s", w.Code, w.Body)
	}
	var b struct{ Conversation string }
	if json.Unmarshal(w.Body.Bytes(), &b) != nil || b.Conversation != c.ConversationKey() {
		t.Fatalf("bootstrap=%s", w.Body)
	}
}

func TestFirstSendInjectsOnceAndReadsNeverCreate(t *testing.T) {
	h, a, c, n := setup(t)
	for _, path := range []string{"/api/guest/bootstrap", "/api/guest/history"} {
		if w := request(t, h, a, c, "GET", path, "", true); w.Code != 200 {
			t.Fatalf("read %s=%d", path, w.Code)
		}
	}
	if n.sends != 0 {
		t.Fatal("read submitted a message")
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := request(t, h, a, c, "POST", "/api/guest/send", `{"content":[{"type":"text","text":"Hello"}]}`, true)
			if w.Code != 202 {
				t.Errorf("send=%d %s", w.Code, w.Body)
			}
		}()
	}
	wg.Wait()
	if n.sends != 4 || n.firstTurns != 1 {
		t.Fatalf("sends=%d firstTurns=%d", n.sends, n.firstTurns)
	}
}

func TestHistoryFiltersInternalsAndUnsafeCommands(t *testing.T) {
	h, a, c, n := setup(t)
	n.state = conversation.StatusExisting
	n.history = conversation.Snapshot{Messages: []conversation.Message{{ID: "sys", Role: "system", Content: []conversation.Part{{Type: "text", Text: "secret-system"}}}, {ID: "a", Role: "assistant", Content: []conversation.Part{{Type: "reasoning", Text: "secret-reasoning"}, {Type: "tool", Text: "secret-tool"}, {Type: "text", Text: "Welcome"}}}}}
	w := request(t, h, a, c, "GET", "/api/guest/history", "", true)
	if w.Code != 200 || strings.Contains(w.Body.String(), "secret") || !strings.Contains(w.Body.String(), "Welcome") {
		t.Fatalf("unsafe projection: %s", w.Body)
	}
	for _, body := range []string{`{"content":[{"type":"text","text":"/model other"}]}`, `{"content":[{"type":"file","url":"file:///etc/passwd","mime":"text/plain"}]}`} {
		w = request(t, h, a, c, "POST", "/api/guest/send", body, true)
		if w.Code != 400 {
			t.Fatalf("unsafe send=%d %s", w.Code, w.Body)
		}
	}
}

func TestHistoryPreservesSafeBranchAndDisplayProjection(t *testing.T) {
	h, a, c, n := setup(t)
	n.state = conversation.StatusExisting
	n.history = conversation.Snapshot{Branches: map[string][]string{"root": {"user", "answer"}}, Messages: []conversation.Message{
		{ID: "user", Role: "user", Content: []conversation.Part{{Type: "text", Text: "Show me"}}},
		{ID: "answer", ParentID: "user", Role: "assistant", Content: []conversation.Part{
			{Type: "display", Display: &conversation.Display{ID: "chart-1", Kind: "chart", Payload: json.RawMessage(`{"args":{"series":[1,2]}}`)}},
			{Type: "display", Display: &conversation.Display{ID: "question-1", Kind: "question", Payload: json.RawMessage(`{"args":{"prompt":"leak"}}`)}},
			{Type: "display", Display: &conversation.Display{ID: "raw", Kind: "tool", Payload: json.RawMessage(`{"secret":true}`)}},
		}},
	}}
	w := request(t, h, a, c, "GET", "/api/guest/history", "", true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"parentId":"user"`) || !strings.Contains(w.Body.String(), `"kind":"chart"`) || !strings.Contains(w.Body.String(), `"branches"`) {
		t.Fatalf("missing safe projection: %s", w.Body)
	}
	if strings.Contains(w.Body.String(), `"kind":"tool"`) || strings.Contains(w.Body.String(), `"kind":"question"`) || strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "leak") {
		t.Fatalf("unsafe display: %s", w.Body)
	}
}

func TestHistoryPublishesArtifactIdentityWithoutItsNativePath(t *testing.T) {
	h, a, c, n := setup(t)
	n.state = conversation.StatusExisting
	n.history = conversation.Snapshot{Messages: []conversation.Message{{
		ID: "answer", Role: "assistant", Content: []conversation.Part{{
			Type:     "artifact",
			Artifact: &conversation.Artifact{ID: "artifact-1", Filename: "Report.pdf", MimeType: "application/pdf", SizeBytes: 42, Source: conversation.ArtifactSource{Type: "provider", Reference: "private/report.pdf"}},
		}},
	}}}

	w := request(t, h, a, c, "GET", "/api/guest/history", "", true)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"id":"artifact-1"`) || !strings.Contains(w.Body.String(), `"reference":"artifact-1"`) {
		t.Fatalf("artifact projection = %d %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), "private/report.pdf") {
		t.Fatalf("native artifact path leaked: %s", w.Body)
	}
}

func TestArtifactDownloadResolvesOnlyAnArtifactPublishedInThisConversation(t *testing.T) {
	h, a, c, n := setup(t)
	n.state = conversation.StatusExisting
	n.history = conversation.Snapshot{Messages: []conversation.Message{{
		ID: "answer", Role: "assistant", Content: []conversation.Part{{
			Type:     "artifact",
			Artifact: &conversation.Artifact{ID: "artifact-1", Filename: "Report.pdf", MimeType: "application/pdf", Source: conversation.ArtifactSource{Type: "provider", Reference: "private/report.pdf"}},
		}},
	}}}

	w := request(t, h, a, c, http.MethodGet, "/api/guest/artifact?id=artifact-1", "", true)
	if w.Code != http.StatusOK || w.Body.String() != "pdf" || w.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("artifact response = %d %q %q", w.Code, w.Header().Get("Content-Type"), w.Body.String())
	}
	if n.artifactReads != 1 || n.artifactRef != "private/report.pdf" {
		t.Fatalf("artifact read = %d %q", n.artifactReads, n.artifactRef)
	}

	w = request(t, h, a, c, http.MethodGet, "/api/guest/artifact?id=not-published", "", true)
	if w.Code != http.StatusForbidden || n.artifactReads != 1 {
		t.Fatalf("unpublished artifact = %d reads=%d", w.Code, n.artifactReads)
	}
}

func TestQuestionResponsesRequireCapabilityAndUseTypedAnswers(t *testing.T) {
	h, a, c, n := setup(t)
	n.state = conversation.StatusExisting
	body := `{"questionId":"question-1","answers":[["Yes"],["Because..."]]}`
	w := request(t, h, a, c, "POST", "/api/guest/question/reply", body, true)
	if w.Code != 422 || n.replies != 0 {
		t.Fatalf("unsupported=%d replies=%d", w.Code, n.replies)
	}
	n.caps.Questions = true
	w = request(t, h, a, c, "POST", "/api/guest/question/reply", body, true)
	if w.Code != 202 || n.replies != 1 || len(n.answers) != 2 || n.answers[1][0] != "Because..." {
		t.Fatalf("reply=%d %s replies=%d answers=%v", w.Code, w.Body, n.replies, n.answers)
	}
	w = request(t, h, a, c, "POST", "/api/guest/question/reply", `{"questionId":"question-1","answers":[[],[]]}`, true)
	if w.Code != 202 || n.replies != 2 || len(n.answers) != 2 || len(n.answers[0]) != 0 || len(n.answers[1]) != 0 {
		t.Fatalf("skipped reply=%d %s replies=%d answers=%v", w.Code, w.Body, n.replies, n.answers)
	}
	w = request(t, h, a, c, "POST", "/api/guest/question/reject", `{"questionId":"question-1"}`, true)
	if w.Code != 202 || n.rejections != 1 {
		t.Fatalf("reject=%d %s rejections=%d", w.Code, w.Body, n.rejections)
	}
	for _, malformed := range []struct {
		path, body string
	}{
		{"/api/guest/question/reply", `{"questionId":"question-1","answers":[]}`},
		{"/api/guest/question/reply", `{"questionId":"question-1","answers":[[""]]}`},
		{"/api/guest/question/reply", `{"questionId":"question-1","answers":[["Yes"]],"sessionID":"native"}`},
		{"/api/guest/question/reject", `{"questionId":"question-1","answers":[["Yes"]]}`},
	} {
		w = request(t, h, a, c, "POST", malformed.path, malformed.body, true)
		if w.Code != 400 {
			t.Fatalf("malformed %s=%d %s", malformed.path, w.Code, w.Body)
		}
	}
	if n.replies != 2 || n.rejections != 1 {
		t.Fatalf("malformed payload reached adapter: replies=%d rejections=%d", n.replies, n.rejections)
	}
}

func TestHistoryProjectsOnlyBoundedTypedQuestions(t *testing.T) {
	h, a, c, n := setup(t)
	n.state = conversation.StatusExisting
	n.history = conversation.Snapshot{
		Messages: []conversation.Message{},
		PendingQuestions: []conversation.PendingQuestion{{
			ID: "opaque-question",
			Questions: []conversation.Question{{
				Header: "Topic", Question: "Continue?", Multiple: true, Custom: true,
				Options: []conversation.QuestionOption{{Label: "Yes", Description: "Keep going"}},
			}},
		}, {
			ID:        strings.Repeat("x", 300),
			Questions: []conversation.Question{{Header: "unsafe", Question: "must be filtered"}},
		}},
	}
	w := request(t, h, a, c, "GET", "/api/guest/history", "", true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "opaque-question") || !strings.Contains(w.Body.String(), "Continue?") || strings.Contains(w.Body.String(), "must be filtered") {
		t.Fatalf("unsafe question projection: %s", w.Body)
	}
}

func TestIdleEventObservationDoesNotPollFullHistoryWithoutAProviderChange(t *testing.T) {
	h, a, c, n := setup(t)
	n.state = conversation.StatusExisting
	ctx, cancel := context.WithTimeout(context.Background(), 3200*time.Millisecond)
	defer cancel()
	token, _ := a.Encrypt(c)
	r := httptest.NewRequest("GET", "/api/guest/events?conversation="+c.ConversationKey(), nil).WithContext(ctx)
	r.AddCookie(&http.Cookie{Name: "__Host-aos-invite", Value: token})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if n.historyCalls > 1 {
		t.Fatalf("idle stream downloaded full history %d times without a provider change", n.historyCalls)
	}
}

func TestEventObservationReloadsHistoryAfterAProviderChange(t *testing.T) {
	h, a, c, n := setup(t)
	n.state = conversation.StatusExisting
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	token, _ := a.Encrypt(c)
	r := httptest.NewRequest("GET", "/api/guest/events?conversation="+c.ConversationKey(), nil).WithContext(ctx)
	r.AddCookie(&http.Cookie{Name: "__Host-aos-invite", Value: token})
	done := make(chan struct{})
	go func() {
		h.ServeHTTP(httptest.NewRecorder(), r)
		close(done)
	}()

	deadline := time.Now().Add(time.Second)
	for {
		n.mu.Lock()
		calls := n.historyCalls
		observations := n.observations
		n.mu.Unlock()
		if calls == 1 && observations != nil {
			observations <- conversation.Observation{}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("event stream did not load its initial history")
		}
		time.Sleep(time.Millisecond)
	}
	for {
		n.mu.Lock()
		calls := n.historyCalls
		n.mu.Unlock()
		if calls == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("provider notification did not reload history; calls=%d", calls)
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done
}
