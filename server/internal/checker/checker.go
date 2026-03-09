package checker

import (
	"all-monitor/server/internal/model"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

type Checker interface {
	Type() string
	Check(ctx context.Context, target model.MonitorTarget) (model.CheckResult, *model.RelayFinanceSnapshot, error)
}

type HTTPChecker struct{}
type PortChecker struct {
	ForceProtocol string
}
type AIRelayChecker struct{}
type TrackingChecker struct{}

type httpConfig struct {
	Method         string            `json:"method"`
	Headers        map[string]string `json:"headers"`
	Body           string            `json:"body"`
	ExpectedStatus string            `json:"expected_status"`
}

func parseHTTPConfig(raw string) httpConfig {
	cfg := httpConfig{
		Method:         http.MethodGet,
		Headers:        map[string]string{},
		Body:           "",
		ExpectedStatus: "2xx",
	}
	if strings.TrimSpace(raw) == "" {
		return cfg
	}
	_ = json.Unmarshal([]byte(raw), &cfg)
	cfg.Method = strings.ToUpper(strings.TrimSpace(cfg.Method))
	switch cfg.Method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodHead, http.MethodOptions:
	default:
		cfg.Method = http.MethodGet
	}
	if cfg.Headers == nil {
		cfg.Headers = map[string]string{}
	}
	if strings.TrimSpace(cfg.ExpectedStatus) == "" {
		cfg.ExpectedStatus = "2xx"
	}
	return cfg
}

func validateExpectedStatus(rule string, statusCode int) (bool, bool) {
	trimmed := strings.TrimSpace(strings.ToLower(rule))
	if trimmed == "" {
		trimmed = "2xx"
	}
	if len(trimmed) == 3 && trimmed[1:] == "xx" && trimmed[0] >= '1' && trimmed[0] <= '5' {
		base := int(trimmed[0]-'0') * 100
		return statusCode >= base && statusCode < base+100, true
	}
	parts := strings.Split(trimmed, ",")
	hasCode := false
	for _, part := range parts {
		codeText := strings.TrimSpace(part)
		if codeText == "" {
			continue
		}
		code, err := strconv.Atoi(codeText)
		if err != nil {
			continue
		}
		hasCode = true
		if statusCode == code {
			return true, true
		}
	}
	if hasCode {
		return false, true
	}
	return false, false
}

func (c *HTTPChecker) Type() string { return "http" }

func (c *HTTPChecker) Check(ctx context.Context, target model.MonitorTarget) (model.CheckResult, *model.RelayFinanceSnapshot, error) {
	start := time.Now()
	cfg := parseHTTPConfig(target.ConfigJSON)
	var bodyReader io.Reader
	if cfg.Method != http.MethodGet && cfg.Method != http.MethodHead && strings.TrimSpace(cfg.Body) != "" {
		bodyReader = bytes.NewBufferString(cfg.Body)
	}
	req, err := http.NewRequestWithContext(ctx, cfg.Method, target.Endpoint, bodyReader)
	if err != nil {
		return model.CheckResult{}, nil, err
	}
	for key, value := range cfg.Headers {
		k := strings.TrimSpace(key)
		if k == "" {
			continue
		}
		req.Header.Set(k, value)
	}

	client := &http.Client{Timeout: time.Duration(target.TimeoutMS) * time.Millisecond}
	resp, err := client.Do(req)
	if err != nil {
		return model.CheckResult{
			TargetID:  target.ID,
			Success:   false,
			LatencyMS: int(time.Since(start).Milliseconds()),
			ErrorMsg:  err.Error(),
			CheckedAt: time.Now(),
		}, nil, nil
	}
	defer resp.Body.Close()

	success, validRule := validateExpectedStatus(cfg.ExpectedStatus, resp.StatusCode)
	result := model.CheckResult{
		TargetID:  target.ID,
		Success:   success,
		LatencyMS: int(time.Since(start).Milliseconds()),
		CheckedAt: time.Now(),
	}
	if !validRule {
		result.Success = false
		result.ErrorMsg = "invalid expected_status config"
		return result, nil, nil
	}
	if !success {
		result.ErrorMsg = resp.Status
	}
	return result, nil, nil
}

func (c *PortChecker) Type() string { return "port" }

type portConfig struct {
	Protocol   string `json:"protocol"`
	UDPMode    string `json:"udp_mode"`
	UDPPayload string `json:"udp_payload"`
	UDPExpect  string `json:"udp_expect"`
}

func parsePortConfig(raw string) portConfig {
	cfg := portConfig{Protocol: "ping", UDPMode: "send_only", UDPPayload: "ping"}
	if strings.TrimSpace(raw) == "" {
		return cfg
	}
	_ = json.Unmarshal([]byte(raw), &cfg)
	switch cfg.Protocol {
	case "ping", "tcp", "udp":
	default:
		cfg.Protocol = "ping"
	}
	if cfg.UDPMode != "request_response" {
		cfg.UDPMode = "send_only"
	}
	if strings.TrimSpace(cfg.UDPPayload) == "" {
		cfg.UDPPayload = "ping"
	}
	return cfg
}

func (c *PortChecker) Check(ctx context.Context, target model.MonitorTarget) (model.CheckResult, *model.RelayFinanceSnapshot, error) {
	cfg := parsePortConfig(target.ConfigJSON)
	protocol := cfg.Protocol
	if c.ForceProtocol != "" {
		protocol = c.ForceProtocol
	}
	if protocol == "udp" {
		return c.checkUDP(ctx, target, cfg), nil, nil
	}
	if protocol == "tcp" {
		return c.checkTCP(ctx, target), nil, nil
	}
	return c.checkPing(ctx, target), nil, nil

}

func pingHostFromEndpoint(endpoint string) string {
	trimmed := strings.TrimSpace(endpoint)
	if trimmed == "" {
		return ""
	}
	if u, err := url.Parse(trimmed); err == nil && strings.TrimSpace(u.Hostname()) != "" {
		return strings.TrimSpace(u.Hostname())
	}
	if host, port, err := net.SplitHostPort(trimmed); err == nil && strings.TrimSpace(port) != "" {
		return strings.TrimSpace(host)
	}
	if strings.HasPrefix(trimmed, "[") && strings.Contains(trimmed, "]") {
		return strings.Trim(strings.TrimSpace(trimmed), "[]")
	}
	if idx := strings.LastIndex(trimmed, ":"); idx > 0 && idx < len(trimmed)-1 && strings.Count(trimmed, ":") == 1 {
		host := strings.TrimSpace(trimmed[:idx])
		if host != "" {
			return host
		}
	}
	return trimmed
}

func (c *PortChecker) checkPing(ctx context.Context, target model.MonitorTarget) model.CheckResult {
	start := time.Now()
	host := pingHostFromEndpoint(target.Endpoint)
	if host == "" {
		return model.CheckResult{TargetID: target.ID, Success: false, LatencyMS: int(time.Since(start).Milliseconds()), ErrorMsg: "invalid ping endpoint", CheckedAt: time.Now()}
	}

	resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(resolved) == 0 {
		msg := "resolve ping host failed"
		if err != nil {
			msg = err.Error()
		}
		return model.CheckResult{TargetID: target.ID, Success: false, LatencyMS: int(time.Since(start).Milliseconds()), ErrorMsg: msg, CheckedAt: time.Now()}
	}

	ip := resolved[0].IP
	network := "ip4:icmp"
	listenAddr := "0.0.0.0"
	var reqType icmp.Type = ipv4.ICMPTypeEcho
	var replyType icmp.Type = ipv4.ICMPTypeEchoReply
	protoNum := 1
	if ip.To4() == nil {
		network = "ip6:ipv6-icmp"
		listenAddr = "::"
		reqType = ipv6.ICMPTypeEchoRequest
		replyType = ipv6.ICMPTypeEchoReply
		protoNum = 58
	}

	conn, err := icmp.ListenPacket(network, listenAddr)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "operation not permitted") || strings.Contains(strings.ToLower(err.Error()), "permission denied") {
			if latencyMS, ok, cmdErr := checkPingViaCommand(ctx, host, target.TimeoutMS, ip.To4() == nil); cmdErr == nil && ok {
				return model.CheckResult{TargetID: target.ID, Success: true, LatencyMS: latencyMS, CheckedAt: time.Now()}
			}
		}
		return model.CheckResult{TargetID: target.ID, Success: false, LatencyMS: int(time.Since(start).Milliseconds()), ErrorMsg: err.Error(), CheckedAt: time.Now()}
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(time.Duration(target.TimeoutMS) * time.Millisecond))
	echoID := os.Getpid() & 0xffff
	echoSeq := int(time.Now().UnixNano() & 0xffff)
	msg := icmp.Message{
		Type: reqType,
		Code: 0,
		Body: &icmp.Echo{ID: echoID, Seq: echoSeq, Data: []byte("all-monitor-ping")},
	}
	payload, err := msg.Marshal(nil)
	if err != nil {
		return model.CheckResult{TargetID: target.ID, Success: false, LatencyMS: int(time.Since(start).Milliseconds()), ErrorMsg: err.Error(), CheckedAt: time.Now()}
	}
	if _, err := conn.WriteTo(payload, &net.IPAddr{IP: ip}); err != nil {
		return model.CheckResult{TargetID: target.ID, Success: false, LatencyMS: int(time.Since(start).Milliseconds()), ErrorMsg: err.Error(), CheckedAt: time.Now()}
	}

	buf := make([]byte, 1500)
	for {
		n, _, readErr := conn.ReadFrom(buf)
		if readErr != nil {
			return model.CheckResult{TargetID: target.ID, Success: false, LatencyMS: int(time.Since(start).Milliseconds()), ErrorMsg: readErr.Error(), CheckedAt: time.Now()}
		}
		parsed, parseErr := icmp.ParseMessage(protoNum, buf[:n])
		if parseErr != nil || parsed.Type != replyType {
			continue
		}
		echo, ok := parsed.Body.(*icmp.Echo)
		if ok && echo.ID == echoID && echo.Seq == echoSeq {
			return model.CheckResult{TargetID: target.ID, Success: true, LatencyMS: int(time.Since(start).Milliseconds()), CheckedAt: time.Now()}
		}
	}
}

func checkPingViaCommand(ctx context.Context, host string, timeoutMS int, ipv6 bool) (int, bool, error) {
	timeoutSec := timeoutMS / 1000
	if timeoutSec <= 0 {
		timeoutSec = 1
	}
	args := []string{"-n", "-c", "1", "-W", strconv.Itoa(timeoutSec), host}
	cmdName := "ping"
	if ipv6 {
		if _, err := exec.LookPath("ping6"); err == nil {
			cmdName = "ping6"
		}
	}
	cmd := exec.CommandContext(ctx, cmdName, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return 0, false, err
	}
	latency := parsePingLatencyMS(string(out))
	if latency <= 0 {
		return int(time.Duration(timeoutSec) * time.Second / time.Millisecond), true, nil
	}
	return latency, true, nil
}

var pingLatencyPattern = regexp.MustCompile(`(?i)(?:time|时间)\s*[=<＝]?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:ms|毫秒)`)

func parsePingLatencyMS(out string) int {
	m := pingLatencyPattern.FindStringSubmatch(out)
	if len(m) < 2 {
		return 0
	}
	val, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0
	}
	if val < 0 {
		return 0
	}
	return int(val + 0.5)
}

func (c *PortChecker) checkTCP(ctx context.Context, target model.MonitorTarget) model.CheckResult {
	start := time.Now()
	d := net.Dialer{Timeout: time.Duration(target.TimeoutMS) * time.Millisecond}
	conn, err := d.DialContext(ctx, "tcp", target.Endpoint)
	if err != nil {
		return model.CheckResult{
			TargetID:  target.ID,
			Success:   false,
			LatencyMS: int(time.Since(start).Milliseconds()),
			ErrorMsg:  err.Error(),
			CheckedAt: time.Now(),
		}
	}
	_ = conn.Close()

	return model.CheckResult{
		TargetID:  target.ID,
		Success:   true,
		LatencyMS: int(time.Since(start).Milliseconds()),
		CheckedAt: time.Now(),
	}
}

func (c *PortChecker) checkUDP(ctx context.Context, target model.MonitorTarget, cfg portConfig) model.CheckResult {
	start := time.Now()
	d := net.Dialer{Timeout: time.Duration(target.TimeoutMS) * time.Millisecond}
	conn, err := d.DialContext(ctx, "udp", target.Endpoint)
	if err != nil {
		return model.CheckResult{TargetID: target.ID, Success: false, LatencyMS: int(time.Since(start).Milliseconds()), ErrorMsg: err.Error(), CheckedAt: time.Now()}
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(time.Duration(target.TimeoutMS) * time.Millisecond))
	payload := []byte(cfg.UDPPayload)
	if _, err := conn.Write(payload); err != nil {
		return model.CheckResult{TargetID: target.ID, Success: false, LatencyMS: int(time.Since(start).Milliseconds()), ErrorMsg: err.Error(), CheckedAt: time.Now()}
	}

	if cfg.UDPMode == "request_response" {
		buf := make([]byte, 1024)
		n, err := conn.Read(buf)
		if err != nil {
			return model.CheckResult{TargetID: target.ID, Success: false, LatencyMS: int(time.Since(start).Milliseconds()), ErrorMsg: err.Error(), CheckedAt: time.Now()}
		}
		if strings.TrimSpace(cfg.UDPExpect) != "" && !strings.Contains(string(buf[:n]), cfg.UDPExpect) {
			return model.CheckResult{TargetID: target.ID, Success: false, LatencyMS: int(time.Since(start).Milliseconds()), ErrorMsg: "udp response mismatch", CheckedAt: time.Now()}
		}
	}

	return model.CheckResult{TargetID: target.ID, Success: true, LatencyMS: int(time.Since(start).Milliseconds()), CheckedAt: time.Now()}
}

func (c *AIRelayChecker) Type() string { return "ai" }

func (c *TrackingChecker) Type() string { return "tracking" }

func (c *TrackingChecker) Check(_ context.Context, target model.MonitorTarget) (model.CheckResult, *model.RelayFinanceSnapshot, error) {
	return model.CheckResult{
		TargetID:  target.ID,
		Success:   true,
		LatencyMS: 0,
		ErrorMsg:  "passive tracking target",
		CheckedAt: time.Now(),
	}, nil, nil
}

type relayConfig struct {
	APIKey string `json:"api_key"`
}

type subscriptionResp struct {
	HardLimitUSD float64 `json:"hard_limit_usd"`
}

type usageResp struct {
	TotalUsage float64 `json:"total_usage"`
}

func (c *AIRelayChecker) Check(ctx context.Context, target model.MonitorTarget) (model.CheckResult, *model.RelayFinanceSnapshot, error) {
	var cfg relayConfig
	if err := json.Unmarshal([]byte(target.ConfigJSON), &cfg); err != nil {
		return model.CheckResult{}, nil, fmt.Errorf("invalid config_json: %w", err)
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		return model.CheckResult{}, nil, errors.New("config_json.api_key is required for ai relay monitoring")
	}

	baseURL := strings.TrimRight(target.Endpoint, "/")
	client := &http.Client{Timeout: time.Duration(target.TimeoutMS) * time.Millisecond}
	start := time.Now()

	limitAmount, err := fetchSubscription(ctx, client, baseURL, cfg.APIKey)
	if err != nil {
		return model.CheckResult{
			TargetID:  target.ID,
			Success:   false,
			LatencyMS: int(time.Since(start).Milliseconds()),
			ErrorMsg:  err.Error(),
			CheckedAt: time.Now(),
		}, nil, nil
	}

	usedAmount, err := fetchUsage(ctx, client, baseURL, cfg.APIKey)
	if err != nil {
		return model.CheckResult{
			TargetID:  target.ID,
			Success:   false,
			LatencyMS: int(time.Since(start).Milliseconds()),
			ErrorMsg:  err.Error(),
			CheckedAt: time.Now(),
		}, nil, nil
	}

	balance := limitAmount - usedAmount
	if balance < 0 {
		balance = 0
	}

	result := model.CheckResult{
		TargetID:  target.ID,
		Success:   true,
		LatencyMS: int(time.Since(start).Milliseconds()),
		CheckedAt: time.Now(),
	}

	snapshot := &model.RelayFinanceSnapshot{
		TargetID:    target.ID,
		Currency:    "USD",
		LimitAmount: limitAmount,
		UsedAmount:  usedAmount,
		Balance:     balance,
		CheckedAt:   time.Now(),
	}

	return result, snapshot, nil
}

func fetchSubscription(ctx context.Context, client *http.Client, baseURL, apiKey string) (float64, error) {
	paths := []string{"/v1/dashboard/billing/subscription", "/dashboard/billing/subscription"}
	var lastErr error
	for _, path := range paths {
		val, err := doBillingRequest[subscriptionResp](ctx, client, baseURL+path, apiKey)
		if err == nil {
			return val.HardLimitUSD, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("subscription endpoint unavailable")
	}
	return 0, lastErr
}

func fetchUsage(ctx context.Context, client *http.Client, baseURL, apiKey string) (float64, error) {
	paths := []string{"/v1/dashboard/billing/usage", "/dashboard/billing/usage"}
	var lastErr error
	for _, path := range paths {
		val, err := doBillingRequest[usageResp](ctx, client, baseURL+path, apiKey)
		if err == nil {
			return val.TotalUsage / 100, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("usage endpoint unavailable")
	}
	return 0, lastErr
}

func doBillingRequest[T any](ctx context.Context, client *http.Client, url, apiKey string) (T, error) {
	var out T
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return out, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := client.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return out, fmt.Errorf("%s returned %d: %s", url, resp.StatusCode, strings.TrimSpace(string(body)))
	}

	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return out, err
	}
	return out, nil
}

func SelectChecker(targetType string) (Checker, error) {
	// 后续可以在此扩展 tcp、subscription、node、ai 等检测器。
	switch targetType {
	case "http", "api", "site":
		if targetType == "api" {
			return &AIRelayChecker{}, nil
		}
		return &HTTPChecker{}, nil
	case "port":
		return &PortChecker{}, nil
	case "tcp", "server", "node":
		return &PortChecker{ForceProtocol: "tcp"}, nil
	case "udp":
		return &PortChecker{ForceProtocol: "udp"}, nil
	case "ping":
		return &PortChecker{ForceProtocol: "ping"}, nil
	case "subscription":
		return &HTTPChecker{}, nil
	case "node_group":
		return &TrackingChecker{}, nil
	case "ai":
		return &AIRelayChecker{}, nil
	case "tracking":
		return &TrackingChecker{}, nil
	default:
		return nil, errors.New("unsupported target type")
	}
}
