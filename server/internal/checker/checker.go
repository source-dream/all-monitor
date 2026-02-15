package checker

import (
	"all-monitor/server/internal/model"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

type Checker interface {
	Type() string
	Check(ctx context.Context, target model.MonitorTarget) (model.CheckResult, *model.RelayFinanceSnapshot, error)
}

type HTTPChecker struct{}
type TCPChecker struct{}
type AIRelayChecker struct{}
type TrackingChecker struct{}

func (c *HTTPChecker) Type() string { return "http" }

func (c *HTTPChecker) Check(ctx context.Context, target model.MonitorTarget) (model.CheckResult, *model.RelayFinanceSnapshot, error) {
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.Endpoint, nil)
	if err != nil {
		return model.CheckResult{}, nil, err
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

	success := resp.StatusCode >= 200 && resp.StatusCode < 400
	result := model.CheckResult{
		TargetID:  target.ID,
		Success:   success,
		LatencyMS: int(time.Since(start).Milliseconds()),
		CheckedAt: time.Now(),
	}
	if !success {
		result.ErrorMsg = resp.Status
	}
	return result, nil, nil
}

func (c *TCPChecker) Type() string { return "tcp" }

func (c *TCPChecker) Check(ctx context.Context, target model.MonitorTarget) (model.CheckResult, *model.RelayFinanceSnapshot, error) {
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
		}, nil, nil
	}
	_ = conn.Close()

	return model.CheckResult{
		TargetID:  target.ID,
		Success:   true,
		LatencyMS: int(time.Since(start).Milliseconds()),
		CheckedAt: time.Now(),
	}, nil, nil
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
	case "tcp", "server", "node":
		return &TCPChecker{}, nil
	case "subscription":
		return &HTTPChecker{}, nil
	case "ai":
		return &AIRelayChecker{}, nil
	case "tracking":
		return &TrackingChecker{}, nil
	default:
		return nil, errors.New("unsupported target type")
	}
}
