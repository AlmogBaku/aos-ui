package opencode

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"strings"

	"aosui/gateway/conversation"
)

const maxDisplayPayloadBytes = 256 << 10

var displayKinds = map[string]string{
	"render_chart": "chart",
	"render_map":   "map",
	"render_stats": "stats",
	"present_plan": "plan",
}

func projectDisplay(id, tool, status string, input json.RawMessage) *conversation.Display {
	kind := displayKinds[tool]
	if kind == "" || status != "completed" || id == "" || len(id) > 256 || len(input) == 0 || len(input) > maxDisplayPayloadBytes {
		return nil
	}
	valid := false
	switch kind {
	case "chart":
		valid = validChart(input)
	case "map":
		valid = validMap(input)
	case "stats":
		valid = validStats(input)
	case "plan":
		valid = validPlan(input)
	}
	if !valid {
		return nil
	}
	payload, err := json.Marshal(struct {
		Args json.RawMessage `json:"args"`
	}{Args: input})
	if err != nil || len(payload) > maxDisplayPayloadBytes {
		return nil
	}
	return &conversation.Display{ID: id, Kind: kind, Payload: payload}
}

func decodeStrict(raw json.RawMessage, target any) bool {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return false
	}
	return decoder.Decode(&struct{}{}) == io.EOF
}

func validText(value string) bool { return strings.TrimSpace(value) != "" }

type planArgs struct {
	ID    string     `json:"id"`
	Title string     `json:"title"`
	Steps []planStep `json:"steps"`
}

type planStep struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Status string `json:"status"`
}

func validPlan(raw json.RawMessage) bool {
	var args planArgs
	if !decodeStrict(raw, &args) || !validText(args.ID) || !validText(args.Title) || len(args.Steps) == 0 {
		return false
	}
	for _, step := range args.Steps {
		if !validText(step.ID) || !validText(step.Label) {
			return false
		}
		switch step.Status {
		case "pending", "active", "completed", "failed":
		default:
			return false
		}
	}
	return true
}

type mapArgs struct {
	Title     string        `json:"title"`
	Locations []mapLocation `json:"locations"`
}

type mapLocation struct {
	ID        string  `json:"id"`
	Label     string  `json:"label"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

func validMap(raw json.RawMessage) bool {
	var args mapArgs
	if !decodeStrict(raw, &args) || !validText(args.Title) || len(args.Locations) == 0 {
		return false
	}
	for _, location := range args.Locations {
		if !validText(location.ID) || !validText(location.Label) || !finite(location.Latitude) || !finite(location.Longitude) || location.Latitude < -90 || location.Latitude > 90 || location.Longitude < -180 || location.Longitude > 180 {
			return false
		}
	}
	return true
}

type chartArgs struct {
	Title  string           `json:"title"`
	Type   string           `json:"type,omitempty"`
	XKey   string           `json:"xKey"`
	Series []chartSeries    `json:"series"`
	Data   []map[string]any `json:"data"`
}

type chartSeries struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

func validChart(raw json.RawMessage) bool {
	var args chartArgs
	if !decodeStrict(raw, &args) || !validText(args.Title) || !validText(args.XKey) || len(args.Series) == 0 || len(args.Data) == 0 {
		return false
	}
	if args.Type == "" {
		args.Type = "line"
	}
	if args.Type != "line" && args.Type != "bar" && args.Type != "pie" {
		return false
	}
	for _, series := range args.Series {
		if !validText(series.Key) || !validText(series.Label) {
			return false
		}
	}
	if args.Type == "pie" && len(args.Series) != 1 {
		return false
	}
	total := 0.0
	for _, row := range args.Data {
		if _, ok := row[args.XKey]; !ok || !validChartRow(row) {
			return false
		}
		for _, series := range args.Series {
			value, ok := row[series.Key].(float64)
			if !ok || !finite(value) || (args.Type == "pie" && value < 0) {
				return false
			}
			if args.Type == "pie" {
				total += value
			}
		}
	}
	return args.Type != "pie" || total > 0
}

func validChartRow(row map[string]any) bool {
	for _, value := range row {
		switch typed := value.(type) {
		case string:
		case float64:
			if !finite(typed) {
				return false
			}
		default:
			return false
		}
	}
	return true
}

type statsArgs struct {
	Title       string     `json:"title,omitempty"`
	Description string     `json:"description,omitempty"`
	Stats       []statItem `json:"stats"`
}

type statItem struct {
	Key       string         `json:"key"`
	Label     string         `json:"label"`
	Value     any            `json:"value"`
	Format    *statFormat    `json:"format,omitempty"`
	Diff      *statDiff      `json:"diff,omitempty"`
	Sparkline *statSparkline `json:"sparkline,omitempty"`
}

type statFormat struct {
	Kind     string `json:"kind"`
	Decimals *int   `json:"decimals,omitempty"`
	Compact  *bool  `json:"compact,omitempty"`
	Currency string `json:"currency,omitempty"`
	Basis    string `json:"basis,omitempty"`
}

type statDiff struct {
	Value        float64 `json:"value"`
	Decimals     *int    `json:"decimals,omitempty"`
	UpIsPositive *bool   `json:"upIsPositive,omitempty"`
	Label        string  `json:"label,omitempty"`
}

type statSparkline struct {
	Data  []float64 `json:"data"`
	Color string    `json:"color,omitempty"`
}

func validStats(raw json.RawMessage) bool {
	var args statsArgs
	if !decodeStrict(raw, &args) || (args.Title != "" && !validText(args.Title)) || (args.Description != "" && !validText(args.Description)) || len(args.Stats) == 0 {
		return false
	}
	for _, stat := range args.Stats {
		if !validText(stat.Key) || !validText(stat.Label) || !validStatValue(stat.Value) || !validStatFormat(stat.Format) {
			return false
		}
		if stat.Diff != nil && (!finite(stat.Diff.Value) || negative(stat.Diff.Decimals) || (stat.Diff.Label != "" && !validText(stat.Diff.Label))) {
			return false
		}
		if stat.Sparkline != nil {
			if len(stat.Sparkline.Data) < 2 || (stat.Sparkline.Color != "" && !validText(stat.Sparkline.Color)) {
				return false
			}
			for _, value := range stat.Sparkline.Data {
				if !finite(value) {
					return false
				}
			}
		}
	}
	return true
}

func validStatValue(value any) bool {
	switch typed := value.(type) {
	case string:
		return true
	case float64:
		return finite(typed)
	default:
		return false
	}
}

func validStatFormat(format *statFormat) bool {
	if format == nil {
		return true
	}
	if negative(format.Decimals) {
		return false
	}
	switch format.Kind {
	case "text":
		return format.Decimals == nil && format.Compact == nil && format.Currency == "" && format.Basis == ""
	case "number":
		return format.Currency == "" && format.Basis == ""
	case "currency":
		return validText(format.Currency) && format.Compact == nil && format.Basis == ""
	case "percent":
		return format.Compact == nil && format.Currency == "" && (format.Basis == "" || format.Basis == "fraction" || format.Basis == "unit")
	default:
		return false
	}
}

func negative(value *int) bool { return value != nil && *value < 0 }

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
