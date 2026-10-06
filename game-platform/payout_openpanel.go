package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// errOpenPanelNotConfigured 表示还没有配置 read 权限的 OpenPanel client。
var errOpenPanelNotConfigured = errors.New("OpenPanel read client is not configured")

// payoutEvent 是一条归一化后的游玩结束事件，两端字段差异在这里抹平。
type payoutEvent struct {
	GameID      string
	Source      string
	DurationMS  int64
	DeviceCount int
	DeviceMACs  []string
	ProfileID   string
	OccurredAt  time.Time
}

type openPanelClient struct {
	config OpenPanelConfig
	client *http.Client
}

func newOpenPanelClient(config OpenPanelConfig, timeout time.Duration) *openPanelClient {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &openPanelClient{config: config, client: &http.Client{Timeout: timeout}}
}

func (c *openPanelClient) configured() bool { return c.config.configured() }

// events 依次拉取每组 read client 在 [start, end) 内的事件。
// 未配置的 client 会被跳过；全都没配置时返回 errOpenPanelNotConfigured。
func (c *openPanelClient) events(ctx context.Context, start, end time.Time) ([]payoutEvent, error) {
	if !c.configured() {
		return nil, errOpenPanelNotConfigured
	}
	all := []payoutEvent{}
	for _, client := range c.config.Clients {
		if client.ClientSecret == "" || client.ProjectID == "" || client.ClientID == "" {
			continue
		}
		events, err := c.clientEvents(ctx, client, start, end)
		if err != nil {
			return nil, fmt.Errorf("openpanel %s: %w", client.Name, err)
		}
		all = append(all, events...)
	}
	return all, nil
}

const (
	openPanelPageSize  = 1000
	openPanelMaxPages  = 50
	openPanelMaxEvents = 200000
)

func (c *openPanelClient) clientEvents(ctx context.Context, client OpenPanelClientConfig, start, end time.Time) ([]payoutEvent, error) {
	out := []payoutEvent{}
	for page := 0; page < openPanelMaxPages; page++ {
		payload, err := c.fetchPage(ctx, client, start, end, page*openPanelPageSize)
		if err != nil {
			return nil, err
		}
		if len(payload.Data) == 0 {
			break
		}
		for _, row := range payload.Data {
			if event, ok := normalizePayoutEvent(row, client.Name); ok {
				out = append(out, event)
			}
		}
		if len(out) > openPanelMaxEvents {
			return nil, fmt.Errorf("event count exceeds %d; narrow the month range", openPanelMaxEvents)
		}
		if len(payload.Data) < openPanelPageSize {
			break
		}
	}
	return out, nil
}

type openPanelRow struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	CreatedAt  string          `json:"createdAt"`
	ProfileID  string          `json:"profileId"`
	Properties json.RawMessage `json:"properties"`
}

type openPanelPage struct {
	Data []openPanelRow `json:"data"`
}

func (c *openPanelClient) fetchPage(ctx context.Context, client OpenPanelClientConfig, start, end time.Time, offset int) (openPanelPage, error) {
	query := url.Values{}
	query.Set("projectId", client.ProjectID)
	query.Set("start", start.UTC().Format(time.RFC3339))
	query.Set("end", end.UTC().Format(time.RFC3339))
	query.Set("limit", strconv.Itoa(openPanelPageSize))
	query.Set("offset", strconv.Itoa(offset))
	for _, name := range client.Events {
		query.Add("event", name)
	}
	endpoint := c.config.BaseURL + "/export/events?" + query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return openPanelPage{}, err
	}
	request.Header.Set("openpanel-client-id", client.ClientID)
	request.Header.Set("openpanel-client-secret", client.ClientSecret)
	request.Header.Set("Accept", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return openPanelPage{}, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024*1024))
	if err != nil {
		return openPanelPage{}, err
	}
	if response.StatusCode != http.StatusOK {
		return openPanelPage{}, fmt.Errorf("export/events returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	var payload openPanelPage
	if err := json.Unmarshal(body, &payload); err != nil {
		return openPanelPage{}, fmt.Errorf("invalid export response: %w", err)
	}
	return payload, nil
}

// normalizePayoutEvent 把两端不同的字段名映射成统一结构；缺少 game_id 的事件直接丢弃。
// source 只作为附带信息保留，不用作过滤条件（mobile 端取值 asset/remote/cached）。
func normalizePayoutEvent(row openPanelRow, clientName string) (payoutEvent, bool) {
	props := decodeProperties(row.Properties)
	gameID := stringProperty(props, "game_id")
	if gameID == "" {
		gameID = stringProperty(props, "gameId")
	}
	if gameID == "" {
		return payoutEvent{}, false
	}
	event := payoutEvent{
		GameID:     gameID,
		Source:     stringProperty(props, "source"),
		DurationMS: intProperty(props, "duration_ms"),
		ProfileID:  row.ProfileID,
	}
	if event.DurationMS <= 0 {
		event.DurationMS = intProperty(props, "session_duration_ms")
	}
	if profile := stringProperty(props, "profile_id"); profile != "" && event.ProfileID == "" {
		event.ProfileID = profile
	}
	macs := stringProperty(props, "device_macs")
	if macs == "" {
		macs = stringProperty(props, "device_mac")
	}
	event.DeviceMACs = splitList(macs)
	event.DeviceCount = int(intProperty(props, "device_count"))
	if event.DeviceCount <= 0 {
		event.DeviceCount = len(event.DeviceMACs)
	}
	event.OccurredAt = eventTime(props, row.CreatedAt)
	if event.Source == "" {
		event.Source = clientName
	}
	return event, true
}

func decodeProperties(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var props map[string]any
	if err := json.Unmarshal(raw, &props); err == nil {
		return props
	}
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return map[string]any{}
	}
	if err := json.Unmarshal([]byte(encoded), &props); err != nil {
		return map[string]any{}
	}
	return props
}

func stringProperty(props map[string]any, key string) string {
	value, ok := props[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return ""
	}
}

func intProperty(props map[string]any, key string) int64 {
	value, ok := props[key]
	if !ok || value == nil {
		return 0
	}
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}

// eventTime 优先用事件属性里的毫秒时间戳，回退到导出接口的 createdAt。
func eventTime(props map[string]any, fallback string) time.Time {
	for _, key := range []string{"createdAt", "created_at", "timestamp"} {
		value := stringProperty(props, key)
		if value == "" {
			continue
		}
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
			if parsed > 1e12 {
				return time.UnixMilli(parsed)
			}
			return time.Unix(parsed, 0)
		}
		if parsed, err := time.Parse(time.RFC3339, value); err == nil {
			return parsed
		}
	}
	if parsed, err := time.Parse(time.RFC3339, fallback); err == nil {
		return parsed
	}
	if parsed, err := strconv.ParseInt(fallback, 10, 64); err == nil && parsed > 0 {
		if parsed > 1e12 {
			return time.UnixMilli(parsed)
		}
		return time.Unix(parsed, 0)
	}
	return time.Time{}
}

func splitList(value string) []string {
	out := []string{}
	for _, item := range strings.Split(value, ",") {
		item = strings.ToLower(strings.TrimSpace(item))
		if item != "" {
			out = append(out, item)
		}
	}
	sort.Strings(out)
	return out
}
