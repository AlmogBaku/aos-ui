package opencode

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"aosui/gateway/conversation"
)

const (
	maxPendingQuestionRequests = 32
	maxQuestionsPerRequest     = 16
	maxQuestionOptions         = 32
	maxQuestionHeaderBytes     = 256
	maxQuestionTextBytes       = 8 << 10
	maxOptionLabelBytes        = 1024
	maxOptionDescriptionBytes  = 4 << 10
	maxQuestionAnswerBytes     = 4 << 10
)

var publicQuestionIDPattern = regexp.MustCompile(`^q_[a-f0-9]{32}$`)

type nativeQuestionRequest struct {
	ID        string           `json:"id"`
	SessionID string           `json:"sessionID"`
	Questions []nativeQuestion `json:"questions"`
}

type nativeQuestion struct {
	Header   string                 `json:"header"`
	Question string                 `json:"question"`
	Options  []nativeQuestionOption `json:"options"`
	Multiple bool                   `json:"multiple"`
	Custom   bool                   `json:"custom"`
}

type nativeQuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

func (a *Adapter) listQuestions(ctx context.Context) ([]nativeQuestionRequest, error) {
	var requests []nativeQuestionRequest
	if err := a.get(ctx, "/question", nil, &requests); err != nil {
		return nil, err
	}
	return requests, nil
}

func projectQuestions(scope conversation.Scope, sessionID string, requests []nativeQuestionRequest) []conversation.PendingQuestion {
	result := make([]conversation.PendingQuestion, 0)
	for _, request := range requests {
		if len(result) == maxPendingQuestionRequests {
			break
		}
		if request.SessionID != sessionID {
			continue
		}
		projected, ok := projectQuestionRequest(scope, request)
		if ok {
			result = append(result, projected)
		}
	}
	return result
}

func projectQuestionRequest(scope conversation.Scope, request nativeQuestionRequest) (conversation.PendingQuestion, bool) {
	if !safeNativeQuestionID(request.ID) || len(request.Questions) == 0 || len(request.Questions) > maxQuestionsPerRequest {
		return conversation.PendingQuestion{}, false
	}
	projected := conversation.PendingQuestion{
		ID:        publicQuestionID(scope, request.ID),
		Questions: make([]conversation.Question, 0, len(request.Questions)),
	}
	for _, question := range request.Questions {
		if !safeQuestionText(question.Header, maxQuestionHeaderBytes) ||
			!safeQuestionText(question.Question, maxQuestionTextBytes) ||
			len(question.Options) > maxQuestionOptions ||
			(len(question.Options) == 0 && !question.Custom) {
			return conversation.PendingQuestion{}, false
		}
		value := conversation.Question{
			Header:   question.Header,
			Question: question.Question,
			Multiple: question.Multiple,
			Custom:   question.Custom,
			Options:  make([]conversation.QuestionOption, 0, len(question.Options)),
		}
		labels := make(map[string]bool, len(question.Options))
		for _, option := range question.Options {
			if !safeQuestionText(option.Label, maxOptionLabelBytes) ||
				(option.Description != "" && !safeQuestionText(option.Description, maxOptionDescriptionBytes)) ||
				labels[option.Label] {
				return conversation.PendingQuestion{}, false
			}
			labels[option.Label] = true
			value.Options = append(value.Options, conversation.QuestionOption{Label: option.Label, Description: option.Description})
		}
		projected.Questions = append(projected.Questions, value)
	}
	return projected, true
}

func safeNativeQuestionID(value string) bool {
	return referencePattern.MatchString(value)
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

func publicQuestionID(scope conversation.Scope, nativeID string) string {
	sum := sha256.Sum256([]byte(scope.Agent + "\x00" + scope.Ref + "\x00" + nativeID))
	return fmt.Sprintf("q_%x", sum[:16])
}

func (a *Adapter) authorizedQuestion(ctx context.Context, scope conversation.Scope, publicID string) (*nativeQuestionRequest, error) {
	session, _, err := a.resolve(ctx, scope, false)
	if err != nil {
		return nil, err
	}
	if session == nil || !publicQuestionIDPattern.MatchString(publicID) {
		return nil, conversation.ErrForbidden
	}
	requests, err := a.listQuestions(ctx)
	if err != nil {
		return nil, err
	}
	var match *nativeQuestionRequest
	for index := range requests {
		request := &requests[index]
		if request.SessionID != session.ID {
			continue
		}
		if _, ok := projectQuestionRequest(scope, *request); !ok || publicQuestionID(scope, request.ID) != publicID {
			continue
		}
		if match != nil {
			return nil, conversation.ErrAmbiguous
		}
		match = request
	}
	if match == nil {
		return nil, conversation.ErrForbidden
	}
	return match, nil
}

func validQuestionAnswers(request nativeQuestionRequest, answers [][]string) bool {
	if len(answers) != len(request.Questions) {
		return false
	}
	for index, answer := range answers {
		question := request.Questions[index]
		if (!question.Multiple && len(answer) > 1) || len(answer) > maxQuestionOptions+1 {
			return false
		}
		options := make(map[string]bool, len(question.Options))
		for _, option := range question.Options {
			options[option.Label] = true
		}
		seen := make(map[string]bool, len(answer))
		for _, value := range answer {
			if !safeQuestionText(value, maxQuestionAnswerBytes) || seen[value] || (!options[value] && !question.Custom) {
				return false
			}
			seen[value] = true
		}
	}
	return true
}

func (a *Adapter) ReplyQuestion(ctx context.Context, scope conversation.Scope, publicID string, answers [][]string) error {
	unlock := a.lockScope(scope)
	defer unlock()
	request, err := a.authorizedQuestion(ctx, scope, publicID)
	if err != nil {
		return err
	}
	if !validQuestionAnswers(*request, answers) {
		return conversation.ErrForbidden
	}
	if err := a.post(ctx, "/question/"+url.PathEscape(request.ID)+"/reply", map[string]any{"answers": answers}, nil); err != nil {
		return sendMutationError(err)
	}
	return nil
}

func (a *Adapter) RejectQuestion(ctx context.Context, scope conversation.Scope, publicID string) error {
	unlock := a.lockScope(scope)
	defer unlock()
	request, err := a.authorizedQuestion(ctx, scope, publicID)
	if err != nil {
		return err
	}
	if err := a.post(ctx, "/question/"+url.PathEscape(request.ID)+"/reject", nil, nil); err != nil {
		return sendMutationError(err)
	}
	return nil
}

var _ conversation.QuestionResponder = (*Adapter)(nil)
