package opencode

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"aosui/gateway/conversation"
)

const maxNativeEventBytes = 1 << 20

type nativeEvent struct {
	Type       string `json:"type"`
	Properties struct {
		SessionID string        `json:"sessionID"`
		Info      nativeSession `json:"info"`
	} `json:"properties"`
}

func (a *Adapter) Observe(ctx context.Context, scope conversation.Scope) (<-chan conversation.Observation, error) {
	session, _, err := a.resolve(ctx, scope, false)
	if err != nil {
		return nil, err
	}
	targetID := ""
	if session != nil {
		targetID = session.ID
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.endpoint("/event", nil), nil)
	if err != nil {
		return nil, conversation.ErrUnavailable
	}
	if a.username != "" || a.password != "" {
		req.SetBasicAuth(a.username, a.password)
	}
	response, err := a.stream.Do(req)
	if err != nil {
		return nil, conversation.ErrUnavailable
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			return nil, conversation.ErrForbidden
		}
		return nil, conversation.ErrUnavailable
	}

	observations := make(chan conversation.Observation, 1)
	go observeNativeEvents(ctx, response.Body, scope, targetID, observations)
	return observations, nil
}

func observeNativeEvents(ctx context.Context, body io.ReadCloser, scope conversation.Scope, targetID string, observations chan conversation.Observation) {
	defer close(observations)
	defer body.Close()
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 4096), maxNativeEventBytes)
	var data strings.Builder
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if data.Len() != 0 {
				targetID = handleNativeEvent(data.String(), scope, targetID, observations)
				data.Reset()
			}
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		value := strings.TrimPrefix(line, "data:")
		value = strings.TrimPrefix(value, " ")
		if data.Len() != 0 {
			data.WriteByte('\n')
		}
		data.WriteString(value)
	}
	if ctx.Err() == nil {
		publishObservation(observations, conversation.Observation{Err: conversation.ErrUnavailable})
	}
}

func handleNativeEvent(data string, scope conversation.Scope, targetID string, observations chan conversation.Observation) string {
	var event nativeEvent
	if json.Unmarshal([]byte(data), &event) != nil || event.Type == "" {
		return targetID
	}
	if targetID == "" {
		if event.Type != "session.created" && event.Type != "session.updated" {
			return ""
		}
		candidate := event.Properties.Info
		if candidate.ID == "" {
			candidate.ID = event.Properties.SessionID
		}
		if candidate.ID == "" || candidate.ParentID != "" || candidate.Agent != scope.Agent || externalRef(candidate.Metadata) != scope.Ref {
			return ""
		}
		targetID = candidate.ID
		publishObservation(observations, conversation.Observation{})
		return targetID
	}
	eventSessionID := event.Properties.SessionID
	if eventSessionID == "" {
		eventSessionID = event.Properties.Info.ID
	}
	if eventSessionID == targetID {
		publishObservation(observations, conversation.Observation{})
	}
	return targetID
}

func publishObservation(observations chan conversation.Observation, observation conversation.Observation) {
	select {
	case observations <- observation:
	default:
		// Snapshot reloads coalesce bursts of native deltas. Preserve terminal
		// errors by replacing a pending change notification.
		if observation.Err != nil {
			select {
			case <-observations:
			default:
			}
			select {
			case observations <- observation:
			default:
			}
		}
	}
}

var _ conversation.Observer = (*Adapter)(nil)
