// Package hermes adapts the native Hermes HTTP and WebSocket APIs to the
// provider-neutral guest conversation contract.
package hermes

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"

	"aosui/gateway/conversation"
	"github.com/coder/websocket"
)

const maxAudioBytes = 5 << 20

var refPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var recordingMIME = regexp.MustCompile(`^audio/(?:aac|flac|m4a|mp3|mp4|mpeg|ogg|wav|wave|webm|x-m4a|x-wav)(?:;[^,\r\n]+)*$`)
var speechMIME = regexp.MustCompile(`^audio/(?:mpeg|ogg|wav|flac)$`)
var errRPCOutcomeUncertain = errors.New("Hermes RPC outcome uncertain")

type Config struct {
	BaseURL    string
	Token      string
	HTTPClient *http.Client
}

type Adapter struct {
	base      *url.URL
	token     string
	http      *http.Client
	mu        sync.Mutex
	states    map[string]*sessionState
	sendLocks map[string]*sync.Mutex
	observers atomic.Uint64
}

type sessionState struct {
	profile, storedID, liveID string
	running                   bool
	uncertain                 bool
	partialID, partialText    string
	watchCancel               context.CancelFunc
	watching                  bool
	watchGeneration           uint64
	subscribers               map[uint64]chan conversation.Observation
}

var _ conversation.Adapter = (*Adapter)(nil)
var _ conversation.Audio = (*Adapter)(nil)
var _ conversation.Observer = (*Adapter)(nil)
var _ conversation.ArtifactReader = (*Adapter)(nil)

func New(cfg Config) (*Adapter, error) {
	base, err := url.Parse(strings.TrimSuffix(cfg.BaseURL, "/"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || strings.TrimSpace(cfg.Token) == "" {
		return nil, errors.New("invalid Hermes configuration")
	}
	client := cfg.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	return &Adapter{
		base:      base,
		token:     cfg.Token,
		http:      client,
		states:    make(map[string]*sessionState),
		sendLocks: make(map[string]*sync.Mutex),
	}, nil
}

func validAgent(agent string) bool {
	if agent == "" || len(agent) > 128 {
		return false
	}
	for _, r := range agent {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func validScope(scope conversation.Scope) bool {
	return validAgent(scope.Agent) && refPattern.MatchString(scope.Ref)
}

func titleFor(scope conversation.Scope) string { return "aos-invite:" + scope.Ref }

func scopeKey(scope conversation.Scope) string { return scope.Agent + "\x00" + scope.Ref }

func (a *Adapter) Capabilities(ctx context.Context, scope conversation.Scope) (conversation.Capabilities, error) {
	if !validScope(scope) {
		return conversation.Capabilities{}, conversation.ErrForbidden
	}
	stt := a.audioAvailable(ctx, scope.Agent, "stt")
	tts := a.audioAvailable(ctx, scope.Agent, "tts")
	return conversation.Capabilities{Transcription: stt, Speech: tts}, nil
}

func (a *Adapter) stateFor(scope conversation.Scope) *sessionState {
	a.mu.Lock()
	defer a.mu.Unlock()
	k := scopeKey(scope)
	state := a.states[k]
	if state == nil {
		state = &sessionState{profile: scope.Agent, subscribers: make(map[uint64]chan conversation.Observation)}
		a.states[k] = state
	}
	return state
}

func (a *Adapter) sendLock(scope conversation.Scope) *sync.Mutex {
	a.mu.Lock()
	defer a.mu.Unlock()
	k := scopeKey(scope)
	lock := a.sendLocks[k]
	if lock == nil {
		lock = &sync.Mutex{}
		a.sendLocks[k] = lock
	}
	return lock
}

type sessionRow struct {
	ID         string  `json:"id"`
	ResolvedID string  `json:"resolved_id"`
	Profile    string  `json:"profile"`
	Title      *string `json:"title"`
}

func (a *Adapter) listByTitle(ctx context.Context, profile, title string) ([]sessionRow, error) {
	var out struct {
		Sessions []sessionRow `json:"sessions"`
	}
	if err := a.rpc(ctx, "session.list", map[string]any{"profile": profile, "title": title, "include_hidden": true}, &out); err != nil {
		return nil, err
	}
	return out.Sessions, nil
}

func (a *Adapter) lookup(ctx context.Context, scope conversation.Scope) (string, error) {
	title := titleFor(scope)
	rows, err := a.listByTitle(ctx, scope.Agent, title)
	if err != nil {
		return "", err
	}
	if len(rows) > 1 {
		return "", conversation.ErrAmbiguous
	}
	if len(rows) == 0 {
		return "", nil
	}
	row := rows[0]
	if row.ID == "" || (row.Profile != "" && row.Profile != scope.Agent) || (row.Title != nil && *row.Title != title) {
		return "", conversation.ErrForbidden
	}
	if row.ResolvedID != "" {
		return row.ResolvedID, nil
	}
	return row.ID, nil
}

func (a *Adapter) bindStored(scope conversation.Scope, storedID string) *sessionState {
	state := a.stateFor(scope)
	a.mu.Lock()
	if state.storedID != storedID {
		if state.watchCancel != nil {
			state.watchCancel()
		}
		state.watchGeneration++
		state.watchCancel = nil
		state.watching = false
		state.storedID = storedID
		state.liveID = ""
		state.running = false
	}
	a.mu.Unlock()
	return state
}

func (a *Adapter) clearUncertain(scope conversation.Scope) {
	a.mu.Lock()
	if state := a.states[scopeKey(scope)]; state != nil {
		state.uncertain = false
	}
	a.mu.Unlock()
}

func (a *Adapter) create(ctx context.Context, profile, title string, firstTurn *conversation.FirstTurn) (*sessionState, error) {
	var out struct {
		SessionID string `json:"session_id"`
		StoredID  string `json:"stored_session_id"`
	}
	params := map[string]any{"profile": profile, "title": title, "close_on_disconnect": false}
	if firstTurn != nil {
		// Hermes supplies its assembled system prompt separately. Its Responses
		// transport drops additional system-role history, so preload the private
		// instruction as an ephemeral user turn. Seed history reaches the first
		// model request but is not persisted as a transcript row.
		params["messages"] = []any{map[string]any{"role": "user", "content": firstTurn.Instruction}}
	}
	if err := a.rpc(ctx, "session.create", params, &out); err != nil {
		return nil, err
	}
	if out.SessionID == "" || out.StoredID == "" {
		return nil, conversation.ErrUnavailable
	}
	return &sessionState{profile: profile, storedID: out.StoredID, liveID: out.SessionID}, nil
}

func (a *Adapter) State(ctx context.Context, scope conversation.Scope) (conversation.State, error) {
	if !validScope(scope) {
		return conversation.State{}, conversation.ErrForbidden
	}
	id, err := a.lookup(ctx, scope)
	if err != nil {
		return conversation.State{}, err
	}
	if id == "" {
		return conversation.State{Status: conversation.StatusNew}, nil
	}
	a.bindStored(scope, id)
	return conversation.State{Status: conversation.StatusExisting}, nil
}

func (a *Adapter) Observe(ctx context.Context, scope conversation.Scope) (<-chan conversation.Observation, error) {
	if !validScope(scope) {
		return nil, conversation.ErrForbidden
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	lock := a.sendLock(scope)
	lock.Lock()
	defer lock.Unlock()
	storedID, err := a.lookup(ctx, scope)
	if err != nil {
		return nil, err
	}
	state := a.stateFor(scope)
	if storedID != "" {
		state = a.bindStored(scope, storedID)
	}
	subscriberID := a.observers.Add(1)
	observations := make(chan conversation.Observation, 1)
	a.mu.Lock()
	state.subscribers[subscriberID] = observations
	a.mu.Unlock()
	if storedID != "" {
		a.ensureWatcher(state, false)
	}
	go func() {
		<-ctx.Done()
		a.mu.Lock()
		delete(state.subscribers, subscriberID)
		if len(state.subscribers) == 0 && !state.running && state.watchCancel != nil {
			state.watchCancel()
			state.watchGeneration++
			state.watchCancel = nil
			state.watching = false
		}
		a.mu.Unlock()
	}()
	return observations, nil
}

func (a *Adapter) History(ctx context.Context, scope conversation.Scope) (conversation.Snapshot, error) {
	if !validScope(scope) {
		return conversation.Snapshot{}, conversation.ErrForbidden
	}
	lock := a.sendLock(scope)
	lock.Lock()
	defer lock.Unlock()
	storedID, err := a.lookup(ctx, scope)
	if err != nil {
		return conversation.Snapshot{}, err
	}
	if storedID == "" {
		a.clearUncertain(scope)
		return conversation.Snapshot{}, nil
	}
	state := a.bindStored(scope, storedID)
	const pageSize = 500
	var rows []json.RawMessage
	for offset := 0; ; offset += pageSize {
		q := url.Values{"profile": {scope.Agent}, "limit": {fmt.Sprint(pageSize)}, "offset": {fmt.Sprint(offset)}, "order": {"oldest"}, "include_compacted": {"true"}}
		var payload struct {
			Messages []json.RawMessage `json:"messages"`
		}
		if err := a.httpJSON(ctx, http.MethodGet, "/api/sessions/"+url.PathEscape(storedID)+"/messages", q, nil, &payload); err != nil {
			return conversation.Snapshot{}, err
		}
		rows = append(rows, payload.Messages...)
		if len(payload.Messages) < pageSize {
			break
		}
	}
	messages := projectMessages(rows)
	running := false
	liveID := ""
	a.mu.Lock()
	if state != nil {
		running = state.running
		liveID = state.liveID
		if state.partialText != "" {
			if len(messages) > 0 && messageHasText(messages[len(messages)-1], state.partialText) {
				state.partialText = ""
			} else {
				messages = append(messages, conversation.Message{ID: state.partialID, Role: "assistant", Content: []conversation.Part{{Type: "text", Text: state.partialText}}})
			}
		}
	}
	a.mu.Unlock()
	var active struct {
		Sessions []struct{ ID, Status string } `json:"sessions"`
	}
	if err := a.rpc(ctx, "session.active_list", nil, &active); err == nil {
		if state != nil {
			for _, row := range active.Sessions {
				if row.ID == liveID && (row.Status == "working" || row.Status == "starting" || row.Status == "waiting") {
					running = true
				}
			}
		}
	}
	a.clearUncertain(scope)
	return conversation.Snapshot{Messages: messages, Running: running}, nil
}

func messageHasText(message conversation.Message, text string) bool {
	if message.Role != "assistant" {
		return false
	}
	for _, part := range message.Content {
		if part.Type == "text" && (part.Text == text || strings.TrimSpace(part.Text) == strings.TrimSpace(text)) {
			return true
		}
	}
	return false
}

func projectMessages(rows []json.RawMessage) []conversation.Message {
	out := make([]conversation.Message, 0, len(rows))
	type displayTarget struct {
		message int
		display *conversation.Display
	}
	displays := make(map[string]displayTarget)
	artifacts := make(map[string]int)
	seenDisplayIDs := make(map[string]bool)
	for i, raw := range rows {
		var row map[string]any
		if json.Unmarshal(raw, &row) != nil || row["display_kind"] == "hidden" {
			continue
		}
		role, _ := row["role"].(string)
		if role == "tool" {
			toolCallID, _ := row["tool_call_id"].(string)
			if toolCallID == "" {
				toolCallID, _ = row["toolCallId"].(string)
			}
			target, ok := displays[toolCallID]
			delete(displays, toolCallID)
			if ok && successfulPresentationResult(row) && target.message < len(out) {
				out[target.message].Content = append(out[target.message].Content, conversation.Part{Type: "display", Display: target.display})
			}
			artifactMessage, artifactCall := artifacts[toolCallID]
			delete(artifacts, toolCallID)
			if artifactCall && artifactMessage < len(out) {
				value := row["content"]
				if value == nil {
					value = row["result"]
				}
				if artifact := projectArtifactReceipt(value); artifact != nil {
					out[artifactMessage].Content = append(out[artifactMessage].Content, conversation.Part{Type: "artifact", Artifact: artifact})
				}
			}
			continue
		}
		if role != "user" && role != "assistant" {
			continue
		}
		text := ""
		for _, key := range []string{"display_content", "text", "content"} {
			if s, ok := row[key].(string); ok {
				text = s
				break
			}
		}
		id, _ := row["id"].(string)
		if id == "" {
			if n, ok := row["_row_id"].(float64); ok {
				id = fmt.Sprintf("hermes-row-%.0f", n)
			} else {
				id = fmt.Sprintf("hermes-history-%d", i)
			}
		}
		message := conversation.Message{ID: id, Role: role}
		if text != "" {
			message.Content = append(message.Content, conversation.Part{Type: "text", Text: text})
		}
		messageIndex := len(out)
		out = append(out, message)
		if role != "assistant" {
			continue
		}
		toolCalls, _ := row["tool_calls"].([]any)
		for _, rawCall := range toolCalls {
			call, _ := rawCall.(map[string]any)
			toolCallID, _ := call["id"].(string)
			function, _ := call["function"].(map[string]any)
			tool, _ := function["name"].(string)
			arguments, _ := function["arguments"].(string)
			if artifactTool(tool, json.RawMessage(arguments)) {
				artifacts[toolCallID] = messageIndex
			}
			display := projectDisplay(toolCallID, tool, json.RawMessage(arguments))
			if display == nil || seenDisplayIDs[toolCallID] {
				delete(displays, toolCallID)
				seenDisplayIDs[toolCallID] = true
				continue
			}
			seenDisplayIDs[toolCallID] = true
			displays[toolCallID] = displayTarget{message: messageIndex, display: display}
		}
	}
	visible := out[:0]
	for _, message := range out {
		if len(message.Content) > 0 {
			visible = append(visible, message)
		}
	}
	return visible
}

func (a *Adapter) Send(ctx context.Context, scope conversation.Scope, input conversation.SendInput) error {
	if !validScope(scope) {
		return conversation.ErrForbidden
	}
	text, err := inputText(input)
	if err != nil {
		return err
	}
	lock := a.sendLock(scope)
	lock.Lock()
	defer lock.Unlock()

	state := a.stateFor(scope)
	a.mu.Lock()
	uncertain := state.uncertain
	a.mu.Unlock()
	if uncertain {
		return conversation.ErrUncertain
	}
	storedID, err := a.lookup(ctx, scope)
	if err != nil {
		return err
	}
	if storedID == "" {
		title := titleFor(scope)
		created, createErr := a.create(ctx, scope.Agent, title, input.FirstTurn)
		if createErr != nil {
			return createErr
		}
		// session.title deliberately precedes prompt.submit and materializes Hermes' lazy row.
		if titleErr := a.rpc(ctx, "session.title", map[string]any{"session_id": created.liveID, "title": title}, nil); titleErr != nil {
			return titleErr
		}
		resolved, lookupErr := a.lookup(ctx, scope)
		if lookupErr != nil {
			return lookupErr
		}
		if resolved == "" {
			return conversation.ErrUnavailable
		}
		storedID = resolved
		state = a.bindStored(scope, resolved)
		a.mu.Lock()
		if resolved == created.storedID {
			state.liveID = created.liveID
		}
		a.mu.Unlock()
	} else {
		state = a.bindStored(scope, storedID)
	}

	a.mu.Lock()
	liveID := state.liveID
	a.mu.Unlock()
	if liveID == "" {
		var resumed struct {
			SessionID string `json:"session_id"`
			Running   bool   `json:"running"`
		}
		if err := a.rpc(ctx, "session.resume", map[string]any{"session_id": storedID, "profile": scope.Agent, "omit_messages": true}, &resumed); err != nil {
			return err
		}
		if resumed.SessionID == "" || resumed.Running {
			return conversation.ErrUnavailable
		}
		a.mu.Lock()
		state.liveID = resumed.SessionID
		liveID = resumed.SessionID
		a.mu.Unlock()
	}
	err = a.rpcWithUncertainty(ctx, "prompt.submit", map[string]any{"session_id": liveID, "text": text}, nil, true)
	if errors.Is(err, errRPCOutcomeUncertain) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		a.mu.Lock()
		state.uncertain = true
		a.mu.Unlock()
		return conversation.ErrUncertain
	}
	if err == nil {
		a.mu.Lock()
		state.running = true
		state.partialID = fmt.Sprintf("hermes-live-%d", rpcSequence.Add(1))
		state.partialText = ""
		a.notifyLocked(state)
		a.mu.Unlock()
		a.ensureWatcher(state, true)
	}
	return err
}

// ensureWatcher owns one native watcher per Agent+Ref. Subscribers receive
// normalized change signals and never own or cancel the native connection.
// A successful prompt forces reattachment because prompt.submit transfers
// Hermes events to its short-lived RPC connection.
func (a *Adapter) ensureWatcher(state *sessionState, restart bool) {
	a.mu.Lock()
	if restart && state.watchCancel != nil {
		state.watchCancel()
	}
	if restart {
		state.watchGeneration++
		state.watchCancel = nil
		state.watching = false
	}
	if state.watching || state.storedID == "" {
		a.mu.Unlock()
		return
	}
	state.watchGeneration++
	generation := state.watchGeneration
	ctx, cancel := context.WithCancel(context.Background())
	state.watchCancel = cancel
	state.watching = true
	a.mu.Unlock()
	go func() {
		defer func() {
			cancel()
			a.mu.Lock()
			if state.watchGeneration == generation {
				state.watchCancel = nil
				state.watching = false
			}
			a.mu.Unlock()
		}()
		if ctx.Err() == nil {
			_ = a.watchOnce(ctx, state, generation)
		}
	}()
}

func (a *Adapter) notifyLocked(state *sessionState) {
	for _, subscriber := range state.subscribers {
		select {
		case subscriber <- conversation.Observation{}:
		default:
		}
	}
}

func (a *Adapter) failWatcher(state *sessionState, generation uint64) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if state.watchGeneration != generation {
		return true
	}
	for _, subscriber := range state.subscribers {
		// A terminal watcher error supersedes a buffered change notification;
		// otherwise the SSE consumer can refresh once and then wait forever.
		select {
		case <-subscriber:
		default:
		}
		select {
		case subscriber <- conversation.Observation{Err: conversation.ErrUnavailable}:
		default:
		}
	}
	return true
}

func (a *Adapter) failWatcherTransport(ctx context.Context, state *sessionState, generation uint64) bool {
	if ctx.Err() != nil {
		return true
	}
	return a.failWatcher(state, generation)
}

func (a *Adapter) watchOnce(ctx context.Context, state *sessionState, generation uint64) bool {
	conn, _, err := websocket.Dial(ctx, a.websocketURL(), &websocket.DialOptions{HTTPClient: a.http, Subprotocols: []string{"hermes-gateway-v1"}})
	if err != nil {
		return a.failWatcherTransport(ctx, state, generation)
	}
	defer conn.CloseNow()
	id := fmt.Sprintf("aos-watch-%d", rpcSequence.Add(1))
	a.mu.Lock()
	if state.watchGeneration != generation {
		a.mu.Unlock()
		return true
	}
	storedID, profile := state.storedID, state.profile
	a.mu.Unlock()
	request, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "session.resume", "params": map[string]any{"session_id": storedID, "profile": profile, "omit_messages": true}})
	if conn.Write(ctx, websocket.MessageText, request) != nil {
		return a.failWatcherTransport(ctx, state, generation)
	}
	attached := false
	for {
		_, data, readErr := conn.Read(ctx)
		if readErr != nil {
			return a.failWatcherTransport(ctx, state, generation)
		}
		var frame map[string]json.RawMessage
		if json.Unmarshal(data, &frame) != nil {
			continue
		}
		if rawID, ok := frame["id"]; ok {
			var responseID string
			_ = json.Unmarshal(rawID, &responseID)
			if responseID != id {
				continue
			}
			if _, failed := frame["error"]; failed {
				return a.failWatcher(state, generation)
			}
			var result struct {
				SessionID string `json:"session_id"`
				Running   bool   `json:"running"`
			}
			if json.Unmarshal(frame["result"], &result) != nil || result.SessionID == "" {
				return a.failWatcher(state, generation)
			}
			a.mu.Lock()
			if state.watchGeneration != generation {
				a.mu.Unlock()
				return true
			}
			runningChanged := state.running != result.Running
			state.liveID, state.running = result.SessionID, result.Running
			if runningChanged {
				a.notifyLocked(state)
			}
			a.mu.Unlock()
			attached = true
			continue
		}
		if !attached {
			continue
		}
		var method string
		_ = json.Unmarshal(frame["method"], &method)
		if method != "event" {
			continue
		}
		var event struct {
			Type      string         `json:"type"`
			SessionID string         `json:"session_id"`
			Payload   map[string]any `json:"payload"`
		}
		if json.Unmarshal(frame["params"], &event) != nil {
			continue
		}
		a.mu.Lock()
		if state.watchGeneration != generation || event.SessionID != state.liveID {
			a.mu.Unlock()
			continue
		}
		terminal := false
		notify := true
		switch event.Type {
		case "message.start":
			state.partialText, state.running = "", true
		case "message.delta":
			if text, ok := event.Payload["text"].(string); ok {
				state.partialText += text
			}
			state.running = true
		case "message.complete", "error":
			state.running, terminal = false, true
		case "session.info":
			if value, ok := event.Payload["running"].(bool); ok {
				state.running = value
				terminal = !value
			} else {
				notify = false
			}
		case "tool.complete":
		default:
			notify = false
		}
		if notify {
			a.notifyLocked(state)
		}
		keepWatching := len(state.subscribers) > 0
		a.mu.Unlock()
		if terminal && !keepWatching {
			return true
		}
	}
}

func inputText(input conversation.SendInput) (string, error) {
	var pieces []string
	for _, part := range input.Content {
		if part.Type != "text" || part.URL != "" {
			return "", conversation.ErrUnsupported
		}
		if strings.TrimSpace(part.Text) != "" {
			pieces = append(pieces, part.Text)
		}
	}
	text := strings.TrimSpace(strings.Join(pieces, "\n"))
	if text == "" {
		return "", conversation.ErrUnsupported
	}
	return text, nil
}

func (a *Adapter) Stop(ctx context.Context, scope conversation.Scope) error {
	if !validScope(scope) {
		return conversation.ErrForbidden
	}
	lock := a.sendLock(scope)
	lock.Lock()
	defer lock.Unlock()
	storedID, err := a.lookup(ctx, scope)
	if err != nil || storedID == "" {
		return err
	}
	state := a.bindStored(scope, storedID)
	a.mu.Lock()
	liveID := state.liveID
	a.mu.Unlock()
	if liveID == "" {
		var resumed struct {
			SessionID string `json:"session_id"`
			Running   bool   `json:"running"`
		}
		if err := a.rpc(ctx, "session.resume", map[string]any{"session_id": storedID, "profile": scope.Agent, "omit_messages": true}, &resumed); err != nil {
			return err
		}
		if resumed.SessionID == "" {
			return conversation.ErrUnavailable
		}
		if !resumed.Running {
			return nil
		}
		liveID = resumed.SessionID
		a.mu.Lock()
		state.liveID = liveID
		state.running = true
		a.mu.Unlock()
	}
	if err := a.rpc(ctx, "session.interrupt", map[string]any{"session_id": liveID}, nil); err != nil {
		return err
	}
	a.mu.Lock()
	state.running = false
	a.notifyLocked(state)
	a.mu.Unlock()
	return nil
}

func (a *Adapter) Transcribe(ctx context.Context, scope conversation.Scope, data []byte, mime string) (string, error) {
	if !validScope(scope) || len(data) == 0 || len(data) > maxAudioBytes || !recordingMIME.MatchString(mime) {
		return "", conversation.ErrUnsupported
	}
	body := map[string]any{"data_url": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), "mime_type": mime}
	var out struct {
		OK         bool   `json:"ok"`
		Transcript string `json:"transcript"`
	}
	if err := a.httpJSON(ctx, http.MethodPost, "/api/audio/transcribe", url.Values{"profile": {scope.Agent}}, body, &out); err != nil {
		return "", err
	}
	if !out.OK {
		return "", conversation.ErrUnavailable
	}
	return out.Transcript, nil
}

func (a *Adapter) Speech(ctx context.Context, scope conversation.Scope, text string) ([]byte, string, error) {
	if !validScope(scope) || strings.TrimSpace(text) == "" {
		return nil, "", conversation.ErrUnsupported
	}
	var raw map[string]any
	if err := a.httpJSON(ctx, http.MethodPost, "/api/audio/speak", url.Values{"profile": {scope.Agent}}, map[string]any{"text": text}, &raw); err != nil {
		return nil, "", err
	}
	ok, _ := raw["ok"].(bool)
	dataURL, _ := raw["data_url"].(string)
	mime, _ := raw["mime_type"].(string)
	if !ok || !speechMIME.MatchString(mime) {
		return nil, "", conversation.ErrUnavailable
	}
	prefix := "data:" + mime + ";base64,"
	if !strings.HasPrefix(dataURL, prefix) {
		return nil, "", conversation.ErrUnavailable
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(dataURL, prefix))
	if err != nil {
		return nil, "", conversation.ErrUnavailable
	}
	return data, mime, nil
}

type audioProviderMetadata struct {
	Name        string `json:"name"`
	Status      string `json:"status"`
	Active      bool   `json:"is_active"`
	TTSProvider string `json:"tts_provider"`
}

type audioMetadata struct {
	Name           string                  `json:"name"`
	HasCategory    bool                    `json:"has_category"`
	ActiveProvider *string                 `json:"active_provider"`
	Providers      []audioProviderMetadata `json:"providers"`
}

func audioProviderAvailable(provider audioProviderMetadata) bool {
	switch provider.Status {
	case "ready", "needs_keys", "needs_auth", "needs_setup":
		return true
	default:
		return false
	}
}

// Hermes provider metadata is a picker hint, not a live health check. Match
// the regular UI by allowing native audio calls for unverified selections and
// letting the native endpoint report the authoritative result.
func (a *Adapter) audioAvailable(ctx context.Context, profile, kind string) bool {
	var metadata audioMetadata
	if a.httpJSON(ctx, http.MethodGet, "/api/tools/toolsets/"+kind+"/config", url.Values{"profile": {profile}}, nil, &metadata) != nil {
		return false
	}
	if metadata.Name != kind || !metadata.HasCategory {
		return false
	}
	if metadata.ActiveProvider != nil {
		for _, provider := range metadata.Providers {
			if provider.Name == *metadata.ActiveProvider && provider.Active {
				return audioProviderAvailable(provider)
			}
		}
		return false
	}
	for _, provider := range metadata.Providers {
		if provider.Active {
			return false
		}
	}
	if kind == "tts" {
		for _, provider := range metadata.Providers {
			if provider.TTSProvider == "edge" {
				return audioProviderAvailable(provider)
			}
		}
		return false
	}
	return kind == "stt"
}

func (a *Adapter) httpJSON(ctx context.Context, method, path string, query url.Values, body, out any) error {
	u := *a.base
	u.Path = strings.TrimSuffix(u.Path, "/") + path
	u.RawQuery = query.Encode()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return conversation.ErrUnavailable
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return conversation.ErrUnavailable
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Hermes-Session-Token", a.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return conversation.ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return conversation.ErrForbidden
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return conversation.ErrUnavailable
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out); err != nil {
		return conversation.ErrUnavailable
	}
	return nil
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      string          `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code int `json:"code"`
	} `json:"error"`
}

var rpcSequence atomic.Uint64

func (a *Adapter) websocketURL() string {
	u := *a.base
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/api/ws"
	query := u.Query()
	query.Set("token", a.token)
	u.RawQuery = query.Encode()
	return u.String()
}

func (a *Adapter) rpc(ctx context.Context, method string, params, out any) error {
	return a.rpcWithUncertainty(ctx, method, params, out, false)
}

func (a *Adapter) rpcWithUncertainty(ctx context.Context, method string, params, out any, uncertainAfterWrite bool) error {
	conn, _, err := websocket.Dial(ctx, a.websocketURL(), &websocket.DialOptions{HTTPClient: a.http, Subprotocols: []string{"hermes-gateway-v1"}})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return conversation.ErrUnavailable
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	id := fmt.Sprintf("aos-%d", rpcSequence.Add(1))
	frame := map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}
	data, _ := json.Marshal(frame)
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		if uncertainAfterWrite {
			return errRPCOutcomeUncertain
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return conversation.ErrUnavailable
	}
	for {
		_, data, err = conn.Read(ctx)
		if err != nil {
			if uncertainAfterWrite {
				return errRPCOutcomeUncertain
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return conversation.ErrUnavailable
		}
		var response rpcResponse
		if json.Unmarshal(data, &response) != nil || response.ID != id {
			continue
		}
		if response.Error != nil {
			if response.Error.Code == 401 || response.Error.Code == 403 {
				return conversation.ErrForbidden
			}
			return conversation.ErrUnavailable
		}
		if out != nil && json.Unmarshal(response.Result, out) != nil {
			return conversation.ErrUnavailable
		}
		return nil
	}
}
