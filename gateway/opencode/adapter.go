// Package opencode adapts OpenCode's native HTTP API to guest conversations.
package opencode

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"aosui/gateway/conversation"
)

const pageSize = 100

var referencePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var initializationIDPattern = regexp.MustCompile(`^msg_aos_[a-f0-9]{32}$`)

const (
	initializationPending  = "pending"
	initializationComplete = "complete"
)

type Config struct {
	BaseURL, Directory, Username, Password string
	HTTPClient                             *http.Client
}

type Adapter struct {
	base                          *url.URL
	directory, username, password string
	client                        *http.Client
	stream                        *http.Client
	locksMu                       sync.Mutex
	locks                         map[string]*sync.Mutex
}

func New(config Config) (*Adapter, error) {
	base, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil || base.Scheme == "" || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" || (base.Scheme != "http" && base.Scheme != "https") {
		return nil, errors.New("invalid OpenCode configuration")
	}
	if strings.TrimSpace(config.Directory) == "" {
		return nil, errors.New("invalid OpenCode configuration")
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	stream := *client
	stream.Timeout = 0
	return &Adapter{
		base:      base,
		directory: config.Directory,
		username:  config.Username,
		password:  config.Password,
		client:    client,
		stream:    &stream,
		locks:     make(map[string]*sync.Mutex),
	}, nil
}

type nativeAgent struct {
	Name, Mode string
	Hidden     bool
}

type nativeSession struct {
	ID       string         `json:"id"`
	Agent    string         `json:"agent"`
	ParentID string         `json:"parentID"`
	Metadata map[string]any `json:"metadata"`
}

func (a *Adapter) Capabilities(ctx context.Context, scope conversation.Scope) (conversation.Capabilities, error) {
	if err := a.verifyScope(ctx, scope); err != nil {
		return conversation.Capabilities{}, err
	}
	return conversation.Capabilities{Attachments: true, Edit: true, Regenerate: true, Questions: true}, nil
}

func validAgent(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func (a *Adapter) State(ctx context.Context, scope conversation.Scope) (conversation.State, error) {
	session, _, err := a.resolve(ctx, scope, false)
	if err != nil {
		return conversation.State{}, err
	}
	if session == nil {
		return conversation.State{Status: conversation.StatusNew}, nil
	}
	initialization, err := parseInitialization(session.Metadata)
	if err != nil {
		return conversation.State{}, err
	}
	if initialization != nil && initialization.State == initializationComplete {
		return conversation.State{Status: conversation.StatusExisting}, nil
	}
	hasMessages, err := a.sessionHasMessages(ctx, session.ID)
	if err != nil {
		return conversation.State{}, err
	}
	if !hasMessages {
		return conversation.State{Status: conversation.StatusNew}, nil
	}
	return conversation.State{Status: conversation.StatusExisting}, nil
}

// resolve is read-only unless create is true. Only Send calls it with create.
func (a *Adapter) resolve(ctx context.Context, scope conversation.Scope, create bool) (*nativeSession, bool, error) {
	if err := a.verifyScope(ctx, scope); err != nil {
		return nil, false, err
	}
	matches, err := a.findByReference(ctx, scope.Ref, scope.Agent)
	if err != nil {
		return nil, false, err
	}
	if len(matches) > 1 {
		return nil, false, conversation.ErrAmbiguous
	}
	if len(matches) == 1 {
		if err := verifySession(matches[0], scope.Agent); err != nil {
			return nil, false, err
		}
		return &matches[0], false, nil
	}
	if !create {
		return nil, false, nil
	}

	body := map[string]any{
		"title": "Guest conversation",
		"agent": scope.Agent,
		"metadata": map[string]any{
			"aos": map[string]any{"externalRef": scope.Ref},
		},
	}
	var session nativeSession
	if err := a.post(ctx, "/session", body, &session); err != nil {
		return nil, false, sendMutationError(err)
	}
	if err := a.verifyCreatedSession(session, scope); err != nil {
		return nil, false, err
	}
	if externalRef(session.Metadata) != scope.Ref {
		metadata := withExternalRef(session.Metadata, scope.Ref)
		if err := a.patch(ctx, "/session/"+url.PathEscape(session.ID), map[string]any{"metadata": metadata}, &session); err != nil {
			return nil, false, sendMutationError(err)
		}
		if err := a.verifyCreatedSession(session, scope); err != nil {
			return nil, false, err
		}
		if externalRef(session.Metadata) != scope.Ref {
			return nil, false, conversation.ErrUnavailable
		}
	}
	if err := verifySession(session, scope.Agent); err != nil {
		return nil, false, err
	}
	return &session, true, nil
}

func (a *Adapter) verifyCreatedSession(session nativeSession, scope conversation.Scope) error {
	if session.ID == "" || session.ParentID != "" || session.Agent != scope.Agent {
		return conversation.ErrForbidden
	}
	return nil
}

func withExternalRef(metadata map[string]any, ref string) map[string]any {
	result := make(map[string]any, len(metadata)+1)
	for key, value := range metadata {
		result[key] = value
	}
	namespace := map[string]any{}
	if existing, ok := metadata["aos"].(map[string]any); ok {
		for key, value := range existing {
			namespace[key] = value
		}
	}
	namespace["externalRef"] = ref
	result["aos"] = namespace
	return result
}

type nativeInitialization struct {
	MessageID string
	State     string
}

func parseInitialization(metadata map[string]any) (*nativeInitialization, error) {
	namespace, _ := metadata["aos"].(map[string]any)
	raw, exists := namespace["initialization"]
	if !exists {
		return nil, nil
	}
	value, ok := raw.(map[string]any)
	if !ok || len(value) != 2 {
		return nil, conversation.ErrUnavailable
	}
	messageID, messageOK := value["messageID"].(string)
	state, stateOK := value["state"].(string)
	if !messageOK || !stateOK || !initializationIDPattern.MatchString(messageID) || (state != initializationPending && state != initializationComplete) {
		return nil, conversation.ErrUnavailable
	}
	return &nativeInitialization{MessageID: messageID, State: state}, nil
}

func initializationIdentity(session nativeSession, scope conversation.Scope) string {
	sum := sha256.Sum256([]byte(session.ID + "\x00" + scope.Agent + "\x00" + scope.Ref))
	return fmt.Sprintf("msg_aos_%x", sum[:16])
}

func withInitialization(metadata map[string]any, initialization nativeInitialization) map[string]any {
	result := make(map[string]any, len(metadata)+1)
	for key, value := range metadata {
		result[key] = value
	}
	namespace := map[string]any{}
	if existing, ok := metadata["aos"].(map[string]any); ok {
		for key, value := range existing {
			namespace[key] = value
		}
	}
	namespace["initialization"] = map[string]any{
		"messageID": initialization.MessageID,
		"state":     initialization.State,
	}
	result["aos"] = namespace
	return result
}

func (a *Adapter) persistInitialization(ctx context.Context, session *nativeSession, scope conversation.Scope, initialization nativeInitialization) error {
	metadata := withInitialization(session.Metadata, initialization)
	var updated nativeSession
	if err := a.patch(ctx, "/session/"+url.PathEscape(session.ID), map[string]any{"metadata": metadata}, &updated); err != nil {
		return sendMutationError(err)
	}
	if err := a.verifyCreatedSession(updated, scope); err != nil {
		return err
	}
	if externalRef(updated.Metadata) != scope.Ref {
		return conversation.ErrUnavailable
	}
	stored, err := parseInitialization(updated.Metadata)
	if err != nil || stored == nil || *stored != initialization {
		return conversation.ErrUnavailable
	}
	*session = updated
	return nil
}

func (a *Adapter) verifyScope(ctx context.Context, scope conversation.Scope) error {
	if !validAgent(scope.Agent) || !referencePattern.MatchString(scope.Ref) {
		return conversation.ErrForbidden
	}
	return a.verifyAgent(ctx, scope.Agent)
}

func (a *Adapter) verifyAgent(ctx context.Context, wanted string) error {
	var agents []nativeAgent
	if err := a.get(ctx, "/agent", nil, &agents); err != nil {
		return err
	}
	for _, agent := range agents {
		if agent.Name == wanted && (agent.Mode == "primary" || agent.Mode == "all") && !agent.Hidden {
			return nil
		}
	}
	return conversation.ErrForbidden
}

func (a *Adapter) findByReference(ctx context.Context, ref, agent string) ([]nativeSession, error) {
	var matches []nativeSession
	var cursor string
	seen := map[string]bool{}
	for {
		var page []nativeSession
		query := url.Values{"roots": {"true"}, "archived": {"true"}, "limit": {fmt.Sprint(pageSize)}}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		next, err := a.getPage(ctx, "/experimental/session", query, &page)
		if err != nil {
			return nil, err
		}
		for _, candidate := range page {
			if candidate.ParentID == "" && candidate.Agent == agent && externalRef(candidate.Metadata) == ref {
				matches = append(matches, candidate)
			}
		}
		if next == "" {
			return matches, nil
		}
		if seen[next] {
			return nil, conversation.ErrUnavailable
		}
		if _, err := strconv.ParseUint(next, 10, 64); err != nil {
			return nil, conversation.ErrUnavailable
		}
		seen[next] = true
		cursor = next
	}
}

func externalRef(metadata map[string]any) string {
	namespace, _ := metadata["aos"].(map[string]any)
	value, _ := namespace["externalRef"].(string)
	return value
}

func verifySession(session nativeSession, agent string) error {
	if session.ID == "" || session.ParentID != "" || session.Agent != agent {
		return conversation.ErrForbidden
	}
	return nil
}

type nativePart struct {
	Type     string `json:"type"`
	Text     string `json:"text"`
	URL      string `json:"url"`
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
	ID       string `json:"id"`
	Tool     string `json:"tool"`
	State    struct {
		Status   string          `json:"status"`
		Input    json.RawMessage `json:"input"`
		Metadata struct {
			AOSUI struct {
				Kind      string `json:"kind"`
				ID        string `json:"id"`
				Filename  string `json:"filename"`
				MimeType  string `json:"mimeType"`
				SizeBytes int64  `json:"sizeBytes"`
			} `json:"aos_ui"`
		} `json:"metadata"`
		Attachments []struct {
			Type     string `json:"type"`
			Filename string `json:"filename"`
			Mime     string `json:"mime"`
			URL      string `json:"url"`
		} `json:"attachments"`
	} `json:"state"`
}

type nativeMessage struct {
	Info struct {
		ID   string `json:"id"`
		Role string `json:"role"`
	} `json:"info"`
	Parts []nativePart `json:"parts"`
}

func (a *Adapter) sessionHasMessages(ctx context.Context, sessionID string) (bool, error) {
	var messages []nativeMessage
	if err := a.get(ctx, "/session/"+url.PathEscape(sessionID)+"/message", nil, &messages); err != nil {
		return false, err
	}
	return len(messages) != 0, nil
}

func projectNativeMessage(message nativeMessage) (conversation.Message, bool) {
	if message.Info.Role != "user" && message.Info.Role != "assistant" {
		return conversation.Message{}, false
	}
	projected := conversation.Message{ID: message.Info.ID, Role: message.Info.Role}
	for _, part := range message.Parts {
		switch part.Type {
		case "text":
			if part.Text != "" {
				projected.Content = append(projected.Content, conversation.Part{Type: "text", Text: part.Text})
			}
		case "file":
			if validNativeFile(part.URL, part.Mime, part.Filename) {
				partType := "file"
				if strings.HasPrefix(part.Mime, "image/") {
					partType = "image"
				}
				projected.Content = append(projected.Content, conversation.Part{Type: partType, URL: part.URL, Filename: part.Filename, Mime: part.Mime})
			}
		case "tool":
			if display := projectDisplay(part.ID, part.Tool, part.State.Status, part.State.Input); display != nil {
				projected.Content = append(projected.Content, conversation.Part{Type: "display", Display: display})
			}
			if artifact := projectArtifact(part); artifact != nil {
				projected.Content = append(projected.Content, conversation.Part{Type: "artifact", Artifact: artifact})
			}
		}
	}
	return projected, len(projected.Content) != 0
}

func projectArtifact(part nativePart) *conversation.Artifact {
	metadata := part.State.Metadata.AOSUI
	if part.Tool != "present_artifact" || part.State.Status != "completed" || metadata.Kind != "artifact" || metadata.ID == "" || len(metadata.ID) > 256 || metadata.Filename == "" || len(metadata.Filename) > 255 || metadata.SizeBytes < 0 {
		return nil
	}
	for _, attachment := range part.State.Attachments {
		if attachment.Type != "file" || attachment.Filename != metadata.Filename || attachment.Mime == "" || attachment.Mime != metadata.MimeType {
			continue
		}
		prefix := "data:" + attachment.Mime + ";base64,"
		if !strings.HasPrefix(attachment.URL, prefix) {
			continue
		}
		encoded := strings.TrimPrefix(attachment.URL, prefix)
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(data) == 0 || len(data) > 25*1024*1024 || int64(len(data)) != metadata.SizeBytes {
			continue
		}
		return &conversation.Artifact{ID: metadata.ID, Filename: metadata.Filename, MimeType: metadata.MimeType, SizeBytes: metadata.SizeBytes, Source: conversation.ArtifactSource{Type: "inline", Encoding: "base64", Data: encoded}}
	}
	return nil
}

func replayableUserParts(message nativeMessage) []map[string]any {
	if message.Info.Role != "user" {
		return nil
	}
	parts := make([]map[string]any, 0, len(message.Parts))
	for _, part := range message.Parts {
		switch part.Type {
		case "text":
			if part.Text != "" {
				parts = append(parts, map[string]any{"type": "text", "text": part.Text})
			}
		case "file":
			if validNativeFile(part.URL, part.Mime, part.Filename) {
				parts = append(parts, map[string]any{"type": "file", "mime": part.Mime, "filename": part.Filename, "url": part.URL})
			}
		}
	}
	return parts
}

func (a *Adapter) scopedUserMessageParts(ctx context.Context, sessionID, messageID string) ([]map[string]any, bool, error) {
	var messages []nativeMessage
	if err := a.get(ctx, "/session/"+url.PathEscape(sessionID)+"/message", nil, &messages); err != nil {
		return nil, false, err
	}
	for _, message := range messages {
		if message.Info.ID == messageID {
			parts := replayableUserParts(message)
			return parts, len(parts) != 0, nil
		}
	}
	return nil, false, nil
}

func (a *Adapter) History(ctx context.Context, scope conversation.Scope) (conversation.Snapshot, error) {
	session, _, err := a.resolve(ctx, scope, false)
	if err != nil {
		return conversation.Snapshot{}, err
	}
	if session == nil {
		return conversation.Snapshot{Messages: []conversation.Message{}}, nil
	}
	var messages []nativeMessage
	if err := a.get(ctx, "/session/"+url.PathEscape(session.ID)+"/message", nil, &messages); err != nil {
		return conversation.Snapshot{}, err
	}
	result := conversation.Snapshot{Messages: make([]conversation.Message, 0, len(messages))}
	for _, message := range messages {
		if projected, visible := projectNativeMessage(message); visible {
			result.Messages = append(result.Messages, projected)
		}
	}
	var statuses map[string]struct {
		Type string `json:"type"`
	}
	if err := a.get(ctx, "/session/status", nil, &statuses); err != nil {
		return conversation.Snapshot{}, err
	}
	status := statuses[session.ID].Type
	result.Running = status == "busy" || status == "retry"
	questions, err := a.listQuestions(ctx)
	if err != nil {
		return conversation.Snapshot{}, err
	}
	result.PendingQuestions = projectQuestions(scope, session.ID, questions)
	return result, nil
}

func (a *Adapter) Send(ctx context.Context, scope conversation.Scope, input conversation.SendInput) error {
	parts, err := toNativeParts(input.Content)
	if err != nil {
		return err
	}
	unlock := a.lockScope(scope)
	defer unlock()
	session, created, err := a.resolve(ctx, scope, true)
	if err != nil {
		return err
	}
	initialization, err := parseInitialization(session.Metadata)
	if err != nil {
		return err
	}
	hasMessages := false
	if !created && (initialization == nil || initialization.State != initializationComplete) {
		hasMessages, err = a.sessionHasMessages(ctx, session.ID)
		if err != nil {
			return err
		}
	}
	uninitialized := !hasMessages && (initialization == nil || initialization.State == initializationPending)
	if uninitialized && initialization == nil {
		initialization = &nativeInitialization{MessageID: initializationIdentity(*session, scope), State: initializationPending}
		if err := a.persistInitialization(ctx, session, scope, *initialization); err != nil {
			return err
		}
	}
	if !uninitialized && initialization != nil && initialization.State == initializationPending {
		initialization.State = initializationComplete
		if err := a.persistInitialization(ctx, session, scope, *initialization); err != nil {
			return err
		}
	}
	body := map[string]any{"agent": scope.Agent, "parts": parts}
	if uninitialized {
		body["messageID"] = initialization.MessageID
		if input.FirstTurn != nil && input.FirstTurn.Instruction != "" {
			body["system"] = input.FirstTurn.Instruction
		}
	}
	if err := a.post(ctx, "/session/"+url.PathEscape(session.ID)+"/prompt_async", body, nil); err != nil {
		return sendMutationError(err)
	}
	if uninitialized {
		initialization.State = initializationComplete
		if err := a.persistInitialization(ctx, session, scope, *initialization); err != nil {
			return err
		}
	}
	return nil
}

func (a *Adapter) lockScope(scope conversation.Scope) func() {
	key := scope.Agent + "\x00" + scope.Ref
	a.locksMu.Lock()
	lock := a.locks[key]
	if lock == nil {
		lock = &sync.Mutex{}
		a.locks[key] = lock
	}
	a.locksMu.Unlock()
	lock.Lock()
	return lock.Unlock
}

func sendMutationError(err error) error {
	var responseErr *nativeResponseError
	if errors.As(err, &responseErr) {
		switch responseErr.status {
		case http.StatusBadRequest,
			http.StatusUnauthorized,
			http.StatusForbidden,
			http.StatusNotFound,
			http.StatusConflict,
			http.StatusUnprocessableEntity:
			return responseErr.cause
		default:
			return conversation.ErrUncertain
		}
	}
	return conversation.ErrUncertain
}

func toNativeParts(content []conversation.Part) ([]map[string]any, error) {
	parts := make([]map[string]any, 0, len(content))
	for _, part := range content {
		switch part.Type {
		case "text":
			if part.Text != "" {
				parts = append(parts, map[string]any{"type": "text", "text": part.Text})
			}
		case "image", "file":
			if !validNativeFile(part.URL, part.Mime, part.Filename) {
				return nil, conversation.ErrForbidden
			}
			parts = append(parts, map[string]any{"type": "file", "mime": part.Mime, "filename": part.Filename, "url": part.URL})
		default:
			return nil, conversation.ErrUnsupported
		}
	}
	if len(parts) == 0 {
		return nil, conversation.ErrUnsupported
	}
	return parts, nil
}

func validNativeFile(value, mime, filename string) bool {
	if len(filename) > 256 || strings.ContainsAny(filename, "/\\\x00\r\n") {
		return false
	}
	allowed := map[string]bool{
		"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
		"application/pdf": true, "text/plain": true, "text/markdown": true, "text/csv": true,
		"application/json": true, "application/octet-stream": true,
		"audio/mpeg": true, "audio/ogg": true, "audio/wav": true, "audio/webm": true, "audio/mp4": true,
	}
	if !allowed[mime] || !strings.HasPrefix(value, "data:"+mime+";base64,") {
		return false
	}
	comma := strings.IndexByte(value, ',')
	if comma < 0 {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(value[comma+1:])
	return err == nil && len(decoded) > 0 && len(decoded) <= 5<<20
}

func (a *Adapter) Stop(ctx context.Context, scope conversation.Scope) error {
	session, _, err := a.resolve(ctx, scope, false)
	if err != nil {
		return err
	}
	if session == nil {
		return conversation.ErrUnavailable
	}
	if err := a.post(ctx, "/session/"+url.PathEscape(session.ID)+"/abort", nil, nil); err != nil {
		return sendMutationError(err)
	}
	return nil
}

func (a *Adapter) Edit(ctx context.Context, scope conversation.Scope, messageID string, input conversation.SendInput) error {
	if !referencePattern.MatchString(messageID) {
		return conversation.ErrForbidden
	}
	parts, err := toNativeParts(input.Content)
	if err != nil {
		return err
	}
	unlock := a.lockScope(scope)
	defer unlock()
	session, _, err := a.resolve(ctx, scope, false)
	if err != nil {
		return err
	}
	if session == nil {
		return conversation.ErrUnavailable
	}
	_, owned, err := a.scopedUserMessageParts(ctx, session.ID, messageID)
	if err != nil {
		return err
	}
	if !owned {
		return conversation.ErrForbidden
	}
	if err := a.post(ctx, "/session/"+url.PathEscape(session.ID)+"/revert", map[string]any{"messageID": messageID}, nil); err != nil {
		return sendMutationError(err)
	}
	body := map[string]any{"agent": scope.Agent, "parts": parts}
	if err := a.post(ctx, "/session/"+url.PathEscape(session.ID)+"/prompt_async", body, nil); err != nil {
		// Revert already changed native history; replay failure leaves the
		// resulting state uncertain regardless of the upstream status class.
		return conversation.ErrUncertain
	}
	return nil
}

func (a *Adapter) Regenerate(ctx context.Context, scope conversation.Scope, messageID string) error {
	if !referencePattern.MatchString(messageID) {
		return conversation.ErrForbidden
	}
	unlock := a.lockScope(scope)
	defer unlock()
	session, _, err := a.resolve(ctx, scope, false)
	if err != nil {
		return err
	}
	if session == nil {
		return conversation.ErrUnavailable
	}
	parts, owned, err := a.scopedUserMessageParts(ctx, session.ID, messageID)
	if err != nil {
		return err
	}
	if !owned {
		return conversation.ErrForbidden
	}
	if err := a.post(ctx, "/session/"+url.PathEscape(session.ID)+"/abort", nil, nil); err != nil {
		return sendMutationError(err)
	}
	if err := a.post(ctx, "/session/"+url.PathEscape(session.ID)+"/revert", map[string]any{"messageID": messageID}, nil); err != nil {
		return sendMutationError(err)
	}
	body := map[string]any{"agent": scope.Agent, "parts": parts}
	if err := a.post(ctx, "/session/"+url.PathEscape(session.ID)+"/prompt_async", body, nil); err != nil {
		return conversation.ErrUncertain
	}
	return nil
}

func (a *Adapter) endpoint(path string, query url.Values) string {
	u := *a.base
	u.Path = strings.TrimRight(a.base.Path, "/") + path
	query2 := url.Values{"directory": {a.directory}}
	for key, values := range query {
		query2[key] = values
	}
	u.RawQuery = query2.Encode()
	return u.String()
}

func (a *Adapter) request(ctx context.Context, method, path string, query url.Values, body, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return conversation.ErrUnavailable
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.endpoint(path, query), reader)
	if err != nil {
		return conversation.ErrUnavailable
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if a.username != "" || a.password != "" {
		req.SetBasicAuth(a.username, a.password)
	}
	response, err := a.client.Do(req)
	if err != nil {
		return conversation.ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, response.Body)
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			return &nativeResponseError{status: response.StatusCode, cause: conversation.ErrForbidden}
		}
		return &nativeResponseError{status: response.StatusCode, cause: conversation.ErrUnavailable}
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	if err := json.NewDecoder(response.Body).Decode(out); err != nil {
		return conversation.ErrUnavailable
	}
	return nil
}

func (a *Adapter) get(ctx context.Context, path string, query url.Values, out any) error {
	return a.request(ctx, http.MethodGet, path, query, nil, out)
}

func (a *Adapter) getPage(ctx context.Context, path string, query url.Values, out any) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.endpoint(path, query), nil)
	if err != nil {
		return "", conversation.ErrUnavailable
	}
	if a.username != "" || a.password != "" {
		req.SetBasicAuth(a.username, a.password)
	}
	response, err := a.client.Do(req)
	if err != nil {
		return "", conversation.ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, response.Body)
		return "", conversation.ErrUnavailable
	}
	if err := json.NewDecoder(response.Body).Decode(out); err != nil {
		return "", conversation.ErrUnavailable
	}
	return strings.TrimSpace(response.Header.Get("X-Next-Cursor")), nil
}

func (a *Adapter) post(ctx context.Context, path string, body, out any) error {
	return a.request(ctx, http.MethodPost, path, nil, body, out)
}

func (a *Adapter) patch(ctx context.Context, path string, body, out any) error {
	return a.request(ctx, http.MethodPatch, path, nil, body, out)
}

type nativeResponseError struct {
	status int
	cause  error
}

func (e *nativeResponseError) Error() string { return e.cause.Error() }
func (e *nativeResponseError) Unwrap() error { return e.cause }

var _ conversation.Adapter = (*Adapter)(nil)
var _ conversation.Editor = (*Adapter)(nil)
