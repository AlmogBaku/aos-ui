package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"

	"aosui/gateway/conversation"
	"aosui/gateway/invite"
)

type lockEntry struct {
	token chan struct{}
	refs  int
}
type keyedLocks struct {
	mu      sync.Mutex
	entries map[string]*lockEntry
}

func (l *keyedLocks) acquire(ctx context.Context, key string) (func(), error) {
	l.mu.Lock()
	if l.entries == nil {
		l.entries = map[string]*lockEntry{}
	}
	e := l.entries[key]
	if e == nil {
		e = &lockEntry{token: make(chan struct{}, 1)}
		e.token <- struct{}{}
		l.entries[key] = e
	}
	e.refs++
	l.mu.Unlock()
	releaseRef := func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		e.refs--
		if e.refs == 0 {
			delete(l.entries, key)
		}
	}
	select {
	case <-ctx.Done():
		releaseRef()
		return nil, ctx.Err()
	case <-e.token:
		return func() { e.token <- struct{}{}; releaseRef() }, nil
	}
}

func (g *Guest) snapshot(ctx context.Context, c invite.Claims) (conversation.Snapshot, error) {
	state, err := g.adapter.State(ctx, c.Scope())
	if err != nil {
		return conversation.Snapshot{}, err
	}
	if state.Status == conversation.StatusNew {
		return conversation.Snapshot{Messages: []conversation.Message{}}, nil
	}
	snap, err := g.adapter.History(ctx, c.Scope())
	if err != nil {
		return snap, err
	}
	return project(snap), nil
}

// Event observation is shared briefly across tabs for the same invitation
// scope. Native providers remain authoritative; this is only an ephemeral
// anti-fanout cache, never a Session registry.
func (g *Guest) eventSnapshot(ctx context.Context, c invite.Claims) (conversation.Snapshot, error) {
	key := c.ConversationKey()
	release, err := g.eventLocks.acquire(ctx, key)
	if err != nil {
		return conversation.Snapshot{}, err
	}
	defer release()
	g.eventMu.Lock()
	cached, ok := g.eventCache[key]
	maxAge := 3 * time.Second
	if cached.snapshot.Running {
		maxAge = 700 * time.Millisecond
	}
	if ok && time.Since(cached.at) < maxAge {
		g.eventMu.Unlock()
		return cached.snapshot, nil
	}
	g.eventMu.Unlock()
	snapshot, err := g.snapshot(ctx, c)
	if err != nil {
		return conversation.Snapshot{}, err
	}
	g.eventMu.Lock()
	g.eventCache[key] = cachedSnapshot{snapshot: snapshot, at: time.Now()}
	g.eventMu.Unlock()
	return snapshot, nil
}

func (g *Guest) invalidateEventSnapshot(key string) {
	g.eventMu.Lock()
	delete(g.eventCache, key)
	g.eventMu.Unlock()
}

func (g *Guest) operation(w http.ResponseWriter, r *http.Request, c invite.Claims) {
	if r.Method == http.MethodGet {
		switch r.URL.Path {
		case "/api/guest/history":
			s, err := g.snapshot(r.Context(), c)
			if err != nil {
				adapterFailure(w, err)
				return
			}
			jsonResponse(w, 200, s)
		case "/api/guest/events":
			g.events(w, r, c)
		case "/api/guest/artifact":
			g.artifact(w, r, c)
		default:
			failure(w, 404, "not-found")
		}
		return
	}
	if r.Method != http.MethodPost {
		failure(w, 405, "method")
		return
	}
	if r.URL.Path == "/api/guest/transcribe" || r.URL.Path == "/api/guest/speech" {
		g.audio(w, r, c)
		return
	}
	switch r.URL.Path {
	case "/api/guest/send", "/api/guest/edit", "/api/guest/regenerate", "/api/guest/stop", "/api/guest/question/reply", "/api/guest/question/reject":
	default:
		failure(w, 404, "not-found")
		return
	}
	var body struct {
		Content    []conversation.Part `json:"content,omitempty"`
		MessageID  string              `json:"messageId,omitempty"`
		QuestionID string              `json:"questionId,omitempty"`
		Answers    [][]string          `json:"answers,omitempty"`
	}
	if decode(w, r, &body) != nil {
		failure(w, 400, "invalid-request")
		return
	}
	isSend := r.URL.Path == "/api/guest/send"
	isEdit := r.URL.Path == "/api/guest/edit"
	isRegen := r.URL.Path == "/api/guest/regenerate"
	isQuestionReply := r.URL.Path == "/api/guest/question/reply"
	isQuestionReject := r.URL.Path == "/api/guest/question/reject"
	if isQuestionReply {
		if !validQuestionID(body.QuestionID) || !validQuestionAnswers(body.Answers) || len(body.Content) > 0 || body.MessageID != "" {
			failure(w, 400, "invalid-request")
			return
		}
	} else if isQuestionReject {
		if !validQuestionID(body.QuestionID) || body.Answers != nil || len(body.Content) > 0 || body.MessageID != "" {
			failure(w, 400, "invalid-request")
			return
		}
	} else if body.QuestionID != "" || body.Answers != nil || ((isSend || isEdit) && !validInput(body.Content)) || (isSend && body.MessageID != "") || ((isEdit || isRegen) && (body.MessageID == "" || len(body.MessageID) > 256)) || (!isSend && !isEdit && len(body.Content) > 0) || (!isSend && !isEdit && !isRegen && body.MessageID != "") {
		failure(w, 400, "invalid-request")
		return
	}
	release, err := g.locks.acquire(r.Context(), c.ConversationKey())
	if err != nil {
		adapterFailure(w, err)
		return
	}
	defer release()
	g.invalidateEventSnapshot(c.ConversationKey())
	caps, err := g.adapter.Capabilities(r.Context(), c.Scope())
	if err != nil {
		adapterFailure(w, err)
		return
	}
	if (isEdit && !caps.Edit) || (isRegen && !caps.Regenerate) || ((isQuestionReply || isQuestionReject) && !caps.Questions) {
		adapterFailure(w, conversation.ErrUnsupported)
		return
	}
	for _, p := range body.Content {
		if p.Type != "text" && !caps.Attachments {
			adapterFailure(w, conversation.ErrUnsupported)
			return
		}
	}
	switch {
	case isSend:
		state, stateErr := g.adapter.State(r.Context(), c.Scope())
		if stateErr != nil {
			adapterFailure(w, stateErr)
			return
		}
		input := conversation.SendInput{Content: body.Content}
		if state.Status == conversation.StatusNew && c.FirstTurn != nil && c.FirstTurn.Instruction != "" {
			input.FirstTurn = &conversation.FirstTurn{Instruction: c.FirstTurn.Instruction}
		}
		err = g.adapter.Send(r.Context(), c.Scope(), input)
	case isEdit, isRegen:
		editor, ok := g.adapter.(conversation.Editor)
		if !ok {
			adapterFailure(w, conversation.ErrUnsupported)
			return
		}
		if isEdit {
			err = editor.Edit(r.Context(), c.Scope(), body.MessageID, conversation.SendInput{Content: body.Content})
		} else {
			err = editor.Regenerate(r.Context(), c.Scope(), body.MessageID)
		}
	case isQuestionReply, isQuestionReject:
		responder, ok := g.adapter.(conversation.QuestionResponder)
		if !ok {
			adapterFailure(w, conversation.ErrUnsupported)
			return
		}
		if isQuestionReply {
			err = responder.ReplyQuestion(r.Context(), c.Scope(), body.QuestionID, body.Answers)
		} else {
			err = responder.RejectQuestion(r.Context(), c.Scope(), body.QuestionID)
		}
	default:
		err = g.adapter.Stop(r.Context(), c.Scope())
	}
	if err != nil {
		adapterFailure(w, err)
		return
	}
	jsonResponse(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func (g *Guest) artifact(w http.ResponseWriter, r *http.Request, c invite.Claims) {
	id := r.URL.Query().Get("id")
	if id == "" || len(id) > 256 {
		failure(w, http.StatusBadRequest, "invalid-request")
		return
	}
	snapshot, err := g.adapter.History(r.Context(), c.Scope())
	if err != nil {
		adapterFailure(w, err)
		return
	}
	var published *conversation.Artifact
	for _, message := range snapshot.Messages {
		for _, part := range message.Content {
			if part.Type == "artifact" && part.Artifact != nil && part.Artifact.ID == id && safeArtifact(part.Artifact) {
				published = part.Artifact
			}
		}
	}
	if published == nil || published.Source.Type != "provider" {
		failure(w, http.StatusForbidden, "forbidden")
		return
	}
	reader, ok := g.adapter.(conversation.ArtifactReader)
	if !ok {
		adapterFailure(w, conversation.ErrUnsupported)
		return
	}
	content, err := reader.ReadArtifact(r.Context(), c.Scope(), published.Source.Reference)
	if err != nil {
		adapterFailure(w, err)
		return
	}
	if len(content.Data) == 0 || len(content.Data) > 25*1024*1024 {
		adapterFailure(w, conversation.ErrUnavailable)
		return
	}
	contentType := content.MimeType
	if contentType == "" {
		contentType = published.MimeType
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	filename := content.Filename
	if filename == "" {
		filename = published.Filename
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": filename}))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content.Data)
}

func validQuestionID(id string) bool {
	if id == "" || len(id) > 256 {
		return false
	}
	for _, r := range id {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}

func validQuestionAnswers(answers [][]string) bool {
	if len(answers) == 0 || len(answers) > 16 {
		return false
	}
	for _, answer := range answers {
		if len(answer) > 33 {
			return false
		}
		for _, value := range answer {
			if strings.TrimSpace(value) == "" || len(value) > 4*1024 || strings.ContainsRune(value, 0) {
				return false
			}
		}
	}
	return true
}

func validInput(parts []conversation.Part) bool {
	if len(parts) == 0 || len(parts) > 24 {
		return false
	}
	hasContent := false
	for _, p := range parts {
		switch p.Type {
		case "text":
			if len(p.Text) > 256*1024 || p.URL != "" || p.Mime != "" || p.Filename != "" {
				return false
			}
			// Guest send never invokes a native slash command, including model changes.
			if strings.HasPrefix(strings.TrimSpace(p.Text), "/") {
				return false
			}
			hasContent = hasContent || strings.TrimSpace(p.Text) != ""
		case "image", "file":
			if !safeData(p) || p.Text != "" {
				return false
			}
			hasContent = true
		default:
			return false
		}
	}
	return hasContent
}

func safeData(p conversation.Part) bool {
	if len(p.Filename) > 256 || strings.ContainsAny(p.Filename, "/\\\x00\r\n") || len(p.URL) > 7*1024*1024 {
		return false
	}
	allowed := map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "application/pdf": true, "application/json": true, "text/plain": true, "text/markdown": true, "text/csv": true, "application/octet-stream": true, "audio/mpeg": true, "audio/ogg": true, "audio/wav": true, "audio/webm": true, "audio/mp4": true}
	if !allowed[p.Mime] || (p.Type == "image" && !strings.HasPrefix(p.Mime, "image/")) {
		return false
	}
	prefix := "data:" + p.Mime + ";base64,"
	if !strings.HasPrefix(p.URL, prefix) {
		return false
	}
	b, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(p.URL, prefix))
	return err == nil && len(b) > 0 && len(b) <= 5*1024*1024
}

// Defense in depth: even a mistaken native projection cannot publish unknown
// roles/parts. Model text itself is not secret-redacted and is not a sandbox.
func project(s conversation.Snapshot) conversation.Snapshot {
	out := conversation.Snapshot{Running: s.Running, Messages: []conversation.Message{}}
	kept := map[string]bool{}
	for _, m := range s.Messages {
		if m.Role != "user" && m.Role != "assistant" {
			continue
		}
		parts := []conversation.Part{}
		for _, p := range m.Content {
			if p.Type == "text" {
				parts = append(parts, conversation.Part{Type: "text", Text: p.Text})
			} else if (p.Type == "image" || p.Type == "file") && safeData(p) {
				parts = append(parts, conversation.Part{Type: p.Type, URL: p.URL, Mime: p.Mime, Filename: p.Filename})
			} else if p.Type == "display" && safeDisplay(p.Display) {
				parts = append(parts, conversation.Part{Type: "display", Display: p.Display})
			} else if p.Type == "artifact" && safeArtifact(p.Artifact) {
				artifact := *p.Artifact
				if artifact.Source.Type == "provider" {
					artifact.Source.Reference = artifact.ID
				}
				parts = append(parts, conversation.Part{Type: "artifact", Artifact: &artifact})
			}
		}
		if len(parts) > 0 {
			out.Messages = append(out.Messages, conversation.Message{ID: m.ID, Role: m.Role, Content: parts, ParentID: m.ParentID})
			kept[m.ID] = true
		}
	}
	for i := range out.Messages {
		if out.Messages[i].ParentID != "" && !kept[out.Messages[i].ParentID] {
			out.Messages[i].ParentID = ""
		}
	}
	for branch, ids := range s.Branches {
		for _, id := range ids {
			if kept[id] {
				if out.Branches == nil {
					out.Branches = map[string][]string{}
				}
				out.Branches[branch] = append(out.Branches[branch], id)
			}
		}
	}
	for _, pending := range s.PendingQuestions {
		if len(out.PendingQuestions) == 32 {
			break
		}
		if safePendingQuestion(pending) {
			out.PendingQuestions = append(out.PendingQuestions, pending)
		}
	}
	return out
}

func safeArtifact(artifact *conversation.Artifact) bool {
	if artifact == nil || artifact.ID == "" || len(artifact.ID) > 256 || artifact.Filename == "" || len(artifact.Filename) > 255 || artifact.SizeBytes < 0 {
		return false
	}
	switch artifact.Source.Type {
	case "provider":
		return artifact.Source.Reference != ""
	case "inline":
		return artifact.Source.Encoding == "base64" && artifact.Source.Data != "" && len(artifact.Source.Data) <= 7*1024*1024
	default:
		return false
	}
}

func safePendingQuestion(pending conversation.PendingQuestion) bool {
	if !validQuestionID(pending.ID) || len(pending.Questions) == 0 || len(pending.Questions) > 16 {
		return false
	}
	for _, question := range pending.Questions {
		if !safeQuestionText(question.Header, 256) || !safeQuestionText(question.Question, 8*1024) || len(question.Options) > 32 {
			return false
		}
		for _, option := range question.Options {
			if !safeQuestionText(option.Label, 1024) || (option.Description != "" && !safeQuestionText(option.Description, 4*1024)) {
				return false
			}
		}
	}
	return true
}

func safeQuestionText(value string, limit int) bool {
	if strings.TrimSpace(value) == "" || len(value) > limit || strings.ContainsRune(value, 0) {
		return false
	}
	for _, r := range value {
		if (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			return false
		}
	}
	return true
}

func safeDisplay(display *conversation.Display) bool {
	if display == nil || display.ID == "" || len(display.ID) > 256 || len(display.Payload) == 0 || len(display.Payload) > 256*1024 || !json.Valid(display.Payload) {
		return false
	}
	switch display.Kind {
	case "chart", "map", "stats", "plan":
	default:
		return false
	}
	var payload struct {
		Args   map[string]json.RawMessage `json:"args"`
		Result json.RawMessage            `json:"result,omitempty"`
	}
	decoder := json.NewDecoder(bytes.NewReader(display.Payload))
	decoder.DisallowUnknownFields()
	return decoder.Decode(&payload) == nil && decoder.Decode(&struct{}{}) == io.EOF && payload.Args != nil
}

func (g *Guest) events(w http.ResponseWriter, r *http.Request, c invite.Claims) {
	defer g.invalidateEventSnapshot(c.ConversationKey())
	if _, ok := w.(http.Flusher); !ok {
		failure(w, 500, "stream-unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	write := func(event string, data []byte) error {
		_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
		_, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		if err != nil {
			return err
		}
		return rc.Flush()
	}
	var observations <-chan conversation.Observation
	if observer, ok := g.adapter.(conversation.Observer); ok {
		var err error
		observations, err = observer.Observe(r.Context(), c.Scope())
		if err != nil {
			_ = write("error", []byte(`{"error":"unavailable"}`))
			return
		}
	}
	var previous []byte
	refresh := true
	var snapshot conversation.Snapshot
	for {
		if r.Context().Err() != nil {
			return
		}
		if time.Now().Unix() >= c.ExpiresAt {
			_ = write("error", []byte(`{"error":"invalid-invite"}`))
			return
		}
		if refresh {
			var err error
			snapshot, err = g.eventSnapshot(r.Context(), c)
			if err != nil {
				_ = write("error", []byte(`{"error":"unavailable"}`))
				return
			}
			b, err := json.Marshal(snapshot)
			if err != nil {
				return
			}
			if !bytes.Equal(previous, b) {
				if write("snapshot", b) != nil {
					return
				}
				previous = b
			}
			refresh = false
		}
		if observations != nil {
			wait := time.Until(time.Unix(c.ExpiresAt, 0))
			if wait > 15*time.Second {
				wait = 15 * time.Second
			}
			timer := time.NewTimer(wait)
			select {
			case <-r.Context().Done():
				if !timer.Stop() {
					<-timer.C
				}
				return
			case observation, ok := <-observations:
				if !timer.Stop() {
					<-timer.C
				}
				if !ok || observation.Err != nil {
					_ = write("error", []byte(`{"error":"unavailable"}`))
					return
				}
				g.invalidateEventSnapshot(c.ConversationKey())
				refresh = true
			case <-timer.C:
				if time.Now().Unix() >= c.ExpiresAt {
					_ = write("error", []byte(`{"error":"invalid-invite"}`))
					return
				}
				if write("ping", []byte(`{}`)) != nil {
					return
				}
			}
			continue
		}
		delay := 3 * time.Second
		if snapshot.Running {
			delay = 750 * time.Millisecond
		}
		timer := time.NewTimer(delay)
		select {
		case <-r.Context().Done():
			if !timer.Stop() {
				<-timer.C
			}
			if errors.Is(r.Context().Err(), context.DeadlineExceeded) {
				_ = write("error", []byte(`{"error":"invalid-invite"}`))
			}
			return
		case <-timer.C:
		}
	}
}

func (g *Guest) audio(w http.ResponseWriter, r *http.Request, c invite.Claims) {
	audio, ok := g.adapter.(conversation.Audio)
	if !ok {
		adapterFailure(w, conversation.ErrUnsupported)
		return
	}
	caps, err := g.adapter.Capabilities(r.Context(), c.Scope())
	if err != nil {
		adapterFailure(w, err)
		return
	}
	if r.URL.Path == "/api/guest/transcribe" {
		if !caps.Transcription {
			adapterFailure(w, conversation.ErrUnsupported)
			return
		}
		mime := strings.Split(r.Header.Get("Content-Type"), ";")[0]
		switch mime {
		case "audio/webm", "video/webm", "audio/ogg", "audio/wav", "audio/mpeg", "audio/mp4", "audio/flac":
		default:
			failure(w, 400, "invalid-recording")
			return
		}
		b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 5*1024*1024))
		if err != nil || len(b) == 0 {
			failure(w, 400, "invalid-recording")
			return
		}
		text, err := audio.Transcribe(r.Context(), c.Scope(), b, mime)
		if err != nil {
			adapterFailure(w, err)
			return
		}
		jsonResponse(w, 200, map[string]string{"text": text})
		return
	}
	if !caps.Speech {
		adapterFailure(w, conversation.ErrUnsupported)
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	if decode(w, r, &body) != nil || strings.TrimSpace(body.Text) == "" || len(body.Text) > 32000 {
		failure(w, 400, "invalid-request")
		return
	}
	b, mime, err := audio.Speech(r.Context(), c.Scope(), body.Text)
	if err != nil {
		adapterFailure(w, err)
		return
	}
	switch mime {
	case "audio/mpeg", "audio/wav", "audio/ogg", "audio/flac":
	default:
		adapterFailure(w, conversation.ErrUnavailable)
		return
	}
	if len(b) > 20*1024*1024 {
		adapterFailure(w, conversation.ErrUnavailable)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.WriteHeader(200)
	_, _ = w.Write(b)
}
