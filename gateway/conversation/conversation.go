// Package conversation defines the provider-neutral seam used by guest HTTP.
// Native credentials, identifiers and event envelopes never cross this seam.
package conversation

import (
	"context"
	"encoding/json"
	"errors"
)

var (
	ErrUnavailable = errors.New("conversation unavailable")
	ErrForbidden   = errors.New("conversation forbidden")
	ErrAmbiguous   = errors.New("conversation reference is ambiguous")
	ErrUnsupported = errors.New("operation unsupported")
	ErrUncertain   = errors.New("send outcome uncertain; reload history before sending again")
)

type Scope struct {
	Agent string `json:"agent"`
	Ref   string `json:"ref"`
}

type Status string

const (
	StatusNew      Status = "new"
	StatusExisting Status = "existing"
)

type State struct {
	Status Status `json:"status"`
}

type Capabilities struct {
	Attachments   bool `json:"attachments"`
	Edit          bool `json:"edit"`
	Regenerate    bool `json:"regenerate"`
	Branches      bool `json:"branches"`
	Questions     bool `json:"questions"`
	Transcription bool `json:"transcription"`
	Speech        bool `json:"speech"`
}

// Part is an allowlisted participant-facing projection, never a raw tool call.
type Part struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	URL      string    `json:"url,omitempty"`
	Filename string    `json:"filename,omitempty"`
	Mime     string    `json:"mime,omitempty"`
	Display  *Display  `json:"display,omitempty"`
	Artifact *Artifact `json:"artifact,omitempty"`
}
type Display struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}
type ArtifactSource struct {
	Type      string `json:"type"`
	Encoding  string `json:"encoding,omitempty"`
	Data      string `json:"data,omitempty"`
	Reference string `json:"reference,omitempty"`
}
type Artifact struct {
	ID        string         `json:"id"`
	Filename  string         `json:"filename"`
	MimeType  string         `json:"mimeType,omitempty"`
	SizeBytes int64          `json:"sizeBytes,omitempty"`
	Source    ArtifactSource `json:"source"`
}
type Message struct {
	ID       string `json:"id"`
	Role     string `json:"role"`
	Content  []Part `json:"content"`
	ParentID string `json:"parentId,omitempty"`
}
type Snapshot struct {
	Messages         []Message           `json:"messages"`
	Running          bool                `json:"running"`
	Branches         map[string][]string `json:"branches,omitempty"`
	PendingQuestions []PendingQuestion   `json:"pendingQuestions,omitempty"`
}
type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}
type Question struct {
	Header   string           `json:"header"`
	Question string           `json:"question"`
	Options  []QuestionOption `json:"options"`
	Multiple bool             `json:"multiple"`
	Custom   bool             `json:"custom"`
}
type PendingQuestion struct {
	ID        string     `json:"id"`
	Questions []Question `json:"questions"`
}
type FirstTurn struct{ Instruction string }
type SendInput struct {
	Content   []Part
	FirstTurn *FirstTurn
}

// Adapter owns lookup, native IDs and lazy creation. State and History are read-only.
type Adapter interface {
	Capabilities(context.Context, Scope) (Capabilities, error)
	State(context.Context, Scope) (State, error)
	History(context.Context, Scope) (Snapshot, error)
	Send(context.Context, Scope, SendInput) error
	Stop(context.Context, Scope) error
}
type Editor interface {
	Edit(context.Context, Scope, string, SendInput) error
	Regenerate(context.Context, Scope, string) error
}
type QuestionResponder interface {
	ReplyQuestion(context.Context, Scope, string, [][]string) error
	RejectQuestion(context.Context, Scope, string) error
}

// Observation is a provider-scoped change notification. Providers keep native
// event envelopes behind their adapters; consumers reload the normalized
// Snapshot only after a relevant change.
type Observation struct{ Err error }
type Observer interface {
	Observe(context.Context, Scope) (<-chan Observation, error)
}
type Audio interface {
	Transcribe(context.Context, Scope, []byte, string) (string, error)
	Speech(context.Context, Scope, string) ([]byte, string, error)
}
type ArtifactContent struct {
	Data     []byte
	MimeType string
	Filename string
}
type ArtifactReader interface {
	ReadArtifact(context.Context, Scope, string) (ArtifactContent, error)
}
