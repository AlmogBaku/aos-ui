// Package openclaw adapts the native OpenClaw Gateway protocol to invited chat.
package openclaw

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"aosui/gateway/conversation"
)

var referencePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type Config struct {
	BaseURL string
	Token   string
}

type event struct {
	Name    string
	Payload json.RawMessage
}

type rpcClient interface {
	Request(context.Context, string, any, any) error
	Observe(context.Context) (<-chan event, error)
}

type Adapter struct{ rpc rpcClient }

var _ conversation.Adapter = (*Adapter)(nil)
var _ conversation.Observer = (*Adapter)(nil)
var _ conversation.QuestionResponder = (*Adapter)(nil)
var _ conversation.ArtifactReader = (*Adapter)(nil)
var _ conversation.Audio = (*Adapter)(nil)

func New(config Config) (*Adapter, error) {
	rpc, err := newGatewayClient(config.BaseURL, config.Token)
	if err != nil {
		return nil, err
	}
	return newWithRPC(rpc), nil
}

func newWithRPC(rpc rpcClient) *Adapter { return &Adapter{rpc: rpc} }

func validScope(scope conversation.Scope) bool {
	return referencePattern.MatchString(scope.Agent) && referencePattern.MatchString(scope.Ref)
}

func sessionKey(scope conversation.Scope) string {
	return "agent:" + scope.Agent + ":aos-invite:" + scope.Ref
}

type sessionRow struct {
	Key     string `json:"key"`
	AgentID string `json:"agentId"`
}

func (a *Adapter) lookup(ctx context.Context, scope conversation.Scope) (bool, error) {
	if !validScope(scope) {
		return false, conversation.ErrForbidden
	}
	var catalog struct {
		Agents []struct {
			ID string `json:"id"`
		} `json:"agents"`
	}
	if err := a.rpc.Request(ctx, "agents.list", map[string]any{}, &catalog); err != nil {
		return false, err
	}
	matches := 0
	for _, agent := range catalog.Agents {
		if agent.ID == scope.Agent {
			matches++
		}
	}
	if matches != 1 {
		return false, conversation.ErrForbidden
	}
	var page struct {
		Sessions []sessionRow `json:"sessions"`
	}
	if err := a.rpc.Request(ctx, "sessions.list", map[string]any{
		"agentId": scope.Agent, "search": sessionKey(scope), "limit": 100,
	}, &page); err != nil {
		return false, err
	}
	found := false
	for _, row := range page.Sessions {
		if row.Key != sessionKey(scope) {
			continue
		}
		if row.AgentID != scope.Agent {
			return false, conversation.ErrForbidden
		}
		if found {
			return false, conversation.ErrAmbiguous
		}
		found = true
	}
	return found, nil
}

func (a *Adapter) Capabilities(ctx context.Context, scope conversation.Scope) (conversation.Capabilities, error) {
	if _, err := a.lookup(ctx, scope); err != nil {
		return conversation.Capabilities{}, err
	}
	// OpenClaw has no exact safe guest edit/regenerate, branches, Todos, or
	// transcription operation. Those stay false instead of being emulated.
	return conversation.Capabilities{Attachments: true, Questions: true, Speech: true}, nil
}

func (a *Adapter) State(ctx context.Context, scope conversation.Scope) (conversation.State, error) {
	found, err := a.lookup(ctx, scope)
	if err != nil {
		return conversation.State{}, err
	}
	if found {
		return conversation.State{Status: conversation.StatusExisting}, nil
	}
	return conversation.State{Status: conversation.StatusNew}, nil
}

type historyResult struct {
	Messages    []json.RawMessage `json:"messages"`
	InFlightRun *struct {
		RunID string `json:"runId"`
		Text  string `json:"text"`
	} `json:"inFlightRun"`
	SessionInfo struct {
		HasActiveRun bool     `json:"hasActiveRun"`
		ActiveRunIDs []string `json:"activeRunIds"`
	} `json:"sessionInfo"`
}

func (a *Adapter) nativeHistory(ctx context.Context, scope conversation.Scope) (historyResult, error) {
	found, err := a.lookup(ctx, scope)
	if err != nil || !found {
		return historyResult{}, err
	}
	var result historyResult
	err = a.rpc.Request(ctx, "chat.history", map[string]any{
		"sessionKey": sessionKey(scope), "agentId": scope.Agent, "limit": 1000,
	}, &result)
	return result, err
}

func (a *Adapter) History(ctx context.Context, scope conversation.Scope) (conversation.Snapshot, error) {
	history, err := a.nativeHistory(ctx, scope)
	if err != nil {
		return conversation.Snapshot{}, err
	}
	messages := make([]conversation.Message, 0, len(history.Messages)+1)
	for index, raw := range history.Messages {
		if message, ok := projectMessage(raw, fmt.Sprintf("openclaw-%d", index)); ok {
			messages = append(messages, message)
		}
	}
	if history.InFlightRun != nil && history.InFlightRun.Text != "" {
		messages = append(messages, conversation.Message{ID: history.InFlightRun.RunID, Role: "assistant", Content: []conversation.Part{{Type: "text", Text: history.InFlightRun.Text}}})
	}
	questions, err := a.pendingQuestions(ctx, scope)
	if err != nil {
		return conversation.Snapshot{}, err
	}
	return conversation.Snapshot{
		Messages: messages, Running: history.InFlightRun != nil || history.SessionInfo.HasActiveRun || len(history.SessionInfo.ActiveRunIDs) > 0,
		PendingQuestions: questions,
	}, nil
}

func projectMessage(raw json.RawMessage, fallbackID string) (conversation.Message, bool) {
	var row struct {
		ID      string          `json:"id"`
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &row) != nil || (row.Role != "user" && row.Role != "assistant") {
		return conversation.Message{}, false
	}
	if row.ID == "" {
		row.ID = fallbackID
	}
	var text string
	if json.Unmarshal(row.Content, &text) == nil {
		if strings.TrimSpace(text) == "" {
			return conversation.Message{}, false
		}
		return conversation.Message{ID: row.ID, Role: row.Role, Content: []conversation.Part{{Type: "text", Text: text}}}, true
	}
	var nativeParts []struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		Artifact *struct {
			ID, Title, MimeType string
			SizeBytes           int64
		} `json:"artifact"`
	}
	if json.Unmarshal(row.Content, &nativeParts) != nil {
		return conversation.Message{}, false
	}
	parts := make([]conversation.Part, 0, len(nativeParts))
	for _, part := range nativeParts {
		switch {
		case part.Type == "text" && strings.TrimSpace(part.Text) != "":
			parts = append(parts, conversation.Part{Type: "text", Text: part.Text})
		case part.Type == "artifact" && part.Artifact != nil && part.Artifact.ID != "" && part.Artifact.Title != "":
			parts = append(parts, conversation.Part{Type: "artifact", Artifact: &conversation.Artifact{
				ID: part.Artifact.ID, Filename: part.Artifact.Title, MimeType: part.Artifact.MimeType, SizeBytes: part.Artifact.SizeBytes,
				Source: conversation.ArtifactSource{Type: "provider", Reference: part.Artifact.ID},
			}})
		}
	}
	return conversation.Message{ID: row.ID, Role: row.Role, Content: parts}, len(parts) > 0
}

func content(input conversation.SendInput) (string, []map[string]any, error) {
	var text []string
	var attachments []map[string]any
	for _, part := range input.Content {
		switch part.Type {
		case "text":
			text = append(text, part.Text)
		case "image", "file":
			prefix := "data:" + part.Mime + ";base64,"
			if !strings.HasPrefix(part.URL, prefix) {
				return "", nil, conversation.ErrForbidden
			}
			attachments = append(attachments, map[string]any{
				"type": part.Type, "mimeType": part.Mime, "fileName": part.Filename, "content": strings.TrimPrefix(part.URL, prefix),
			})
		default:
			return "", nil, conversation.ErrForbidden
		}
	}
	return strings.Join(text, "\n"), attachments, nil
}

func requestID() string {
	var bytes [16]byte
	_, _ = rand.Read(bytes[:])
	return hex.EncodeToString(bytes[:])
}

func (a *Adapter) Send(ctx context.Context, scope conversation.Scope, input conversation.SendInput) error {
	found, err := a.lookup(ctx, scope)
	if err != nil {
		return err
	}
	message, attachments, err := content(input)
	if err != nil {
		return err
	}
	params := map[string]any{
		"agentId": scope.Agent, "message": message, "attachments": attachments, "idempotencyKey": requestID(),
	}
	if !found {
		params["key"] = sessionKey(scope)
		params["label"] = "AOS invited chat"
		if input.FirstTurn != nil && input.FirstTurn.Instruction != "" {
			params["task"] = input.FirstTurn.Instruction
		}
		var created struct {
			OK  bool   `json:"ok"`
			Key string `json:"key"`
		}
		if err := a.rpc.Request(ctx, "sessions.create", params, &created); err != nil {
			return conversation.ErrUncertain
		}
		if !created.OK || created.Key != sessionKey(scope) {
			return conversation.ErrForbidden
		}
		return nil
	}
	params["sessionKey"] = sessionKey(scope)
	var sent struct {
		RunID string `json:"runId"`
	}
	if err := a.rpc.Request(ctx, "chat.send", params, &sent); err != nil {
		return conversation.ErrUncertain
	}
	if sent.RunID == "" {
		return conversation.ErrUnavailable
	}
	return nil
}

func (a *Adapter) Stop(ctx context.Context, scope conversation.Scope) error {
	history, err := a.nativeHistory(ctx, scope)
	if err != nil {
		return err
	}
	runID := ""
	if history.InFlightRun != nil {
		runID = history.InFlightRun.RunID
	} else if len(history.SessionInfo.ActiveRunIDs) == 1 {
		runID = history.SessionInfo.ActiveRunIDs[0]
	}
	if runID == "" {
		return conversation.ErrUnsupported
	}
	return a.rpc.Request(ctx, "chat.abort", map[string]any{"sessionKey": sessionKey(scope), "agentId": scope.Agent, "runId": runID}, nil)
}

type nativeQuestion struct {
	ID          string `json:"id"`
	AgentID     string `json:"agentId"`
	SessionKey  string `json:"sessionKey"`
	Status      string `json:"status"`
	ExpiresAtMs int64  `json:"expiresAtMs"`
	Questions   []struct {
		QuestionID, Header, Question   string
		Options                        []conversation.QuestionOption
		MultiSelect, IsOther, IsSecret bool
	}
}

func (a *Adapter) listQuestions(ctx context.Context, scope conversation.Scope) ([]nativeQuestion, error) {
	var result struct {
		Questions []nativeQuestion `json:"questions"`
	}
	if err := a.rpc.Request(ctx, "question.list", map[string]any{}, &result); err != nil {
		return nil, err
	}
	filtered := result.Questions[:0]
	for _, question := range result.Questions {
		if question.Status != "pending" || question.ExpiresAtMs <= time.Now().UnixMilli() || question.SessionKey != sessionKey(scope) || (question.AgentID != "" && question.AgentID != scope.Agent) {
			continue
		}
		secret := false
		for _, item := range question.Questions {
			secret = secret || item.IsSecret
		}
		if !secret {
			filtered = append(filtered, question)
		}
	}
	return filtered, nil
}

func (a *Adapter) pendingQuestions(ctx context.Context, scope conversation.Scope) ([]conversation.PendingQuestion, error) {
	rows, err := a.listQuestions(ctx, scope)
	if err != nil {
		return nil, err
	}
	result := make([]conversation.PendingQuestion, 0, len(rows))
	for _, row := range rows {
		question := conversation.PendingQuestion{ID: row.ID}
		for _, item := range row.Questions {
			question.Questions = append(question.Questions, conversation.Question{Header: item.Header, Question: item.Question, Options: item.Options, Multiple: item.MultiSelect, Custom: item.IsOther})
		}
		result = append(result, question)
	}
	return result, nil
}

func (a *Adapter) resolveQuestion(ctx context.Context, scope conversation.Scope, id string, answers [][]string, cancel bool) error {
	questions, err := a.listQuestions(ctx, scope)
	if err != nil {
		return err
	}
	var selected *nativeQuestion
	for index := range questions {
		if questions[index].ID == id {
			selected = &questions[index]
			break
		}
	}
	if selected == nil {
		return conversation.ErrForbidden
	}
	params := map[string]any{"id": id}
	if cancel {
		params["cancel"] = true
	} else {
		if len(answers) != len(selected.Questions) {
			return conversation.ErrForbidden
		}
		values := map[string][]string{}
		for index, question := range selected.Questions {
			values[question.QuestionID] = answers[index]
		}
		params["answers"] = map[string]any{"answers": values}
	}
	return a.rpc.Request(ctx, "question.resolve", params, nil)
}

func (a *Adapter) ReplyQuestion(ctx context.Context, scope conversation.Scope, id string, answers [][]string) error {
	return a.resolveQuestion(ctx, scope, id, answers, false)
}
func (a *Adapter) RejectQuestion(ctx context.Context, scope conversation.Scope, id string) error {
	return a.resolveQuestion(ctx, scope, id, nil, true)
}

func (a *Adapter) ReadArtifact(ctx context.Context, scope conversation.Scope, id string) (conversation.ArtifactContent, error) {
	if found, err := a.lookup(ctx, scope); err != nil || !found {
		if err != nil {
			return conversation.ArtifactContent{}, err
		}
		return conversation.ArtifactContent{}, conversation.ErrForbidden
	}
	var result struct {
		Artifact       struct{ ID, Title, MimeType, SessionKey, AgentID string } `json:"artifact"`
		Encoding, Data string
	}
	if err := a.rpc.Request(ctx, "artifacts.download", map[string]any{"artifactId": id, "sessionKey": sessionKey(scope), "agentId": scope.Agent}, &result); err != nil {
		return conversation.ArtifactContent{}, err
	}
	if result.Artifact.ID != id || result.Artifact.SessionKey != sessionKey(scope) || (result.Artifact.AgentID != "" && result.Artifact.AgentID != scope.Agent) || result.Encoding != "base64" {
		return conversation.ArtifactContent{}, conversation.ErrForbidden
	}
	data, err := base64.StdEncoding.DecodeString(result.Data)
	if err != nil {
		return conversation.ArtifactContent{}, conversation.ErrUnavailable
	}
	return conversation.ArtifactContent{Data: data, MimeType: result.Artifact.MimeType, Filename: result.Artifact.Title}, nil
}

func (a *Adapter) Speech(ctx context.Context, scope conversation.Scope, text string) ([]byte, string, error) {
	if found, err := a.lookup(ctx, scope); err != nil {
		return nil, "", err
	} else if !found {
		return nil, "", conversation.ErrForbidden
	}
	var result struct{ AudioBase64, MimeType string }
	if err := a.rpc.Request(ctx, "tts.speak", map[string]any{"text": text}, &result); err != nil {
		return nil, "", err
	}
	data, err := base64.StdEncoding.DecodeString(result.AudioBase64)
	if err != nil {
		return nil, "", conversation.ErrUnavailable
	}
	if result.MimeType == "" {
		result.MimeType = "audio/mpeg"
	}
	return data, result.MimeType, nil
}

func (a *Adapter) Transcribe(context.Context, conversation.Scope, []byte, string) (string, error) {
	return "", conversation.ErrUnsupported
}

func (a *Adapter) Observe(ctx context.Context, scope conversation.Scope) (<-chan conversation.Observation, error) {
	if !validScope(scope) {
		return nil, conversation.ErrForbidden
	}
	events, err := a.rpc.Observe(ctx)
	if err != nil {
		return nil, err
	}
	result := make(chan conversation.Observation, 1)
	go func() {
		defer close(result)
		for {
			select {
			case <-ctx.Done():
				return
			case incoming, ok := <-events:
				if !ok {
					return
				}
				var payload struct{ SessionKey, AgentID string }
				if json.Unmarshal(incoming.Payload, &payload) != nil || payload.SessionKey != sessionKey(scope) || (payload.AgentID != "" && payload.AgentID != scope.Agent) {
					continue
				}
				select {
				case result <- conversation.Observation{}:
				default:
				}
			}
		}
	}()
	return result, nil
}
