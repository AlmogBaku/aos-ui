package hermes

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"aosui/gateway/conversation"
)

const maxArtifactBytes = 25 << 20

func artifactTool(tool string, arguments json.RawMessage) bool {
	if tool == "present_artifact" {
		return true
	}
	if tool != "tool_call" {
		return false
	}
	var call struct {
		Name string `json:"name"`
	}
	return json.Unmarshal(arguments, &call) == nil && call.Name == "present_artifact"
}

func projectArtifactReceipt(value any) *conversation.Artifact {
	var raw []byte
	switch typed := value.(type) {
	case string:
		raw = []byte(typed)
	default:
		raw, _ = json.Marshal(typed)
	}
	var receipt struct {
		OK       bool   `json:"ok"`
		Type     string `json:"type"`
		Artifact struct {
			ID        string `json:"id"`
			Path      string `json:"path"`
			Filename  string `json:"filename"`
			MimeType  string `json:"mimeType"`
			SizeBytes int64  `json:"sizeBytes"`
		} `json:"artifact"`
	}
	if len(raw) == 0 || len(raw) > maxDisplayPayloadBytes || json.Unmarshal(raw, &receipt) != nil || !receipt.OK || receipt.Type != "aos.artifact" {
		return nil
	}
	a := receipt.Artifact
	if a.ID == "" || len(a.ID) > 256 || a.Filename == "" || len(a.Filename) > 255 || a.SizeBytes < 0 || !safeArtifactReference(a.Path) {
		return nil
	}
	return &conversation.Artifact{ID: a.ID, Filename: a.Filename, MimeType: a.MimeType, SizeBytes: a.SizeBytes, Source: conversation.ArtifactSource{Type: "provider", Reference: a.Path}}
}

func safeArtifactReference(value string) bool {
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, "\\") || strings.ContainsRune(value, 0) {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == ".." {
			return false
		}
	}
	return true
}

func (a *Adapter) ReadArtifact(ctx context.Context, scope conversation.Scope, reference string) (conversation.ArtifactContent, error) {
	if !validScope(scope) || !safeArtifactReference(reference) {
		return conversation.ArtifactContent{}, conversation.ErrForbidden
	}
	storedID, err := a.lookup(ctx, scope)
	if err != nil {
		return conversation.ArtifactContent{}, err
	}
	if storedID == "" {
		return conversation.ArtifactContent{}, conversation.ErrUnavailable
	}
	query := url.Values{"path": {reference}, "profile": {scope.Agent}, "session_id": {storedID}}
	response, err := a.artifactRequest(ctx, "/api/fs/read-data-url", query)
	if err != nil {
		return conversation.ArtifactContent{}, err
	}
	if response.StatusCode == http.StatusRequestEntityTooLarge {
		response.Body.Close()
		return a.downloadArtifact(ctx, query)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return conversation.ArtifactContent{}, conversation.ErrForbidden
	}
	if response.StatusCode != http.StatusOK {
		return conversation.ArtifactContent{}, conversation.ErrUnavailable
	}
	var payload struct {
		DataURL string `json:"dataUrl"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, maxArtifactBytes*2)).Decode(&payload) != nil {
		return conversation.ArtifactContent{}, conversation.ErrUnavailable
	}
	separator := strings.Index(payload.DataURL, ";base64,")
	if !strings.HasPrefix(payload.DataURL, "data:") || separator <= len("data:") {
		return conversation.ArtifactContent{}, conversation.ErrUnavailable
	}
	mimeType := payload.DataURL[len("data:"):separator]
	if strings.ContainsAny(mimeType, "\r\n") {
		return conversation.ArtifactContent{}, conversation.ErrUnavailable
	}
	data, err := base64.StdEncoding.DecodeString(payload.DataURL[separator+len(";base64,"):])
	if err != nil || len(data) == 0 || len(data) > maxArtifactBytes {
		return conversation.ArtifactContent{}, conversation.ErrUnavailable
	}
	return conversation.ArtifactContent{Data: data, MimeType: mimeType}, nil
}

func (a *Adapter) artifactRequest(ctx context.Context, path string, query url.Values) (*http.Response, error) {
	u := *a.base
	u.Path = strings.TrimSuffix(u.Path, "/") + path
	u.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, conversation.ErrUnavailable
	}
	request.Header.Set("X-Hermes-Session-Token", a.token)
	response, err := a.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, conversation.ErrUnavailable
	}
	return response, nil
}

func (a *Adapter) downloadArtifact(ctx context.Context, query url.Values) (conversation.ArtifactContent, error) {
	response, err := a.artifactRequest(ctx, "/api/fs/download", query)
	if err != nil {
		return conversation.ArtifactContent{}, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return conversation.ArtifactContent{}, conversation.ErrForbidden
	}
	if response.StatusCode != http.StatusOK {
		return conversation.ArtifactContent{}, conversation.ErrUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxArtifactBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxArtifactBytes {
		return conversation.ArtifactContent{}, conversation.ErrUnavailable
	}
	return conversation.ArtifactContent{Data: data, MimeType: response.Header.Get("Content-Type")}, nil
}
