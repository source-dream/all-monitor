package service

import (
	"all-monitor/server/internal/checker"
	"all-monitor/server/internal/model"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
	"gorm.io/gorm"
)

type TargetService struct {
	DB          *gorm.DB
	GeoResolver GeoResolver

	latencyJobsMu sync.RWMutex
	latencyJobs   map[string]*subscriptionLatencyJob

	refreshMu       sync.Mutex
	refreshInFlight map[uint]*subscriptionRefreshCall

	fetchProtocolMu    sync.Mutex
	fetchProtocolState map[string]fetchHostProtocolState

	subscriptionNodeColumnOnce        sync.Once
	subscriptionNodeHasExtendedColumn bool
}

type subscriptionRefreshCall struct {
	done chan struct{}
	snap *model.SubscriptionSnapshot
	err  error
}

type GeoResolver interface {
	Lookup(ip string) (string, error)
}

type TrackingIngestItem struct {
	EventName  string         `json:"event_name"`
	Page       string         `json:"page"`
	Count      int            `json:"count"`
	ClientID   string         `json:"client_id"`
	UserID     string         `json:"user_id"`
	OccurredAt int64          `json:"occurred_at"`
	Meta       map[string]any `json:"meta"`
}

type trackingConfig struct {
	WriteKey             string `json:"write_key"`
	MetricMode           string `json:"metric_mode"`
	UVIdentity           string `json:"uv_identity"`
	UserGroupMode        string `json:"user_group_mode"`
	InactiveThresholdMin int    `json:"inactive_threshold_min"`
}

type subscriptionConfig struct {
	LatencyConcurrency int      `json:"latency_concurrency"`
	LatencyTimeoutMS   int      `json:"latency_timeout_ms"`
	E2ETimeoutMS       int      `json:"e2e_timeout_ms"`
	FetchTimeoutMS     int      `json:"fetch_timeout_ms"`
	FetchRetries       int      `json:"fetch_retries"`
	FetchHTTPMode      string   `json:"fetch_http_mode"`
	FetchProxyURL      string   `json:"fetch_proxy_url"`
	FetchUserAgent     string   `json:"fetch_user_agent"`
	FetchCookie        string   `json:"fetch_cookie"`
	LatencyProbeCount  int      `json:"latency_probe_count"`
	LatencyIntervalSec int      `json:"latency_interval_sec"`
	WeightDomestic     float64  `json:"weight_domestic"`
	WeightOverseas     float64  `json:"weight_overseas"`
	ProbeURLsDomestic  []string `json:"probe_urls_domestic"`
	ProbeURLsOverseas  []string `json:"probe_urls_overseas"`
	SingBoxPath        string   `json:"singbox_path"`
	ManualExpireAt     string   `json:"manual_expire_at"`
}

var defaultProbeURLsDomestic = []string{
	"https://connectivitycheck.platform.hicloud.com/generate_204",
	"https://www.qq.com/favicon.ico",
}

var defaultProbeURLsOverseas = []string{
	"https://www.google.com/generate_204",
	"https://cp.cloudflare.com/generate_204",
}

const defaultSubscriptionFetchUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

const (
	fetchHTTPModeAuto = "auto"
	fetchHTTPModeH2   = "h2"
	fetchHTTPModeH1   = "h1"
)

type fetchHostProtocolState struct {
	Preferred string
	AvoidH1To time.Time
	AvoidH2To time.Time
}

type parsedSubscriptionNode struct {
	UID      string
	Name     string
	Protocol string
	Server   string
	Port     int
	RawJSON  string
	Order    int
}

func (s *TargetService) CreateTarget(target *model.MonitorTarget) error {
	return s.DB.Create(target).Error
}

func (s *TargetService) ListTargets() ([]model.MonitorTarget, error) {
	var targets []model.MonitorTarget
	err := s.DB.Order("id desc").Find(&targets).Error
	return targets, err
}

func (s *TargetService) UpdateTarget(id uint, input *model.MonitorTarget) error {
	updates := map[string]any{
		"name":         input.Name,
		"type":         input.Type,
		"endpoint":     input.Endpoint,
		"interval_sec": input.IntervalSec,
		"timeout_ms":   input.TimeoutMS,
		"enabled":      input.Enabled,
		"config_json":  input.ConfigJSON,
	}
	return s.DB.Model(&model.MonitorTarget{}).Where("id = ?", id).Updates(updates).Error
}

func (s *TargetService) DeleteTarget(id uint) error {
	return s.DB.Delete(&model.MonitorTarget{}, id).Error
}

func (s *TargetService) GetTarget(id uint) (*model.MonitorTarget, error) {
	var target model.MonitorTarget
	if err := s.DB.First(&target, id).Error; err != nil {
		return nil, err
	}
	return &target, nil
}

func (s *TargetService) DashboardOverview() (map[string]any, error) {
	var total int64
	if err := s.DB.Model(&model.MonitorTarget{}).Count(&total).Error; err != nil {
		return nil, err
	}

	since := time.Now().Add(-24 * time.Hour)
	var totalChecks int64
	var successChecks int64

	if err := s.DB.Model(&model.CheckResult{}).Where("checked_at >= ?", since).Count(&totalChecks).Error; err != nil {
		return nil, err
	}
	if err := s.DB.Model(&model.CheckResult{}).Where("checked_at >= ? AND success = ?", since, true).Count(&successChecks).Error; err != nil {
		return nil, err
	}

	// 使用聚合查询计算最近24小时平均延迟，供首页总览卡片展示。
	var avgLatency float64
	if err := s.DB.Model(&model.CheckResult{}).Where("checked_at >= ?", since).Select("COALESCE(AVG(latency_ms), 0)").Scan(&avgLatency).Error; err != nil {
		return nil, err
	}

	availability := 100.0
	if totalChecks > 0 {
		availability = float64(successChecks) / float64(totalChecks) * 100
	}

	return map[string]any{
		"target_count":       total,
		"check_count_24h":    totalChecks,
		"availability_24h":   availability,
		"avg_latency_24h_ms": avgLatency,
	}, nil
}

func (s *TargetService) CheckNow(id uint) (*model.CheckResult, error) {
	var target model.MonitorTarget
	if err := s.DB.First(&target, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errors.New("target not found")
		}
		return nil, err
	}

	if target.Type == "subscription" {
		snap, err := s.refreshSubscription(id)
		if err != nil {
			return nil, err
		}
		result := model.CheckResult{
			TargetID:  target.ID,
			Success:   snap.Reachable,
			LatencyMS: snap.LatencyMS,
			ErrorMsg:  snap.ErrorMsg,
			CheckedAt: snap.CheckedAt,
		}
		if err := s.DB.Create(&result).Error; err != nil {
			return nil, err
		}
		return &result, nil
	}

	ck, err := checker.SelectChecker(target.Type)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(target.TimeoutMS+1000)*time.Millisecond)
	defer cancel()

	result, snapshot, checkErr := ck.Check(ctx, target)
	if checkErr != nil {
		result = model.CheckResult{
			TargetID:  target.ID,
			Success:   false,
			LatencyMS: 0,
			ErrorMsg:  checkErr.Error(),
			CheckedAt: time.Now(),
		}
	}

	if err := s.DB.Create(&result).Error; err != nil {
		return nil, err
	}
	if snapshot != nil {
		if err := s.DB.Create(snapshot).Error; err != nil {
			return nil, err
		}
	}

	return &result, nil
}

func (s *TargetService) FinanceSummary(id uint) (map[string]any, error) {
	var latest model.RelayFinanceSnapshot
	err := s.DB.Where("target_id = ?", id).Order("checked_at desc").First(&latest).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return map[string]any{"has_data": false}, nil
		}
		return nil, err
	}

	now := time.Now()
	startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())

	var first model.RelayFinanceSnapshot
	if err := s.DB.Where("target_id = ? AND checked_at >= ?", id, startOfDay).Order("checked_at asc").First(&first).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			first = latest
		} else {
			return nil, err
		}
	}

	dailySpent := latest.UsedAmount - first.UsedAmount
	if dailySpent < 0 {
		dailySpent = 0
	}

	return map[string]any{
		"has_data":     true,
		"currency":     latest.Currency,
		"balance":      latest.Balance,
		"used_total":   latest.UsedAmount,
		"limit_amount": latest.LimitAmount,
		"daily_spent":  dailySpent,
		"updated_at":   latest.CheckedAt,
	}, nil
}

func (s *TargetService) RefreshSubscription(id uint) error {
	_, err := s.refreshSubscription(id)
	return err
}

func (s *TargetService) SubscriptionSummary(id uint) (map[string]any, error) {
	target, cfg, targetErr := s.getSubscriptionTarget(id)
	if targetErr != nil {
		return nil, targetErr
	}

	var latest model.SubscriptionSnapshot
	query := s.DB.Where("target_id = ?", id).Order("checked_at desc").Limit(1).Find(&latest)
	if query.Error != nil {
		return nil, query.Error
	}
	refreshing := false
	autoRefreshEnabled := target.IntervalSec > 0
	if query.RowsAffected == 0 {
		if autoRefreshEnabled {
			// Do not block summary request on first pull.
			_, _ = s.refreshSubscriptionWithSingleflight(id, false)
			return map[string]any{"has_data": false, "refreshing": true}, nil
		}
		return map[string]any{"has_data": false, "refreshing": false}, nil
	} else {
		if autoRefreshEnabled && latest.CheckedAt.Before(time.Now().Add(-time.Duration(target.IntervalSec)*time.Second)) {
			_, _ = s.refreshSubscriptionWithSingleflight(id, false)
			refreshing = true
		}
	}

	stats := map[string]int{}
	_ = json.Unmarshal([]byte(latest.ProtocolStatsJSON), &stats)
	expireAt := latest.ExpireAt
	if manualExpire := parseManualExpireAt(cfg.ManualExpireAt); manualExpire != nil {
		expireAt = manualExpire
	}

	availableTotal := int64(0)
	_ = s.DB.Model(&model.SubscriptionNode{}).
		Where("target_id = ? AND last_latency_ms IS NOT NULL AND last_latency_ms >= 0", id).
		Count(&availableTotal).Error

	return map[string]any{
		"has_data":        true,
		"refreshing":      refreshing,
		"reachable":       latest.Reachable,
		"http_status":     latest.HTTPStatus,
		"latency_ms":      latest.LatencyMS,
		"error_msg":       latest.ErrorMsg,
		"node_total":      latest.NodeTotal,
		"available_total": int(availableTotal),
		"protocol_stats":  stats,
		"upload_bytes":    latest.UploadBytes,
		"download_bytes":  latest.DownloadBytes,
		"total_bytes":     latest.TotalBytes,
		"remaining_bytes": latest.RemainingBytes,
		"expire_at":       expireAt,
		"last_checked_at": latest.CheckedAt,
	}, nil
}

func (s *TargetService) SubscriptionNodes(id uint, sortBy, order, search, protocol string) ([]model.SubscriptionNode, error) {
	var rows []model.SubscriptionNode
	query := s.DB.Where("target_id = ?", id)
	if search = strings.TrimSpace(search); search != "" {
		like := "%" + strings.ToLower(search) + "%"
		query = query.Where("lower(name) LIKE ? OR lower(server) LIKE ?", like, like)
	}
	if protocol = strings.TrimSpace(protocol); protocol != "" {
		query = query.Where("protocol = ?", strings.ToLower(protocol))
	}
	if err := query.Find(&rows).Error; err != nil {
		return nil, err
	}

	if strings.ToLower(order) != "desc" {
		order = "asc"
	}
	sortBy = strings.ToLower(strings.TrimSpace(sortBy))
	if sortBy == "" {
		sortBy = "source"
	}

	sort.Slice(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		less := false
		switch sortBy {
		case "name":
			less = strings.ToLower(a.Name) < strings.ToLower(b.Name)
		case "latency":
			if a.LastLatencyMS == nil && b.LastLatencyMS == nil {
				less = a.SourceOrder < b.SourceOrder
			} else if a.LastLatencyMS == nil {
				less = false
			} else if b.LastLatencyMS == nil {
				less = true
			} else if *a.LastLatencyMS == *b.LastLatencyMS {
				less = a.SourceOrder < b.SourceOrder
			} else {
				less = *a.LastLatencyMS < *b.LastLatencyMS
			}
		default:
			less = a.SourceOrder < b.SourceOrder
		}
		if order == "desc" {
			return !less
		}
		return less
	})

	return rows, nil
}

func (s *TargetService) SubscriptionNodeSummary(id uint, nodeUID string, since time.Time) (map[string]any, error) {
	if strings.TrimSpace(nodeUID) == "" {
		return nil, errors.New("node uid is required")
	}
	var node model.SubscriptionNode
	if err := s.DB.Where("target_id = ? AND node_uid = ?", id, nodeUID).First(&node).Error; err != nil {
		return nil, err
	}

	var total int64
	var success int64
	if err := s.DB.Model(&model.SubscriptionNodeCheck{}).Where("target_id = ? AND node_uid = ? AND checked_at >= ?", id, nodeUID, since).Count(&total).Error; err != nil {
		return nil, err
	}
	if err := s.DB.Model(&model.SubscriptionNodeCheck{}).Where("target_id = ? AND node_uid = ? AND checked_at >= ? AND success = ?", id, nodeUID, since, true).Count(&success).Error; err != nil {
		return nil, err
	}
	availability := 100.0
	if total > 0 {
		availability = float64(success) / float64(total) * 100
	}

	var avgLatency float64
	if err := s.DB.Model(&model.SubscriptionNodeCheck{}).Where("target_id = ? AND node_uid = ? AND checked_at >= ? AND success = ?", id, nodeUID, since, true).Select("COALESCE(AVG(latency_ms), 0)").Scan(&avgLatency).Error; err != nil {
		return nil, err
	}

	return map[string]any{
		"node":               node,
		"availability_24h":   availability,
		"avg_latency_24h_ms": avgLatency,
		"check_count_24h":    total,
		"success_count_24h":  success,
		"latest_latency_ms":  node.LastLatencyMS,
		"latest_checked_at":  node.LastLatencyCheckedAt,
	}, nil
}

func (s *TargetService) SubscriptionNodeSeries(id uint, nodeUID string, since time.Time) ([]map[string]any, error) {
	var checks []model.SubscriptionNodeCheck
	if err := s.DB.Where("target_id = ? AND node_uid = ? AND checked_at >= ?", id, nodeUID, since).Order("checked_at asc").Find(&checks).Error; err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(checks))
	for _, c := range checks {
		availability := 0
		if c.Success {
			availability = 100
		}
		out = append(out, map[string]any{
			"checked_at":   c.CheckedAt,
			"success":      c.Success,
			"latency_ms":   c.LatencyMS,
			"availability": availability,
			"error_msg":    c.ErrorMsg,
		})
	}
	return out, nil
}

func (s *TargetService) SubscriptionNodeLogs(id uint, nodeUID string, limit int) ([]model.SubscriptionNodeCheck, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var rows []model.SubscriptionNodeCheck
	err := s.DB.Where("target_id = ? AND node_uid = ?", id, nodeUID).Order("checked_at desc").Limit(limit).Find(&rows).Error
	return rows, err
}

func (s *TargetService) SubscriptionNodeCheckNow(id uint, nodeUID string) (map[string]any, error) {
	_, cfg, err := s.getSubscriptionTarget(id)
	if err != nil {
		return nil, err
	}
	var node model.SubscriptionNode
	if err := s.DB.Where("target_id = ? AND node_uid = ?", id, nodeUID).First(&node).Error; err != nil {
		return nil, err
	}
	lat, errMsg, probeErr := s.probeAndPersistSubscriptionNode(id, node, cfg.LatencyTimeoutMS, cfg.LatencyProbeCount, cfg)
	if probeErr != nil {
		return nil, err
	}
	return map[string]any{"success": errMsg == "", "latency_ms": lat, "error_msg": errMsg}, nil
}

func (s *TargetService) RefreshSubscriptionLatency(id uint) (map[string]any, error) {
	target, cfg, err := s.getSubscriptionTarget(id)
	if err != nil {
		return nil, err
	}
	if cfg.LatencyConcurrency <= 0 {
		return nil, errors.New("latency_concurrency must be greater than 0")
	}

	var nodes []model.SubscriptionNode
	if err := s.DB.Where("target_id = ?", id).Find(&nodes).Error; err != nil {
		return nil, err
	}
	if len(nodes) == 0 {
		return map[string]any{"updated": 0}, nil
	}

	timeoutMS := cfg.LatencyTimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = 1200
	}
	concurrency := cfg.LatencyConcurrency

	type result struct {
		ID      uint
		Latency *int
	}
	jobs := make(chan model.SubscriptionNode)
	results := make(chan result, len(nodes))

	worker := func() {
		for node := range jobs {
			lat, _, persistErr := s.probeAndPersistSubscriptionNode(id, node, timeoutMS, cfg.LatencyProbeCount, cfg)
			if persistErr != nil {
				results <- result{ID: node.ID, Latency: nil}
				continue
			}
			results <- result{ID: node.ID, Latency: lat}
		}
	}

	for i := 0; i < concurrency; i++ {
		go worker()
	}
	for _, node := range nodes {
		jobs <- node
	}
	close(jobs)

	now := time.Now()
	updated := 0
	for i := 0; i < len(nodes); i++ {
		res := <-results
		if err := s.DB.Model(&model.SubscriptionNode{}).Where("id = ?", res.ID).Updates(map[string]any{
			"last_latency_ms":         res.Latency,
			"last_latency_checked_at": now,
		}).Error; err == nil {
			updated++
		}
	}

	_ = target
	return map[string]any{"updated": updated, "timeout_ms": timeoutMS, "concurrency": concurrency}, nil
}

func (s *TargetService) probeAndPersistSubscriptionNode(targetID uint, node model.SubscriptionNode, timeoutMS int, probeCount int, cfg *subscriptionConfig) (*int, string, error) {
	traceID := subscriptionTraceID(targetID, node)
	traceStart := time.Now()
	subscriptionTraceLog(traceID, "probe_start", map[string]any{
		"target_id":   targetID,
		"node_uid":    node.NodeUID,
		"protocol":    node.Protocol,
		"server":      node.Server,
		"port":        node.Port,
		"timeout_ms":  timeoutMS,
		"probe_count": probeCount,
	})
	if cfg == nil {
		_, cfgObj, cfgErr := s.getSubscriptionTarget(targetID)
		if cfgErr != nil {
			subscriptionTraceLog(traceID, "probe_config_error", map[string]any{"error": cfgErr.Error()})
			return nil, cfgErr.Error(), cfgErr
		}
		cfg = cfgObj
	}
	probe := probeNodeLatencyMixed(node, timeoutMS, probeCount, cfg, traceID)
	var lat *int
	if probe.Success {
		val := probe.LatencyMS
		lat = &val
	}
	errMsg := probe.ErrorMsg
	now := time.Now()
	check := model.SubscriptionNodeCheck{
		TargetID:      targetID,
		NodeUID:       node.NodeUID,
		Success:       probe.Success,
		LatencyMS:     valueOrZero(lat),
		ScoreMS:       probe.ScoreMS,
		TCPMS:         probe.TCPMS,
		TLSMS:         probe.TLSMS,
		E2EDomesticMS: probe.E2EDomesticMS,
		E2EOverseasMS: probe.E2EOverseasMS,
		JitterMS:      probe.JitterMS,
		ProbeMode:     probe.ProbeMode,
		FailStage:     probe.FailStage,
		FailReason:    probe.FailReason,
		ErrorMsg:      errMsg,
		CheckedAt:     now,
	}
	persistStart := time.Now()
	if err := s.DB.Create(&check).Error; err != nil {
		subscriptionTraceLog(traceID, "persist_check_error", map[string]any{"elapsed_ms": time.Since(persistStart).Milliseconds(), "error": err.Error()})
		return nil, errMsg, err
	}
	updates := map[string]any{
		"last_latency_ms":         lat,
		"last_latency_checked_at": now,
	}
	if s.hasExtendedSubscriptionNodeColumns() {
		updates["last_score_ms"] = probe.ScoreMS
		updates["last_tcp_ms"] = probe.TCPMS
		updates["last_tls_ms"] = probe.TLSMS
		updates["last_e2e_domestic_ms"] = probe.E2EDomesticMS
		updates["last_e2e_overseas_ms"] = probe.E2EOverseasMS
		updates["last_jitter_ms"] = probe.JitterMS
		updates["last_probe_mode"] = probe.ProbeMode
		updates["last_fail_stage"] = probe.FailStage
		updates["last_fail_reason"] = probe.FailReason
		updates["last_error_msg"] = probe.ErrorMsg
	}
	if err := s.DB.Model(&model.SubscriptionNode{}).Where("id = ?", node.ID).Updates(updates).Error; err != nil {
		subscriptionTraceLog(traceID, "persist_node_error", map[string]any{"elapsed_ms": time.Since(persistStart).Milliseconds(), "error": err.Error()})
		return nil, errMsg, err
	}
	subscriptionTraceLog(traceID, "probe_done", map[string]any{
		"success":       probe.Success,
		"latency_ms":    valueOrZero(lat),
		"score_ms":      probe.ScoreMS,
		"tcp_ms":        probe.TCPMS,
		"tls_ms":        probe.TLSMS,
		"domestic_ms":   probe.E2EDomesticMS,
		"overseas_ms":   probe.E2EOverseasMS,
		"jitter_ms":     probe.JitterMS,
		"fail_stage":    probe.FailStage,
		"fail_reason":   probe.FailReason,
		"total_elapsed": time.Since(traceStart).Milliseconds(),
	})
	return lat, errMsg, nil
}

func (s *TargetService) hasExtendedSubscriptionNodeColumns() bool {
	s.subscriptionNodeColumnOnce.Do(func() {
		s.subscriptionNodeHasExtendedColumn = s.DB.Migrator().HasColumn(&model.SubscriptionNode{}, "last_e2e_domestic_ms")
	})
	return s.subscriptionNodeHasExtendedColumn
}

func (s *TargetService) MaybeAutoRefreshSubscriptionLatency(id uint) {
	target, cfg, err := s.getSubscriptionTarget(id)
	if err != nil || !target.Enabled {
		return
	}
	if cfg.LatencyConcurrency <= 0 {
		return
	}
	interval := cfg.LatencyIntervalSec
	if interval <= 0 {
		interval = 300
	}
	var last model.SubscriptionNodeCheck
	if err := s.DB.Where("target_id = ?", id).Order("checked_at desc").First(&last).Error; err == nil {
		if last.CheckedAt.After(time.Now().Add(-time.Duration(interval) * time.Second)) {
			return
		}
	}
	_, _ = s.RefreshSubscriptionLatency(id)
}

func (s *TargetService) refreshSubscription(id uint) (*model.SubscriptionSnapshot, error) {
	return s.refreshSubscriptionWithSingleflight(id, true)
}

// refreshSubscriptionWithSingleflight prevents duplicate concurrent pulls for same target.
// wait=true: caller waits for result; wait=false: trigger in background and return immediately.
func (s *TargetService) refreshSubscriptionWithSingleflight(id uint, wait bool) (*model.SubscriptionSnapshot, error) {
	s.refreshMu.Lock()
	if s.refreshInFlight == nil {
		s.refreshInFlight = make(map[uint]*subscriptionRefreshCall)
	}
	if call, ok := s.refreshInFlight[id]; ok {
		s.refreshMu.Unlock()
		if !wait {
			return nil, nil
		}
		<-call.done
		return call.snap, call.err
	}

	call := &subscriptionRefreshCall{done: make(chan struct{})}
	s.refreshInFlight[id] = call
	s.refreshMu.Unlock()

	run := func() {
		snap, err := s.refreshSubscriptionOnce(id)
		s.refreshMu.Lock()
		call.snap = snap
		call.err = err
		close(call.done)
		delete(s.refreshInFlight, id)
		s.refreshMu.Unlock()
	}

	if !wait {
		go run()
		return nil, nil
	}
	run()
	return call.snap, call.err
}

func (s *TargetService) refreshSubscriptionOnce(id uint) (*model.SubscriptionSnapshot, error) {
	target, cfg, err := s.getSubscriptionTarget(id)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	resp, body, fetchLatencyMS, fetchErr := s.fetchSubscriptionContent(target.ID, target.Endpoint, cfg)
	if resp != nil {
		defer resp.Body.Close()
	}
	if fetchErr != nil {
		latencyMS := fetchLatencyMS
		if latencyMS <= 0 {
			latencyMS = int(time.Since(start).Milliseconds())
		}
		snap := &model.SubscriptionSnapshot{TargetID: target.ID, Reachable: false, HTTPStatus: 0, LatencyMS: latencyMS, ErrorMsg: fetchErr.Error(), CheckedAt: time.Now()}
		_ = s.DB.Create(snap).Error
		return snap, nil
	}

	nodes, parseErr := parseSubscriptionNodes(body)
	if parseErr != nil {
		nodes = nil
	}
	protocolStats := map[string]int{}
	for _, n := range nodes {
		protocolStats[n.Protocol]++
	}
	statsRaw, _ := json.Marshal(protocolStats)

	up, down, total, exp := parseSubscriptionUserinfo(resp.Header.Get("subscription-userinfo"))
	remaining := total - up - down
	if remaining < 0 {
		remaining = 0
	}
	hash := sha256.Sum256(body)
	snap := &model.SubscriptionSnapshot{
		TargetID:          target.ID,
		Reachable:         resp.StatusCode < 400,
		HTTPStatus:        resp.StatusCode,
		LatencyMS:         fetchLatencyMS,
		ErrorMsg:          errString(parseErr),
		NodeTotal:         len(nodes),
		ProtocolStatsJSON: string(statsRaw),
		UploadBytes:       up,
		DownloadBytes:     down,
		TotalBytes:        total,
		RemainingBytes:    remaining,
		ExpireAt:          exp,
		ContentHash:       hex.EncodeToString(hash[:16]),
		CheckedAt:         time.Now(),
	}
	if snap.LatencyMS <= 0 {
		snap.LatencyMS = int(time.Since(start).Milliseconds())
	}

	if err := s.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(snap).Error; err != nil {
			return err
		}
		var old []model.SubscriptionNode
		if err := tx.Where("target_id = ?", target.ID).Find(&old).Error; err != nil {
			return err
		}
		latencyMap := map[string]struct {
			Latency       *int
			ScoreMS       int
			TCPMS         int
			TLSMS         int
			E2EDomesticMS int
			E2EOverseasMS int
			JitterMS      int
			ProbeMode     string
			FailStage     string
			FailReason    string
			ErrorMsg      string
			CheckedAt     *time.Time
		}{}
		for _, item := range old {
			latencyMap[item.NodeUID] = struct {
				Latency       *int
				ScoreMS       int
				TCPMS         int
				TLSMS         int
				E2EDomesticMS int
				E2EOverseasMS int
				JitterMS      int
				ProbeMode     string
				FailStage     string
				FailReason    string
				ErrorMsg      string
				CheckedAt     *time.Time
			}{
				Latency:       item.LastLatencyMS,
				ScoreMS:       item.LastScoreMS,
				TCPMS:         item.LastTCPMS,
				TLSMS:         item.LastTLSMS,
				E2EDomesticMS: item.LastE2EDomesticMS,
				E2EOverseasMS: item.LastE2EOverseasMS,
				JitterMS:      item.LastJitterMS,
				ProbeMode:     item.LastProbeMode,
				FailStage:     item.LastFailStage,
				FailReason:    item.LastFailReason,
				ErrorMsg:      item.LastErrorMsg,
				CheckedAt:     item.LastLatencyCheckedAt,
			}
		}
		if err := tx.Where("target_id = ?", target.ID).Delete(&model.SubscriptionNode{}).Error; err != nil {
			return err
		}
		if len(nodes) == 0 {
			return nil
		}
		rows := make([]model.SubscriptionNode, 0, len(nodes))
		for _, node := range nodes {
			row := model.SubscriptionNode{TargetID: target.ID, NodeUID: node.UID, Name: node.Name, Protocol: node.Protocol, Server: node.Server, Port: node.Port, SourceOrder: node.Order, RawJSON: node.RawJSON}
			if oldVal, ok := latencyMap[node.UID]; ok {
				row.LastLatencyMS = oldVal.Latency
				row.LastScoreMS = oldVal.ScoreMS
				row.LastTCPMS = oldVal.TCPMS
				row.LastTLSMS = oldVal.TLSMS
				row.LastE2EDomesticMS = oldVal.E2EDomesticMS
				row.LastE2EOverseasMS = oldVal.E2EOverseasMS
				row.LastJitterMS = oldVal.JitterMS
				row.LastProbeMode = oldVal.ProbeMode
				row.LastFailStage = oldVal.FailStage
				row.LastFailReason = oldVal.FailReason
				row.LastErrorMsg = oldVal.ErrorMsg
				row.LastLatencyCheckedAt = oldVal.CheckedAt
			}
			rows = append(rows, row)
		}
		return tx.Create(&rows).Error
	}); err != nil {
		return nil, err
	}

	return snap, nil
}

func (s *TargetService) ListResults(id uint, limit int) ([]model.CheckResult, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	var results []model.CheckResult
	err := s.DB.Where("target_id = ?", id).Order("checked_at desc").Limit(limit).Find(&results).Error
	return results, err
}

func (s *TargetService) IngestTracking(writeKey string, items []TrackingIngestItem, clientIP string, userAgent string, referer string) (uint, int, error) {
	target, cfg, err := s.findTrackingTargetByWriteKey(writeKey)
	if err != nil {
		return 0, 0, err
	}
	if !target.Enabled {
		return 0, 0, errors.New("tracking target disabled")
	}

	if len(items) == 0 {
		return target.ID, 0, nil
	}

	now := time.Now()
	geoText := ""
	if s.GeoResolver != nil && clientIP != "" {
		if region, lookupErr := s.GeoResolver.Lookup(clientIP); lookupErr == nil {
			geoText = region
		}
	}
	rows := make([]model.TrackingEvent, 0, len(items))
	for _, item := range items {
		count := item.Count
		if count <= 0 {
			count = 1
		}
		eventName := item.EventName
		if eventName == "" {
			eventName = "event"
		}

		occurredAt := now
		if item.OccurredAt > 0 {
			occurredAt = time.UnixMilli(item.OccurredAt)
		}

		metaJSON := "{}"
		if len(item.Meta) > 0 {
			if raw, marshalErr := json.Marshal(item.Meta); marshalErr == nil {
				metaJSON = string(raw)
			}
		}

		uvKey := s.makeUVKey(cfg.UVIdentity, item, clientIP, userAgent)

		rows = append(rows, model.TrackingEvent{
			TargetID:   target.ID,
			EventName:  eventName,
			Page:       item.Page,
			Count:      count,
			ClientID:   item.ClientID,
			UserID:     item.UserID,
			UVKey:      uvKey,
			ClientIP:   clientIP,
			UserAgent:  userAgent,
			Referer:    referer,
			GeoText:    geoText,
			MetaJSON:   metaJSON,
			OccurredAt: occurredAt,
		})
	}

	if err := s.DB.Create(&rows).Error; err != nil {
		return target.ID, 0, err
	}

	return target.ID, len(rows), nil
}

func (s *TargetService) TrackingSummary(id uint, since time.Time) (map[string]any, error) {
	cfg, _ := s.getTrackingConfigByTargetID(id)
	metricMode := "both"
	if cfg != nil {
		metricMode = cfg.MetricMode
	}

	var last model.TrackingEvent
	err := s.DB.Where("target_id = ?", id).Order("occurred_at desc").First(&last).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return map[string]any{"has_data": false}, nil
		}
		return nil, err
	}

	var pv int64
	if metricMode != "uv" {
		if err := s.DB.Model(&model.TrackingEvent{}).Where("target_id = ? AND occurred_at >= ?", id, since).Select("COALESCE(SUM(count), 0)").Scan(&pv).Error; err != nil {
			return nil, err
		}
	}

	var uv int64
	if metricMode != "pv" {
		if err := s.DB.Model(&model.TrackingEvent{}).Where("target_id = ? AND occurred_at >= ? AND uv_key <> ''", id, since).Distinct("uv_key").Count(&uv).Error; err != nil {
			return nil, err
		}
	}

	return map[string]any{
		"has_data":        true,
		"pv":              pv,
		"uv":              uv,
		"last_event_at":   last.OccurredAt,
		"last_event_name": last.EventName,
		"last_event_page": last.Page,
	}, nil
}

func (s *TargetService) TrackingSeries(id uint, since time.Time) ([]map[string]any, error) {
	cfg, _ := s.getTrackingConfigByTargetID(id)
	metricMode := "both"
	if cfg != nil {
		metricMode = cfg.MetricMode
	}

	var events []model.TrackingEvent
	if err := s.DB.Where("target_id = ? AND occurred_at >= ?", id, since).Order("occurred_at asc").Find(&events).Error; err != nil {
		return nil, err
	}

	type bucketData struct {
		PV int64
		UV map[string]struct{}
	}
	buckets := map[string]*bucketData{}
	for _, event := range events {
		bt := event.OccurredAt.Truncate(time.Hour).Format("2006-01-02 15:04:05")
		if buckets[bt] == nil {
			buckets[bt] = &bucketData{UV: map[string]struct{}{}}
		}
		buckets[bt].PV += int64(event.Count)
		if event.UVKey != "" {
			buckets[bt].UV[event.UVKey] = struct{}{}
		}
	}

	out := make([]map[string]any, 0, len(buckets))
	for bucket, data := range buckets {
		pv := data.PV
		uv := len(data.UV)
		if metricMode == "pv" {
			uv = 0
		}
		if metricMode == "uv" {
			pv = 0
		}
		out = append(out, map[string]any{
			"bucket": bucket,
			"pv":     pv,
			"uv":     uv,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["bucket"].(string) < out[j]["bucket"].(string)
	})
	return out, nil
}

func (s *TargetService) getTrackingConfigByTargetID(id uint) (*trackingConfig, error) {
	var target model.MonitorTarget
	if err := s.DB.Select("id", "config_json").First(&target, id).Error; err != nil {
		return nil, err
	}
	return parseTrackingConfig(target.ConfigJSON)
}

func (s *TargetService) TrackingEvents(id uint, limit int, since *time.Time) ([]model.TrackingEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var rows []model.TrackingEvent
	query := s.DB.Where("target_id = ?", id)
	if since != nil {
		query = query.Where("occurred_at >= ?", *since)
	}
	err := query.Order("occurred_at desc").Limit(limit).Find(&rows).Error
	return rows, err
}

func (s *TargetService) findTrackingTargetByWriteKey(writeKey string) (*model.MonitorTarget, *trackingConfig, error) {
	if writeKey == "" {
		return nil, nil, errors.New("write key is required")
	}
	var targets []model.MonitorTarget
	if err := s.DB.Where("type = ?", "tracking").Find(&targets).Error; err != nil {
		return nil, nil, err
	}
	for _, t := range targets {
		cfg, err := parseTrackingConfig(t.ConfigJSON)
		if err != nil {
			continue
		}
		if cfg.WriteKey == writeKey {
			return &t, cfg, nil
		}
	}
	return nil, nil, errors.New("tracking target not found")
}

func parseTrackingConfig(raw string) (*trackingConfig, error) {
	if raw == "" {
		return nil, errors.New("empty config")
	}
	var cfg trackingConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return nil, err
	}
	if cfg.MetricMode == "" {
		cfg.MetricMode = "both"
	}
	if cfg.MetricMode != "pv" && cfg.MetricMode != "uv" && cfg.MetricMode != "both" {
		cfg.MetricMode = "both"
	}
	if cfg.UVIdentity == "" {
		cfg.UVIdentity = "client_id"
	}
	if cfg.UVIdentity != "client_id" && cfg.UVIdentity != "ip_ua_hash" && cfg.UVIdentity != "ip_client_hash" && cfg.UVIdentity != "user_id" {
		cfg.UVIdentity = "client_id"
	}
	if cfg.UserGroupMode == "" {
		cfg.UserGroupMode = "ip_device"
	}
	if cfg.UserGroupMode != "ip" && cfg.UserGroupMode != "device_id" && cfg.UserGroupMode != "ip_device" {
		cfg.UserGroupMode = "ip_device"
	}
	if cfg.InactiveThresholdMin < 0 {
		cfg.InactiveThresholdMin = 0
	}
	return &cfg, nil
}

func (s *TargetService) makeUVKey(mode string, item TrackingIngestItem, clientIP string, userAgent string) string {
	switch mode {
	case "user_id":
		if item.UserID != "" {
			return "uid:" + item.UserID
		}
	case "ip_ua_hash":
		hash := sha256.Sum256([]byte(fmt.Sprintf("%s|%s", clientIP, userAgent)))
		return "ipua:" + hex.EncodeToString(hash[:16])
	case "ip_client_hash":
		hash := sha256.Sum256([]byte(fmt.Sprintf("%s|%s", clientIP, item.ClientID)))
		return "ipcid:" + hex.EncodeToString(hash[:16])
	default:
		if item.ClientID != "" {
			return "cid:" + item.ClientID
		}
	}

	if item.ClientID != "" {
		return "cid:" + item.ClientID
	}
	if item.UserID != "" {
		return "uid:" + item.UserID
	}
	hash := sha256.Sum256([]byte(fmt.Sprintf("%s|%s", clientIP, userAgent)))
	return "ipua:" + hex.EncodeToString(hash[:16])
}

func (s *TargetService) getSubscriptionTarget(id uint) (*model.MonitorTarget, *subscriptionConfig, error) {
	target, err := s.GetTarget(id)
	if err != nil {
		return nil, nil, err
	}
	if target.Type != "subscription" {
		return nil, nil, errors.New("target is not subscription")
	}
	cfg := parseSubscriptionConfig(target.ConfigJSON)
	return target, cfg, nil
}

func parseSubscriptionConfig(raw string) *subscriptionConfig {
	cfg := &subscriptionConfig{
		LatencyConcurrency: 20,
		LatencyTimeoutMS:   1200,
		E2ETimeoutMS:       6000,
		FetchTimeoutMS:     20000,
		FetchRetries:       2,
		FetchHTTPMode:      fetchHTTPModeAuto,
		FetchUserAgent:     defaultSubscriptionFetchUA,
		LatencyProbeCount:  3,
		LatencyIntervalSec: 300,
		WeightDomestic:     0.3,
		WeightOverseas:     0.7,
		ProbeURLsDomestic:  append([]string{}, defaultProbeURLsDomestic...),
		ProbeURLsOverseas:  append([]string{}, defaultProbeURLsOverseas...),
		SingBoxPath:        "sing-box",
	}
	if strings.TrimSpace(raw) == "" {
		return cfg
	}
	_ = json.Unmarshal([]byte(raw), cfg)
	if cfg.LatencyTimeoutMS <= 0 {
		cfg.LatencyTimeoutMS = 1200
	}
	if cfg.E2ETimeoutMS <= 0 {
		cfg.E2ETimeoutMS = 6000
	}
	if cfg.FetchTimeoutMS <= 0 {
		cfg.FetchTimeoutMS = 20000
	}
	if cfg.FetchRetries < 0 {
		cfg.FetchRetries = 0
	}
	if cfg.FetchRetries > 5 {
		cfg.FetchRetries = 5
	}
	cfg.FetchHTTPMode = normalizeFetchHTTPMode(cfg.FetchHTTPMode)
	if strings.TrimSpace(cfg.FetchUserAgent) == "" {
		cfg.FetchUserAgent = defaultSubscriptionFetchUA
	}
	cfg.FetchProxyURL = strings.TrimSpace(cfg.FetchProxyURL)
	cfg.FetchCookie = strings.TrimSpace(cfg.FetchCookie)
	if cfg.LatencyConcurrency <= 0 {
		cfg.LatencyConcurrency = 20
	}
	if cfg.LatencyProbeCount <= 0 {
		cfg.LatencyProbeCount = 3
	}
	if cfg.LatencyIntervalSec <= 0 {
		cfg.LatencyIntervalSec = 300
	}
	if cfg.WeightDomestic < 0 || cfg.WeightOverseas < 0 || (cfg.WeightDomestic+cfg.WeightOverseas) <= 0 {
		cfg.WeightDomestic = 0.3
		cfg.WeightOverseas = 0.7
	}
	sum := cfg.WeightDomestic + cfg.WeightOverseas
	if sum > 0 {
		cfg.WeightDomestic = cfg.WeightDomestic / sum
		cfg.WeightOverseas = cfg.WeightOverseas / sum
	}
	cfg.ProbeURLsDomestic = normalizeProbeURLs(cfg.ProbeURLsDomestic, defaultProbeURLsDomestic)
	cfg.ProbeURLsOverseas = normalizeProbeURLs(cfg.ProbeURLsOverseas, defaultProbeURLsOverseas)
	if strings.TrimSpace(cfg.SingBoxPath) == "" {
		cfg.SingBoxPath = "sing-box"
	}
	return cfg
}

func normalizeProbeURLs(urls []string, defaults []string) []string {
	out := make([]string, 0, len(urls))
	seen := map[string]struct{}{}
	for _, item := range urls {
		s := strings.TrimSpace(item)
		if s == "" {
			continue
		}
		u, err := url.Parse(s)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	if len(out) == 0 {
		return append([]string{}, defaults...)
	}
	return out
}

func parseManualExpireAt(raw string) *time.Time {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil
	}
	layouts := []string{time.RFC3339, "2006-01-02T15:04", "2006-01-02 15:04:05"}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			v := t
			return &v
		}
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			v := t
			return &v
		}
	}
	return nil
}

func (s *TargetService) fetchSubscriptionContent(targetID uint, endpoint string, cfg *subscriptionConfig) (*http.Response, []byte, int, error) {
	fetchStart := time.Now()
	timeoutMS := cfg.FetchTimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = 20000
	}
	httpMode := normalizeFetchHTTPMode(cfg.FetchHTTPMode)
	var proxyURL *url.URL
	if proxyRaw := strings.TrimSpace(cfg.FetchProxyURL); proxyRaw != "" {
		if u, err := url.Parse(proxyRaw); err == nil {
			proxyURL = u
		}
	}
	host := ""
	if parsed, err := url.Parse(endpoint); err == nil {
		host = strings.ToLower(strings.TrimSpace(parsed.Hostname()))
	}

	totalBudgetMS := timeoutMS * (cfg.FetchRetries + 1)
	if totalBudgetMS <= 0 {
		totalBudgetMS = timeoutMS
	}
	if totalBudgetMS > 45000 {
		totalBudgetMS = 45000
	}
	deadline := time.Now().Add(time.Duration(totalBudgetMS) * time.Millisecond)

	attempts := cfg.FetchRetries + 1
	if attempts <= 0 {
		attempts = 1
	}
	if attempts > 6 {
		attempts = 6
	}
	uaCandidates := []string{cfg.FetchUserAgent}
	if !strings.EqualFold(strings.TrimSpace(cfg.FetchUserAgent), defaultSubscriptionFetchUA) {
		uaCandidates = append(uaCandidates, defaultSubscriptionFetchUA)
	}
	traceID := fmt.Sprintf("sub-fetch-t%d-%d", targetID, time.Now().UnixNano())
	subscriptionFetchTraceLog(traceID, "start", map[string]any{"target_id": targetID, "host": host, "endpoint": endpoint, "http_mode": httpMode, "attempts": attempts, "timeout_ms": timeoutMS, "ua_candidates": len(uaCandidates)})

	var lastErr error
	step := 0
	for _, ua := range uaCandidates {
		for i := 0; i < attempts; i++ {
			step++
			remaining := time.Until(deadline)
			if remaining <= 0 {
				if lastErr == nil {
					lastErr = errors.New("subscription_fetch_deadline_exceeded")
				}
				subscriptionFetchTraceLog(traceID, "deadline_exceeded", map[string]any{"target_id": targetID, "host": host, "step": step, "last_error": errString(lastErr)})
				return nil, nil, int(time.Since(fetchStart).Milliseconds()), lastErr
			}
			perTry := time.Duration(timeoutMS) * time.Millisecond
			if remaining < perTry {
				perTry = remaining
			}

			protocols := s.fetchProtocolPlan(host, httpMode)
			subscriptionFetchTraceLog(traceID, "attempt_start", map[string]any{"target_id": targetID, "host": host, "step": step, "ua_index": uaIndex(ua, uaCandidates), "attempt": i + 1, "attempts": attempts, "timeout_ms": perTry.Milliseconds(), "protocols": protocols})

			var resp *http.Response
			var err error
			var primaryErr error
			protocolStageStart := time.Now()
			for pi, proto := range protocols {
				protoTimeout := perTry
				if normalizeFetchHTTPMode(httpMode) == fetchHTTPModeAuto && len(protocols) > 1 {
					if pi == 0 {
						firstBudget := 3 * time.Second
						if perTry < firstBudget {
							firstBudget = perTry
						}
						if firstBudget < 1500*time.Millisecond {
							firstBudget = 1500 * time.Millisecond
						}
						protoTimeout = firstBudget
					} else {
						remainingBudget := time.Until(deadline)
						elapsedInStep := time.Since(protocolStageStart)
						if remainingBudget > elapsedInStep {
							remainingBudget -= elapsedInStep
						}
						if remainingBudget > 0 && remainingBudget < protoTimeout {
							protoTimeout = remainingBudget
						}
					}
				}
				resp, err = doSubscriptionFetchAttempt(endpoint, ua, cfg.FetchCookie, protoTimeout, proxyURL, proto == fetchHTTPModeH2)
				subscriptionFetchTraceLog(traceID, "attempt_protocol", map[string]any{"target_id": targetID, "host": host, "step": step, "protocol": proto, "protocol_index": pi + 1, "timeout_ms": protoTimeout.Milliseconds(), "success": err == nil, "error": errString(err)})
				if err == nil {
					s.markFetchProtocolSuccess(host, proto)
					break
				}
				if pi == 0 {
					primaryErr = err
				}
				s.markFetchProtocolFailure(host, proto, err)
				if !shouldTryAlternateProtocol(httpMode, err) {
					break
				}
			}

			sawProtocolMismatch := false
			if err != nil && isFetchProtocolMismatch(err) {
				sawProtocolMismatch = true
			}
			if err != nil && len(protocols) > 1 && !sawProtocolMismatch && shouldHedgeFetchAttempt(httpMode, err, perTry, deadline) {
				hedgeTimeout := perTry / 2
				if hedgeTimeout < 1500*time.Millisecond {
					hedgeTimeout = 1500 * time.Millisecond
				}
				remaining = time.Until(deadline)
				if remaining < hedgeTimeout {
					hedgeTimeout = remaining
				}
				if hedgeTimeout > 0 {
					respHedge, protoHedge, hedgeErr := doSubscriptionFetchHedged(endpoint, ua, cfg.FetchCookie, hedgeTimeout, proxyURL)
					subscriptionFetchTraceLog(traceID, "attempt_hedge", map[string]any{"target_id": targetID, "host": host, "step": step, "timeout_ms": hedgeTimeout.Milliseconds(), "success": hedgeErr == nil, "protocol": protoHedge, "error": errString(hedgeErr)})
					if hedgeErr == nil {
						resp, err = respHedge, nil
						s.markFetchProtocolSuccess(host, protoHedge)
					} else {
						err = hedgeErr
					}
				}
			}

			if err != nil && primaryErr != nil {
				if shouldPreferPrimaryFetchError(primaryErr, err) {
					err = primaryErr
				}
			}
			if err != nil {
				subscriptionFetchTraceLog(traceID, "attempt_failed", map[string]any{"target_id": targetID, "host": host, "step": step, "attempt": i + 1, "error": err.Error()})
				lastErr = err
				if i < attempts-1 {
					time.Sleep(time.Duration(700*(i+1)) * time.Millisecond)
					continue
				}
				break
			}
			body, readErr := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
			_ = resp.Body.Close()
			if readErr != nil {
				subscriptionFetchTraceLog(traceID, "attempt_read_failed", map[string]any{"target_id": targetID, "host": host, "step": step, "error": readErr.Error()})
				lastErr = readErr
				if i < attempts-1 {
					time.Sleep(time.Duration(700*(i+1)) * time.Millisecond)
					continue
				}
				break
			}
			if resp.StatusCode == http.StatusForbidden {
				lower := strings.ToLower(string(body))
				if strings.Contains(lower, "just a moment") || strings.Contains(lower, "cloudflare") || strings.Contains(lower, "cf-challenge") {
					lastErr = errors.New("cloudflare_challenge_blocked: set fetch_proxy_url or fetch_cookie")
					subscriptionFetchTraceLog(traceID, "attempt_cf_blocked", map[string]any{"target_id": targetID, "host": host, "step": step, "status": resp.StatusCode})
					if i < attempts-1 {
						time.Sleep(time.Duration(700*(i+1)) * time.Millisecond)
						continue
					}
					break
				}
			}
			if resp.StatusCode >= 400 {
				lastErr = fmt.Errorf("http_status_%d", resp.StatusCode)
				subscriptionFetchTraceLog(traceID, "attempt_http_error", map[string]any{"target_id": targetID, "host": host, "step": step, "status": resp.StatusCode})
				if i < attempts-1 {
					time.Sleep(time.Duration(700*(i+1)) * time.Millisecond)
					continue
				}
				break
			}

			subscriptionFetchTraceLog(traceID, "attempt_success", map[string]any{"target_id": targetID, "host": host, "step": step, "status": resp.StatusCode, "bytes": len(body)})
			resp.Body = io.NopCloser(strings.NewReader(string(body)))
			attemptLatencyMS := int(time.Since(protocolStageStart).Milliseconds())
			return resp, body, attemptLatencyMS, nil
		}
	}
	if lastErr == nil {
		lastErr = errors.New("subscription fetch failed")
	}
	subscriptionFetchTraceLog(traceID, "done_failed", map[string]any{"target_id": targetID, "host": host, "error": lastErr.Error()})
	return nil, nil, int(time.Since(fetchStart).Milliseconds()), lastErr
}

func doSubscriptionFetchAttempt(endpoint string, ua string, cookie string, timeout time.Duration, proxyURL *url.URL, forceHTTP2 bool) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept", "text/plain,*/*")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Cache-Control", "no-cache")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableKeepAlives = true
	transport.MaxIdleConns = 0
	transport.MaxIdleConnsPerHost = 0
	transport.IdleConnTimeout = 500 * time.Millisecond
	transport.ResponseHeaderTimeout = timeout
	transport.TLSHandshakeTimeout = timeout
	if proxyURL != nil {
		transport.Proxy = http.ProxyURL(proxyURL)
	}
	if !forceHTTP2 {
		transport.ForceAttemptHTTP2 = false
		transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
		if transport.TLSClientConfig == nil {
			transport.TLSClientConfig = &tls.Config{}
		} else {
			transport.TLSClientConfig = transport.TLSClientConfig.Clone()
		}
		transport.TLSClientConfig.NextProtos = []string{"http/1.1"}
	}
	client := &http.Client{Timeout: timeout, Transport: transport}
	return client.Do(req)
}

func doSubscriptionFetchHedged(endpoint string, ua string, cookie string, timeout time.Duration, proxyURL *url.URL) (*http.Response, string, error) {
	type fetchAttemptResult struct {
		resp  *http.Response
		err   error
		proto string
	}
	results := make(chan fetchAttemptResult, 2)
	go func() {
		resp, err := doSubscriptionFetchAttempt(endpoint, ua, cookie, timeout, proxyURL, true)
		results <- fetchAttemptResult{resp: resp, err: err, proto: fetchHTTPModeH2}
	}()
	go func() {
		resp, err := doSubscriptionFetchAttempt(endpoint, ua, cookie, timeout, proxyURL, false)
		results <- fetchAttemptResult{resp: resp, err: err, proto: fetchHTTPModeH1}
	}()

	first := <-results
	second := <-results
	if first.err == nil {
		if second.resp != nil {
			_ = second.resp.Body.Close()
		}
		return first.resp, first.proto, nil
	}
	if second.err == nil {
		if first.resp != nil {
			_ = first.resp.Body.Close()
		}
		return second.resp, second.proto, nil
	}
	if shouldPreferPrimaryFetchError(first.err, second.err) {
		return nil, "", first.err
	}
	return nil, "", second.err
}

func shouldTryAlternateProtocol(httpMode string, err error) bool {
	if err == nil {
		return false
	}
	if normalizeFetchHTTPMode(httpMode) != fetchHTTPModeAuto {
		return false
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "http2") || strings.Contains(msg, "goaway") || strings.Contains(msg, "stream error") {
		return true
	}
	if strings.Contains(msg, "awaiting headers") || strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded") {
		return true
	}
	if strings.Contains(msg, "connection reset") || strings.Contains(msg, "transport connection broken") {
		return true
	}
	return false
}

func shouldHedgeFetchAttempt(httpMode string, err error, perTry time.Duration, deadline time.Time) bool {
	if normalizeFetchHTTPMode(httpMode) != fetchHTTPModeAuto {
		return false
	}
	if !isFetchTimeoutLike(err) {
		return false
	}
	if perTry < 3*time.Second {
		return false
	}
	return time.Until(deadline) > 1200*time.Millisecond
}

func isFetchTimeoutLike(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "awaiting headers") || strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded")
}

func isFetchProtocolMismatch(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "malformed http response") {
		return true
	}
	if strings.Contains(msg, "unexpected alpn") {
		return true
	}
	if strings.Contains(msg, "http/1.x transport connection broken") && strings.Contains(msg, `\\x00\\x00\\x`) {
		return true
	}
	return false
}

func normalizeFetchHTTPMode(raw string) string {
	v := strings.TrimSpace(strings.ToLower(raw))
	switch v {
	case fetchHTTPModeH1, "http1", "http1.1":
		return fetchHTTPModeH1
	case fetchHTTPModeH2, "http2":
		return fetchHTTPModeH2
	default:
		return fetchHTTPModeAuto
	}
}

func (s *TargetService) fetchProtocolPlan(host string, mode string) []string {
	mode = normalizeFetchHTTPMode(mode)
	if mode == fetchHTTPModeH1 {
		return []string{fetchHTTPModeH1}
	}
	if mode == fetchHTTPModeH2 {
		return []string{fetchHTTPModeH2}
	}
	base := []string{fetchHTTPModeH2, fetchHTTPModeH1}
	state := s.getFetchHostState(host)
	if state.Preferred == fetchHTTPModeH1 {
		base = []string{fetchHTTPModeH1, fetchHTTPModeH2}
	}
	now := time.Now()
	avoidH1 := now.Before(state.AvoidH1To)
	avoidH2 := now.Before(state.AvoidH2To)
	if avoidH1 && !avoidH2 {
		return []string{fetchHTTPModeH2, fetchHTTPModeH1}
	}
	if avoidH2 && !avoidH1 {
		return []string{fetchHTTPModeH1, fetchHTTPModeH2}
	}
	if avoidH1 && avoidH2 {
		if state.Preferred == fetchHTTPModeH1 {
			return []string{fetchHTTPModeH1, fetchHTTPModeH2}
		}
		return []string{fetchHTTPModeH2, fetchHTTPModeH1}
	}
	return base
}

func (s *TargetService) getFetchHostState(host string) fetchHostProtocolState {
	h := strings.TrimSpace(strings.ToLower(host))
	if h == "" {
		return fetchHostProtocolState{}
	}
	s.fetchProtocolMu.Lock()
	defer s.fetchProtocolMu.Unlock()
	if s.fetchProtocolState == nil {
		s.fetchProtocolState = map[string]fetchHostProtocolState{}
	}
	return s.fetchProtocolState[h]
}

func (s *TargetService) markFetchProtocolSuccess(host string, protocol string) {
	h := strings.TrimSpace(strings.ToLower(host))
	if h == "" {
		return
	}
	proto := normalizeFetchHTTPMode(protocol)
	if proto != fetchHTTPModeH1 && proto != fetchHTTPModeH2 {
		return
	}
	s.fetchProtocolMu.Lock()
	defer s.fetchProtocolMu.Unlock()
	if s.fetchProtocolState == nil {
		s.fetchProtocolState = map[string]fetchHostProtocolState{}
	}
	st := s.fetchProtocolState[h]
	st.Preferred = proto
	if proto == fetchHTTPModeH1 {
		st.AvoidH1To = time.Time{}
	} else {
		st.AvoidH2To = time.Time{}
	}
	s.fetchProtocolState[h] = st
}

func (s *TargetService) markFetchProtocolFailure(host string, protocol string, err error) {
	if !isFetchTimeoutLike(err) && !isFetchProtocolMismatch(err) {
		return
	}
	h := strings.TrimSpace(strings.ToLower(host))
	if h == "" {
		return
	}
	proto := normalizeFetchHTTPMode(protocol)
	if proto != fetchHTTPModeH1 && proto != fetchHTTPModeH2 {
		return
	}
	s.fetchProtocolMu.Lock()
	defer s.fetchProtocolMu.Unlock()
	if s.fetchProtocolState == nil {
		s.fetchProtocolState = map[string]fetchHostProtocolState{}
	}
	st := s.fetchProtocolState[h]
	until := time.Now().Add(8 * time.Minute)
	if isFetchProtocolMismatch(err) {
		until = time.Now().Add(30 * time.Minute)
	}
	if proto == fetchHTTPModeH1 {
		st.AvoidH1To = until
	} else {
		st.AvoidH2To = until
	}
	s.fetchProtocolState[h] = st
}

func uaIndex(current string, all []string) int {
	for i, item := range all {
		if item == current {
			return i + 1
		}
	}
	return 0
}

func shouldPreferPrimaryFetchError(primary error, fallback error) bool {
	if primary == nil || fallback == nil {
		return false
	}
	p := strings.ToLower(primary.Error())
	f := strings.ToLower(fallback.Error())
	if strings.Contains(p, "awaiting headers") && strings.Contains(f, "malformed http response") {
		return true
	}
	if strings.Contains(p, "context deadline exceeded") && strings.Contains(f, "transport connection broken") {
		return true
	}
	return false
}

func parseSubscriptionNodes(body []byte) ([]parsedSubscriptionNode, error) {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return nil, errors.New("empty subscription content")
	}

	if strings.Contains(text, "proxies:") {
		nodes := parseClashYAML(body)
		if len(nodes) > 0 {
			return nodes, nil
		}
	}

	if decoded, err := tryBase64Decode(text); err == nil {
		if nodes := parseURIList(string(decoded)); len(nodes) > 0 {
			return nodes, nil
		}
	}

	nodes := parseURIList(text)
	if len(nodes) > 0 {
		return nodes, nil
	}

	return nil, errors.New("unsupported subscription format")
}

func parseClashYAML(body []byte) []parsedSubscriptionNode {
	var payload struct {
		Proxies []map[string]any `yaml:"proxies"`
	}
	if err := yaml.Unmarshal(body, &payload); err != nil {
		return nil
	}
	out := make([]parsedSubscriptionNode, 0, len(payload.Proxies))
	for i, item := range payload.Proxies {
		name := fmt.Sprint(item["name"])
		protocol := strings.ToLower(fmt.Sprint(item["type"]))
		server := fmt.Sprint(item["server"])
		port := parseClashProxyPort(item)
		if port <= 0 {
			if h, p, ok := parseServerPortFromClashServerField(server); ok {
				server = h
				port = p
			}
		}
		if protocol == "" || server == "" || port <= 0 {
			continue
		}
		raw, _ := json.Marshal(item)
		uid := nodeUID(protocol, server, port, name)
		out = append(out, parsedSubscriptionNode{UID: uid, Name: name, Protocol: protocol, Server: server, Port: port, RawJSON: string(raw), Order: i})
	}
	return out
}

func parseClashProxyPort(item map[string]any) int {
	port := toInt(item["port"])
	if port > 0 {
		return port
	}
	portsRaw := toString(item["ports"])
	if portsRaw == "" {
		return 0
	}
	parts := strings.SplitN(portsRaw, "-", 2)
	first := strings.TrimSpace(parts[0])
	p, err := strconv.Atoi(first)
	if err != nil || p <= 0 {
		return 0
	}
	return p
}

func parseServerPortFromClashServerField(server string) (string, int, bool) {
	s := strings.TrimSpace(server)
	if s == "" {
		return "", 0, false
	}
	if h, p, err := net.SplitHostPort(s); err == nil {
		pn, convErr := strconv.Atoi(strings.TrimSpace(p))
		if convErr == nil && pn > 0 {
			return h, pn, true
		}
	}
	if idx := strings.LastIndex(s, ":"); idx > 0 && idx < len(s)-1 {
		host := strings.TrimSpace(s[:idx])
		p := strings.TrimSpace(s[idx+1:])
		pn, err := strconv.Atoi(p)
		if err == nil && pn > 0 && host != "" {
			return host, pn, true
		}
	}
	return "", 0, false
}

func parseURIList(text string) []parsedSubscriptionNode {
	lines := strings.Split(text, "\n")
	out := make([]parsedSubscriptionNode, 0, len(lines))
	order := 0
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		node, ok := parseURI(line)
		if !ok {
			continue
		}
		node.Order = order
		order++
		out = append(out, node)
	}
	return out
}

func parseURI(raw string) (parsedSubscriptionNode, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return parsedSubscriptionNode{}, false
	}
	protocol := strings.ToLower(u.Scheme)
	name := strings.TrimSpace(u.Fragment)
	if decodedName, err := url.QueryUnescape(name); err == nil {
		name = decodedName
	}

	server := u.Hostname()
	port, _ := strconv.Atoi(u.Port())

	if protocol == "vmess" {
		payload, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(raw, "vmess://"))
		if err == nil {
			var item map[string]any
			if jsonErr := json.Unmarshal(payload, &item); jsonErr == nil {
				server = fmt.Sprint(item["add"])
				port = toInt(item["port"])
				if name == "" {
					name = fmt.Sprint(item["ps"])
				}
			}
		}
	}

	if protocol == "ss" && (server == "" || port == 0) {
		inner := strings.TrimPrefix(raw, "ss://")
		inner = strings.Split(inner, "#")[0]
		if idx := strings.Index(inner, "@"); idx > 0 {
			enc := inner[:idx]
			if decoded, err := tryBase64Decode(enc); err == nil {
				inner = string(decoded) + inner[idx:]
			}
		}
		if idx := strings.LastIndex(inner, "@"); idx >= 0 {
			hostPart := inner[idx+1:]
			if h, p, splitErr := net.SplitHostPort(hostPart); splitErr == nil {
				server = h
				port, _ = strconv.Atoi(p)
			}
		}
	}

	if server == "" || port <= 0 {
		return parsedSubscriptionNode{}, false
	}
	if name == "" {
		name = fmt.Sprintf("%s-%s:%d", protocol, server, port)
	}

	uid := nodeUID(protocol, server, port, name)
	rawJSON, _ := json.Marshal(map[string]any{"uri": raw})
	return parsedSubscriptionNode{UID: uid, Name: name, Protocol: protocol, Server: server, Port: port, RawJSON: string(rawJSON)}, true
}

func parseSubscriptionUserinfo(header string) (upload, download, total int64, expireAt *time.Time) {
	parts := strings.Split(header, ";")
	vals := map[string]int64{}
	for _, part := range parts {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		if num, err := strconv.ParseInt(strings.TrimSpace(kv[1]), 10, 64); err == nil {
			vals[strings.ToLower(strings.TrimSpace(kv[0]))] = num
		}
	}
	upload = vals["upload"]
	download = vals["download"]
	total = vals["total"]
	if exp, ok := vals["expire"]; ok && exp > 0 {
		t := time.Unix(exp, 0)
		expireAt = &t
	}
	return
}

func tryBase64Decode(text string) ([]byte, error) {
	clean := strings.ReplaceAll(text, "\n", "")
	clean = strings.ReplaceAll(clean, "\r", "")
	clean = strings.TrimSpace(clean)
	if clean == "" {
		return nil, errors.New("empty")
	}
	if mod := len(clean) % 4; mod != 0 {
		clean += strings.Repeat("=", 4-mod)
	}
	if out, err := base64.StdEncoding.DecodeString(clean); err == nil {
		return out, nil
	}
	return base64.RawStdEncoding.DecodeString(strings.TrimRight(clean, "="))
}

func nodeUID(protocol, server string, port int, name string) string {
	h := sha256.Sum256([]byte(strings.ToLower(protocol + "|" + server + "|" + strconv.Itoa(port) + "|" + name)))
	return hex.EncodeToString(h[:16])
}

func toInt(v any) int {
	switch val := v.(type) {
	case int:
		return val
	case int64:
		return int(val)
	case float64:
		return int(val)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(val))
		return n
	default:
		return 0
	}
}

func toString(v any) string {
	if v == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(v))
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func subscriptionLatencyTraceEnabled() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("SUB_LATENCY_TRACE")))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func subscriptionFetchTraceEnabled() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("SUB_FETCH_TRACE")))
	if v == "1" || v == "true" || v == "yes" || v == "on" {
		return true
	}
	return subscriptionLatencyTraceEnabled()
}

func subscriptionTraceID(targetID uint, node model.SubscriptionNode) string {
	uid := node.NodeUID
	if len(uid) > 8 {
		uid = uid[:8]
	}
	if uid == "" {
		uid = "nouid"
	}
	return fmt.Sprintf("t%d-%s-%d", targetID, uid, time.Now().UnixNano())
}

func subscriptionTraceLog(traceID string, stage string, fields map[string]any) {
	if !subscriptionLatencyTraceEnabled() {
		return
	}
	payload := map[string]any{
		"trace_id": traceID,
		"stage":    stage,
		"ts":       time.Now().Format(time.RFC3339Nano),
	}
	for k, v := range fields {
		payload[k] = v
	}
	raw, _ := json.Marshal(payload)
	log.Printf("subscription_latency_trace %s", string(raw))
}

func subscriptionFetchTraceLog(traceID string, stage string, fields map[string]any) {
	if !subscriptionFetchTraceEnabled() {
		return
	}
	payload := map[string]any{
		"trace_id": traceID,
		"stage":    stage,
		"ts":       time.Now().Format(time.RFC3339Nano),
	}
	for k, v := range fields {
		payload[k] = v
	}
	raw, _ := json.Marshal(payload)
	log.Printf("subscription_fetch_trace %s", string(raw))
}

type subscriptionBaselineResult struct {
	Success    bool
	LatencyMS  int
	TCPMS      int
	TLSMS      int
	FailStage  string
	FailReason string
}

type subscriptionE2EResult struct {
	Success       bool
	DomesticMS    int
	OverseasMS    int
	ScoreMS       int
	JitterMS      int
	FailStage     string
	FailReason    string
	DomesticError string
	OverseasError string
}

type subscriptionProbeResult struct {
	Success       bool
	LatencyMS     int
	ScoreMS       int
	TCPMS         int
	TLSMS         int
	E2EDomesticMS int
	E2EOverseasMS int
	JitterMS      int
	ProbeMode     string
	FailStage     string
	FailReason    string
	ErrorMsg      string
}

func probeNodeLatencyBaseline(node model.SubscriptionNode, timeoutMS int, probeCount int, traceID string) subscriptionBaselineResult {
	stageStart := time.Now()
	if timeoutMS <= 0 {
		timeoutMS = 1200
	}
	if probeCount <= 0 {
		probeCount = 3
	}
	primaryTLS, fallbackTLS, serverName := probeTransportPlan(node)
	addr := net.JoinHostPort(node.Server, strconv.Itoa(node.Port))
	latencies := make([]int, 0, probeCount)
	tcpValues := make([]int, 0, probeCount)
	tlsValues := make([]int, 0, probeCount)
	lastErr := ""
	for i := 0; i < probeCount; i++ {
		sampleStart := time.Now()
		lat, err := probeNodeOnce(addr, timeoutMS, primaryTLS, serverName)
		usedTLS := primaryTLS
		if err != nil && fallbackTLS != nil {
			lat, err = probeNodeOnce(addr, timeoutMS, *fallbackTLS, serverName)
			usedTLS = *fallbackTLS
		}
		if err != nil {
			lastErr = err.Error()
			subscriptionTraceLog(traceID, "baseline_sample", map[string]any{"sample": i + 1, "success": false, "used_tls": usedTLS, "elapsed_ms": time.Since(sampleStart).Milliseconds(), "error": err.Error()})
			continue
		}
		subscriptionTraceLog(traceID, "baseline_sample", map[string]any{"sample": i + 1, "success": true, "used_tls": usedTLS, "latency_ms": lat, "elapsed_ms": time.Since(sampleStart).Milliseconds()})
		latencies = append(latencies, lat)
		if usedTLS {
			tlsValues = append(tlsValues, lat)
		} else {
			tcpValues = append(tcpValues, lat)
		}
	}
	if len(latencies) == 0 {
		if lastErr == "" {
			lastErr = "probe failed"
		}
		subscriptionTraceLog(traceID, "baseline_done", map[string]any{"success": false, "elapsed_ms": time.Since(stageStart).Milliseconds(), "error": lastErr})
		return subscriptionBaselineResult{Success: false, FailStage: "dial", FailReason: lastErr}
	}
	selectedLatency := selectBaselineLatency(primaryTLS, latencies, tcpValues, tlsValues)
	subscriptionTraceLog(traceID, "baseline_done", map[string]any{"success": true, "elapsed_ms": time.Since(stageStart).Milliseconds(), "median_ms": selectedLatency, "tcp_ms": medianIntOrZero(tcpValues), "tls_ms": medianIntOrZero(tlsValues)})
	return subscriptionBaselineResult{
		Success:    true,
		LatencyMS:  selectedLatency,
		TCPMS:      medianIntOrZero(tcpValues),
		TLSMS:      medianIntOrZero(tlsValues),
		FailStage:  "",
		FailReason: "",
	}
}

func selectBaselineLatency(primaryTLS bool, latencies []int, tcpValues []int, tlsValues []int) int {
	if primaryTLS && len(tlsValues) > 0 {
		return medianInt(tlsValues)
	}
	if len(latencies) > 0 {
		return medianInt(latencies)
	}
	if len(tlsValues) > 0 {
		return medianInt(tlsValues)
	}
	if len(tcpValues) > 0 {
		return medianInt(tcpValues)
	}
	return 0
}

func probeNodeLatencyMixed(node model.SubscriptionNode, timeoutMS int, probeCount int, cfg *subscriptionConfig, traceID string) subscriptionProbeResult {
	mixedStart := time.Now()
	baseline := subscriptionBaselineResult{Success: false, FailStage: "baseline", FailReason: "skipped_for_quic"}
	if !shouldSkipBaselineProbe(node) {
		baseline = probeNodeLatencyBaseline(node, timeoutMS, probeCount, traceID)
	} else {
		subscriptionTraceLog(traceID, "baseline_skipped", map[string]any{"protocol": strings.ToLower(strings.TrimSpace(node.Protocol))})
	}
	e2eTimeoutMS := cfg.E2ETimeoutMS
	if e2eTimeoutMS <= 0 {
		e2eTimeoutMS = 6000
	}
	e2e := probeNodeLatencyE2E(node, e2eTimeoutMS, probeCount, cfg, traceID)
	out := subscriptionProbeResult{
		ProbeMode: "mixed",
		TCPMS:     baseline.TCPMS,
		TLSMS:     baseline.TLSMS,
	}
	subscriptionTraceLog(traceID, "mixed_stage_result", map[string]any{
		"baseline_success": baseline.Success,
		"baseline_tcp_ms":  baseline.TCPMS,
		"baseline_tls_ms":  baseline.TLSMS,
		"e2e_success":      e2e.Success,
		"e2e_domestic_ms":  e2e.DomesticMS,
		"e2e_overseas_ms":  e2e.OverseasMS,
		"elapsed_ms":       time.Since(mixedStart).Milliseconds(),
	})
	if e2e.Success {
		out.Success = true
		out.ScoreMS = e2e.ScoreMS
		out.LatencyMS = e2e.OverseasMS
		out.E2EDomesticMS = e2e.DomesticMS
		out.E2EOverseasMS = e2e.OverseasMS
		out.JitterMS = e2e.JitterMS
		return out
	}
	if strings.HasPrefix(e2e.FailStage, "parse") && baseline.Success {
		out.Success = true
		out.ProbeMode = "baseline"
		out.ScoreMS = baseline.LatencyMS
		out.LatencyMS = baseline.LatencyMS
		return out
	}
	if baseline.Success && shouldFallbackToBaselineOnE2EFailure(node, baseline, e2e) {
		out.Success = true
		out.ProbeMode = "baseline"
		out.ScoreMS = baseline.LatencyMS
		out.LatencyMS = baseline.LatencyMS
		out.FailStage = ""
		out.FailReason = ""
		out.ErrorMsg = ""
		return out
	}
	out.Success = false
	out.FailStage = e2e.FailStage
	out.FailReason = e2e.FailReason
	out.E2EDomesticMS = e2e.DomesticMS
	out.E2EOverseasMS = e2e.OverseasMS
	out.JitterMS = e2e.JitterMS
	if !baseline.Success && baseline.FailReason != "" && baseline.FailReason != "skipped_for_quic" {
		if out.FailReason != "" {
			out.FailReason += "; "
		}
		out.FailReason += "baseline: " + baseline.FailReason
	}
	if out.FailStage == "" {
		out.FailStage = "probe"
	}
	if out.FailReason == "" {
		out.FailReason = "probe failed"
	}
	out.ErrorMsg = out.FailStage + ": " + out.FailReason
	return out
}

func probeNodeLatencyE2E(node model.SubscriptionNode, timeoutMS int, probeCount int, cfg *subscriptionConfig, traceID string) subscriptionE2EResult {
	e2eStart := time.Now()
	buildStart := time.Now()
	outbound, err := buildSingBoxOutbound(node)
	if err != nil {
		subscriptionTraceLog(traceID, "e2e_build_outbound", map[string]any{"success": false, "elapsed_ms": time.Since(buildStart).Milliseconds(), "error": err.Error()})
		return subscriptionE2EResult{Success: false, FailStage: "parse", FailReason: "unsupported: " + err.Error()}
	}
	subscriptionTraceLog(traceID, "e2e_build_outbound", map[string]any{"success": true, "elapsed_ms": time.Since(buildStart).Milliseconds()})
	if probeCount <= 0 {
		probeCount = 3
	}
	if timeoutMS <= 0 {
		timeoutMS = 1200
	}
	domesticMedian, domSamples, domErr := probeSingBoxURLGroup(outbound, cfg.SingBoxPath, cfg.ProbeURLsDomestic, timeoutMS, probeCount, traceID, "domestic")
	overseasMedian, overSamples, overErr := probeSingBoxURLGroup(outbound, cfg.SingBoxPath, cfg.ProbeURLsOverseas, timeoutMS, probeCount, traceID, "overseas")
	if overseasMedian == nil {
		if overErr == "" {
			overErr = "all overseas probes failed"
		}
		stage, reason := classifyE2EFailure(overErr)
		subscriptionTraceLog(traceID, "e2e_done", map[string]any{"success": false, "elapsed_ms": time.Since(e2eStart).Milliseconds(), "fail_stage": stage, "fail_reason": reason})
		return subscriptionE2EResult{
			Success:       false,
			DomesticMS:    valueOrZero(domesticMedian),
			FailStage:     stage,
			FailReason:    reason,
			DomesticError: domErr,
			OverseasError: overErr,
		}
	}

	weighted := float64(*overseasMedian)
	if domesticMedian != nil {
		weighted = float64(*domesticMedian)*cfg.WeightDomestic + float64(*overseasMedian)*cfg.WeightOverseas
	}
	allLatencies := append(domSamples, overSamples...)
	jitter := 0
	if len(allLatencies) > 1 {
		sort.Ints(allLatencies)
		jitter = allLatencies[len(allLatencies)-1] - allLatencies[0]
		if jitter > 40 {
			weighted += float64(jitter-40) * 0.25
		}
	}
	out := int(math.Round(weighted))
	if out < 1 {
		out = 1
	}
	result := subscriptionE2EResult{
		Success:       true,
		DomesticMS:    valueOrZero(domesticMedian),
		OverseasMS:    valueOrZero(overseasMedian),
		ScoreMS:       out,
		JitterMS:      jitter,
		DomesticError: domErr,
		OverseasError: overErr,
	}
	subscriptionTraceLog(traceID, "e2e_done", map[string]any{"success": true, "elapsed_ms": time.Since(e2eStart).Milliseconds(), "domestic_ms": result.DomesticMS, "overseas_ms": result.OverseasMS, "score_ms": result.ScoreMS, "jitter_ms": result.JitterMS})
	return result
}

func probeSingBoxURLGroup(outbound map[string]any, singBoxPath string, urls []string, timeoutMS int, sampleCount int, traceID string, groupName string) (*int, []int, string) {
	groupStart := time.Now()
	if len(urls) == 0 {
		return nil, nil, "empty url group"
	}
	if strings.TrimSpace(singBoxPath) == "" {
		singBoxPath = "sing-box"
	}
	latencies := make([]int, 0, sampleCount)
	lastErr := ""
	for i := 0; i < sampleCount; i++ {
		urlToFetch := urls[i%len(urls)]
		lat, err := probeSingBoxFetchOnce(singBoxPath, outbound, urlToFetch, timeoutMS, traceID, groupName, i+1)
		if err != nil {
			lastErr = err.Error()
			subscriptionTraceLog(traceID, "e2e_group_sample", map[string]any{"group": groupName, "sample": i + 1, "success": false, "url": urlToFetch, "error": err.Error()})
			continue
		}
		subscriptionTraceLog(traceID, "e2e_group_sample", map[string]any{"group": groupName, "sample": i + 1, "success": true, "url": urlToFetch, "latency_ms": lat})
		latencies = append(latencies, lat)
	}
	if len(latencies) == 0 {
		if lastErr == "" {
			lastErr = "group probe failed"
		}
		subscriptionTraceLog(traceID, "e2e_group_done", map[string]any{"group": groupName, "success": false, "elapsed_ms": time.Since(groupStart).Milliseconds(), "error": lastErr})
		return nil, nil, lastErr
	}
	sort.Ints(latencies)
	mid := latencies[len(latencies)/2]
	subscriptionTraceLog(traceID, "e2e_group_done", map[string]any{"group": groupName, "success": true, "elapsed_ms": time.Since(groupStart).Milliseconds(), "median_ms": mid, "samples": len(latencies)})
	return &mid, latencies, ""
}

func probeSingBoxFetchOnce(singBoxPath string, outbound map[string]any, targetURL string, timeoutMS int, traceID string, groupName string, sample int) (int, error) {
	return probeSingBoxFetchOnceInternal(singBoxPath, outbound, targetURL, timeoutMS, true, traceID, groupName, sample, 1)
}

func probeSingBoxFetchOnceInternal(singBoxPath string, outbound map[string]any, targetURL string, timeoutMS int, allowRealityKeyRetry bool, traceID string, groupName string, sample int, attempt int) (int, error) {
	stepStart := time.Now()
	tmp, err := os.CreateTemp("", "all-monitor-sb-*.json")
	if err != nil {
		subscriptionTraceLog(traceID, "e2e_fetch_tempfile", map[string]any{"group": groupName, "sample": sample, "attempt": attempt, "success": false, "error": err.Error()})
		return 0, err
	}
	configPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(configPath)

	config := map[string]any{
		"log": map[string]any{"disabled": true},
		"outbounds": []any{
			outbound,
			map[string]any{"type": "direct", "tag": "direct"},
		},
		"route": map[string]any{
			"final": "probe",
		},
	}
	raw, _ := json.Marshal(config)
	if writeErr := os.WriteFile(configPath, raw, 0o600); writeErr != nil {
		subscriptionTraceLog(traceID, "e2e_fetch_write_config", map[string]any{"group": groupName, "sample": sample, "attempt": attempt, "success": false, "error": writeErr.Error()})
		return 0, writeErr
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()
	start := time.Now()
	cmd := exec.CommandContext(ctx, singBoxPath, "-c", configPath, "tools", "fetch", "-o", "probe", targetURL)
	if out, runErr := cmd.CombinedOutput(); runErr != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return 0, errors.New("upstream_http_timeout")
		}
		msg := stripANSI(strings.TrimSpace(string(out)))
		if msg == "" {
			msg = runErr.Error()
		}
		if allowRealityKeyRetry && strings.Contains(strings.ToLower(msg), "decode public_key") {
			if retryOutbound, ok := buildOutboundWithAlternateRealityKey(outbound); ok {
				subscriptionTraceLog(traceID, "e2e_fetch_retry_reality_key", map[string]any{"group": groupName, "sample": sample, "attempt": attempt, "error": msg})
				return probeSingBoxFetchOnceInternal(singBoxPath, retryOutbound, targetURL, timeoutMS, false, traceID, groupName, sample, attempt+1)
			}
		}
		lower := strings.ToLower(msg)
		switch {
		case strings.Contains(lower, "timeout"):
			msg = "upstream_http_timeout"
		case strings.Contains(lower, "first record does not look like a tls handshake"):
			msg = "proxy_handshake_failed"
		case strings.Contains(lower, "tls handshake"):
			msg = "proxy_handshake_failed"
		case strings.Contains(lower, "unknown version"):
			msg = "proxy_handshake_failed"
		case strings.Contains(lower, "proxy") && strings.Contains(lower, "handshake"):
			msg = "proxy_handshake_timeout"
		case strings.Contains(lower, "dns"):
			msg = "dns_timeout_via_proxy"
		case strings.Contains(lower, "unsupported"):
			msg = "proxy_handshake_failed"
		}
		if len(msg) > 200 {
			msg = msg[:200]
		}
		subscriptionTraceLog(traceID, "e2e_fetch_done", map[string]any{"group": groupName, "sample": sample, "attempt": attempt, "success": false, "elapsed_ms": time.Since(stepStart).Milliseconds(), "error": msg})
		return 0, errors.New(msg)
	}
	ms := int(time.Since(start).Seconds()*1000 + 0.5)
	if ms < 1 {
		ms = 1
	}
	subscriptionTraceLog(traceID, "e2e_fetch_done", map[string]any{"group": groupName, "sample": sample, "attempt": attempt, "success": true, "http_latency_ms": ms, "elapsed_ms": time.Since(stepStart).Milliseconds(), "url": targetURL})
	return ms, nil
}

func buildOutboundWithAlternateRealityKey(outbound map[string]any) (map[string]any, bool) {
	tlsObj, ok := outbound["tls"].(map[string]any)
	if !ok {
		return nil, false
	}
	realityObj, ok := tlsObj["reality"].(map[string]any)
	if !ok {
		return nil, false
	}
	key := strings.TrimSpace(fmt.Sprint(realityObj["public_key"]))
	if key == "" {
		return nil, false
	}

	alt := key
	if strings.ContainsAny(alt, "-_") {
		alt = strings.ReplaceAll(alt, "-", "+")
		alt = strings.ReplaceAll(alt, "_", "/")
		if mod := len(alt) % 4; mod != 0 {
			alt += strings.Repeat("=", 4-mod)
		}
	} else {
		alt = strings.ReplaceAll(alt, "+", "-")
		alt = strings.ReplaceAll(alt, "/", "_")
		alt = strings.TrimRight(alt, "=")
	}
	if strings.TrimSpace(alt) == "" || alt == key {
		return nil, false
	}

	raw, err := json.Marshal(outbound)
	if err != nil {
		return nil, false
	}
	clone := map[string]any{}
	if err := json.Unmarshal(raw, &clone); err != nil {
		return nil, false
	}
	cloneTLS, ok := clone["tls"].(map[string]any)
	if !ok {
		return nil, false
	}
	cloneReality, ok := cloneTLS["reality"].(map[string]any)
	if !ok {
		return nil, false
	}
	cloneReality["public_key"] = alt
	cloneTLS["reality"] = cloneReality
	clone["tls"] = cloneTLS
	return clone, true
}

func buildSingBoxOutbound(node model.SubscriptionNode) (map[string]any, error) {
	var raw map[string]any
	if err := json.Unmarshal([]byte(node.RawJSON), &raw); err != nil {
		return nil, err
	}
	if uri, ok := raw["uri"].(string); ok && strings.TrimSpace(uri) != "" {
		return buildSingBoxOutboundFromURI(uri)
	}
	return buildSingBoxOutboundFromMap(node, raw)
}

func buildSingBoxOutboundFromURI(uri string) (map[string]any, error) {
	u, err := url.Parse(uri)
	if err != nil {
		return nil, err
	}
	protocol := strings.ToLower(strings.TrimSpace(u.Scheme))
	switch protocol {
	case "trojan":
		password, _ := u.User.Password()
		if password == "" {
			password = u.User.Username()
		}
		if password == "" || u.Hostname() == "" || u.Port() == "" {
			return nil, errors.New("invalid trojan uri")
		}
		port, _ := strconv.Atoi(u.Port())
		out := map[string]any{
			"type":        "trojan",
			"tag":         "probe",
			"server":      u.Hostname(),
			"server_port": port,
			"password":    password,
		}
		tlsCfg := map[string]any{"enabled": true, "insecure": true}
		if sni := strings.TrimSpace(u.Query().Get("sni")); sni != "" {
			tlsCfg["server_name"] = sni
		}
		out["tls"] = tlsCfg
		return out, nil
	case "ss":
		ssCfg, err := parseShadowsocksURI(uri)
		if err != nil {
			return nil, err
		}
		out := map[string]any{
			"type":        "shadowsocks",
			"tag":         "probe",
			"server":      ssCfg.Server,
			"server_port": ssCfg.Port,
			"method":      ssCfg.Method,
			"password":    ssCfg.Password,
		}
		applySSPluginToOutbound(out, ssCfg.Plugin, ssCfg.PluginOpts)
		return out, nil
	case "vmess":
		payload, err := tryBase64Decode(strings.TrimPrefix(uri, "vmess://"))
		if err != nil {
			return nil, err
		}
		var item map[string]any
		if err := json.Unmarshal(payload, &item); err != nil {
			return nil, err
		}
		server := strings.TrimSpace(fmt.Sprint(item["add"]))
		port := toInt(item["port"])
		uuid := strings.TrimSpace(fmt.Sprint(item["id"]))
		if server == "" || port <= 0 || uuid == "" {
			return nil, errors.New("invalid vmess uri")
		}
		out := map[string]any{
			"type":        "vmess",
			"tag":         "probe",
			"server":      server,
			"server_port": port,
			"uuid":        uuid,
			"security":    "auto",
		}
		if netType := strings.TrimSpace(fmt.Sprint(item["net"])); netType == "ws" {
			transport := map[string]any{"type": "ws", "path": strings.TrimSpace(fmt.Sprint(item["path"]))}
			if host := strings.TrimSpace(fmt.Sprint(item["host"])); host != "" {
				transport["headers"] = map[string]any{"Host": host}
			}
			out["transport"] = transport
		}
		if tlsFlag := strings.TrimSpace(fmt.Sprint(item["tls"])); tlsFlag == "tls" || tlsFlag == "1" || strings.ToLower(strings.TrimSpace(fmt.Sprint(item["security"]))) == "tls" {
			tlsCfg := map[string]any{"enabled": true, "insecure": true}
			if sni := strings.TrimSpace(fmt.Sprint(item["sni"])); sni != "" {
				tlsCfg["server_name"] = sni
			}
			out["tls"] = tlsCfg
		}
		return out, nil
	case "vless":
		uuid := strings.TrimSpace(u.User.Username())
		port, _ := strconv.Atoi(u.Port())
		if uuid == "" || u.Hostname() == "" || port <= 0 {
			return nil, errors.New("invalid vless uri")
		}
		out := map[string]any{
			"type":        "vless",
			"tag":         "probe",
			"server":      u.Hostname(),
			"server_port": port,
			"uuid":        uuid,
		}
		q := u.Query()
		if flow := strings.TrimSpace(q.Get("flow")); flow != "" {
			out["flow"] = flow
		}
		if netType := strings.TrimSpace(q.Get("type")); netType == "ws" {
			transport := map[string]any{"type": "ws", "path": q.Get("path")}
			if host := strings.TrimSpace(q.Get("host")); host != "" {
				transport["headers"] = map[string]any{"Host": host}
			}
			out["transport"] = transport
		}
		sec := strings.ToLower(strings.TrimSpace(q.Get("security")))
		if sec == "tls" || sec == "reality" {
			tlsCfg := map[string]any{"enabled": true, "insecure": true}
			if sni := strings.TrimSpace(q.Get("sni")); sni != "" {
				tlsCfg["server_name"] = sni
			}
			if sec == "reality" {
				pbk := strings.TrimSpace(q.Get("pbk"))
				if pbk == "" {
					pbk = strings.TrimSpace(q.Get("public-key"))
				}
				if pbk == "" {
					return nil, errors.New("invalid vless reality uri: missing pbk")
				}
				reality := map[string]any{"enabled": true, "public_key": pbk}
				if sid := strings.TrimSpace(q.Get("sid")); sid != "" {
					reality["short_id"] = sid
				}
				tlsCfg["reality"] = reality
				if fp := strings.TrimSpace(q.Get("fp")); fp != "" {
					tlsCfg["utls"] = map[string]any{"enabled": true, "fingerprint": fp}
				}
			}
			out["tls"] = tlsCfg
		}
		return out, nil
	case "tuic":
		uuid := strings.TrimSpace(u.User.Username())
		password, _ := u.User.Password()
		password = strings.TrimSpace(password)
		if password == "" {
			password = strings.TrimSpace(u.Query().Get("password"))
		}
		port, _ := strconv.Atoi(u.Port())
		if uuid == "" || password == "" || u.Hostname() == "" || port <= 0 {
			return nil, errors.New("invalid tuic uri")
		}
		version := toInt(u.Query().Get("version"))
		if version != 0 && version != 5 {
			return nil, errors.New("unsupported tuic version")
		}
		out := map[string]any{
			"type":        "tuic",
			"tag":         "probe",
			"server":      u.Hostname(),
			"server_port": port,
			"uuid":        uuid,
			"password":    password,
		}
		tlsCfg := map[string]any{"enabled": true, "insecure": false}
		if sni := strings.TrimSpace(u.Query().Get("sni")); sni != "" {
			tlsCfg["server_name"] = sni
		}
		if insecure := strings.TrimSpace(strings.ToLower(u.Query().Get("insecure"))); insecure == "1" || insecure == "true" {
			tlsCfg["insecure"] = true
		}
		if alpnRaw := strings.TrimSpace(u.Query().Get("alpn")); alpnRaw != "" {
			parts := strings.Split(alpnRaw, ",")
			alpn := make([]string, 0, len(parts))
			for _, item := range parts {
				v := strings.TrimSpace(item)
				if v != "" {
					alpn = append(alpn, v)
				}
			}
			if len(alpn) > 0 {
				tlsCfg["alpn"] = alpn
			}
		}
		out["tls"] = tlsCfg
		if cc := strings.TrimSpace(u.Query().Get("congestion_control")); cc != "" {
			out["congestion_control"] = cc
		}
		return out, nil
	case "hysteria2", "hy2":
		password := strings.TrimSpace(u.User.Username())
		if password == "" {
			password, _ = u.User.Password()
			password = strings.TrimSpace(password)
		}
		if password == "" {
			password = strings.TrimSpace(u.Query().Get("password"))
		}
		port, _ := strconv.Atoi(u.Port())
		if password == "" || u.Hostname() == "" || port <= 0 {
			return nil, errors.New("invalid hysteria2 uri")
		}
		out := map[string]any{
			"type":        "hysteria2",
			"tag":         "probe",
			"server":      u.Hostname(),
			"server_port": port,
			"password":    password,
		}
		tlsCfg := map[string]any{"enabled": true, "insecure": false}
		if sni := strings.TrimSpace(u.Query().Get("sni")); sni != "" {
			tlsCfg["server_name"] = sni
		}
		if insecure := strings.TrimSpace(strings.ToLower(u.Query().Get("insecure"))); insecure == "1" || insecure == "true" {
			tlsCfg["insecure"] = true
		}
		if alpnRaw := strings.TrimSpace(u.Query().Get("alpn")); alpnRaw != "" {
			parts := strings.Split(alpnRaw, ",")
			alpn := make([]string, 0, len(parts))
			for _, item := range parts {
				v := strings.TrimSpace(item)
				if v != "" {
					alpn = append(alpn, v)
				}
			}
			if len(alpn) > 0 {
				tlsCfg["alpn"] = alpn
			}
		}
		out["tls"] = tlsCfg
		if obfs := strings.TrimSpace(u.Query().Get("obfs")); obfs != "" {
			obfsObj := map[string]any{"type": obfs}
			if obfsPwd := strings.TrimSpace(u.Query().Get("obfs-password")); obfsPwd != "" {
				obfsObj["password"] = obfsPwd
			}
			out["obfs"] = obfsObj
		}
		if up := toInt(u.Query().Get("upmbps")); up > 0 {
			out["up_mbps"] = up
		}
		if down := toInt(u.Query().Get("downmbps")); down > 0 {
			out["down_mbps"] = down
		}
		return out, nil
	default:
		return nil, errors.New("unsupported protocol: " + protocol)
	}
}

func buildSingBoxOutboundFromMap(node model.SubscriptionNode, raw map[string]any) (map[string]any, error) {
	protocol := strings.ToLower(strings.TrimSpace(fmt.Sprint(raw["type"])))
	if protocol == "" {
		protocol = strings.ToLower(strings.TrimSpace(node.Protocol))
	}
	server := strings.TrimSpace(fmt.Sprint(raw["server"]))
	if server == "" {
		server = node.Server
	}
	port := toInt(raw["port"])
	if port <= 0 {
		port = node.Port
	}
	switch protocol {
	case "ss", "shadowsocks":
		method := strings.TrimSpace(fmt.Sprint(raw["cipher"]))
		if method == "" {
			method = strings.TrimSpace(fmt.Sprint(raw["method"]))
		}
		password := strings.TrimSpace(fmt.Sprint(raw["password"]))
		if method == "" || password == "" || server == "" || port <= 0 {
			return nil, errors.New("invalid ss node")
		}
		out := map[string]any{"type": "shadowsocks", "tag": "probe", "server": server, "server_port": port, "method": method, "password": password}
		plugin := toString(raw["plugin"])
		pluginOpts := pluginOptsFromAny(raw["plugin_opts"])
		if pluginOpts == "" {
			pluginOpts = pluginOptsFromAny(raw["plugin-opts"])
		}
		applySSPluginToOutbound(out, plugin, pluginOpts)
		return out, nil
	case "tuic":
		uuid := toString(raw["uuid"])
		password := toString(raw["password"])
		if password == "" {
			password = toString(raw["token"])
		}
		version := toInt(raw["version"])
		if version != 0 && version != 5 {
			return nil, errors.New("unsupported tuic version")
		}
		if uuid == "" || password == "" || server == "" || port <= 0 {
			return nil, errors.New("invalid tuic node")
		}
		out := map[string]any{
			"type":        "tuic",
			"tag":         "probe",
			"server":      server,
			"server_port": port,
			"uuid":        uuid,
			"password":    password,
		}
		tlsCfg := map[string]any{"enabled": true}
		insecure := false
		if v, ok := raw["skip-cert-verify"].(bool); ok {
			insecure = v
		}
		if !insecure {
			if v, ok := raw["insecure"].(bool); ok {
				insecure = v
			}
		}
		tlsCfg["insecure"] = insecure
		sni := toString(raw["sni"])
		if sni == "" {
			sni = toString(raw["servername"])
		}
		if sni != "" {
			tlsCfg["server_name"] = sni
		}
		if vals, ok := raw["alpn"].([]any); ok {
			alpn := make([]string, 0, len(vals))
			for _, item := range vals {
				v := strings.TrimSpace(fmt.Sprint(item))
				if v != "" {
					alpn = append(alpn, v)
				}
			}
			if len(alpn) > 0 {
				tlsCfg["alpn"] = alpn
			}
		}
		out["tls"] = tlsCfg
		if cc := toString(raw["congestion-controller"]); cc != "" {
			out["congestion_control"] = cc
		}
		if cc := toString(raw["congestion_control"]); cc != "" {
			out["congestion_control"] = cc
		}
		return out, nil
	case "hysteria2", "hy2":
		password := toString(raw["password"])
		if password == "" {
			password = toString(raw["auth"])
		}
		if password == "" {
			password = toString(raw["auth-str"])
		}
		if password == "" || server == "" || port <= 0 {
			return nil, errors.New("invalid hysteria2 node")
		}
		out := map[string]any{
			"type":        "hysteria2",
			"tag":         "probe",
			"server":      server,
			"server_port": port,
			"password":    password,
		}
		tlsCfg := map[string]any{"enabled": true}
		insecure := false
		if v, ok := raw["skip-cert-verify"].(bool); ok {
			insecure = v
		}
		if !insecure {
			if v, ok := raw["insecure"].(bool); ok {
				insecure = v
			}
		}
		tlsCfg["insecure"] = insecure
		sni := toString(raw["sni"])
		if sni == "" {
			sni = toString(raw["servername"])
		}
		if sni != "" {
			tlsCfg["server_name"] = sni
		}
		if vals, ok := raw["alpn"].([]any); ok {
			alpn := make([]string, 0, len(vals))
			for _, item := range vals {
				v := strings.TrimSpace(fmt.Sprint(item))
				if v != "" {
					alpn = append(alpn, v)
				}
			}
			if len(alpn) > 0 {
				tlsCfg["alpn"] = alpn
			}
		}
		out["tls"] = tlsCfg
		if obfs := toString(raw["obfs"]); obfs != "" {
			obfsObj := map[string]any{"type": obfs}
			if obfsPwd := toString(raw["obfs-password"]); obfsPwd != "" {
				obfsObj["password"] = obfsPwd
			}
			out["obfs"] = obfsObj
		}
		if up := toInt(raw["up"]); up > 0 {
			out["up_mbps"] = up
		}
		if up := toInt(raw["up_mbps"]); up > 0 {
			out["up_mbps"] = up
		}
		if down := toInt(raw["down"]); down > 0 {
			out["down_mbps"] = down
		}
		if down := toInt(raw["down_mbps"]); down > 0 {
			out["down_mbps"] = down
		}
		return out, nil
	case "trojan":
		password := strings.TrimSpace(fmt.Sprint(raw["password"]))
		if password == "" || server == "" || port <= 0 {
			return nil, errors.New("invalid trojan node")
		}
		out := map[string]any{"type": "trojan", "tag": "probe", "server": server, "server_port": port, "password": password}
		tlsCfg := map[string]any{"enabled": true, "insecure": true}
		if sni := strings.TrimSpace(fmt.Sprint(raw["sni"])); sni != "" {
			tlsCfg["server_name"] = sni
		}
		out["tls"] = tlsCfg
		return out, nil
	case "vmess":
		uuid := strings.TrimSpace(fmt.Sprint(raw["uuid"]))
		if uuid == "" {
			uuid = strings.TrimSpace(fmt.Sprint(raw["id"]))
		}
		if uuid == "" || server == "" || port <= 0 {
			return nil, errors.New("invalid vmess node")
		}
		out := map[string]any{"type": "vmess", "tag": "probe", "server": server, "server_port": port, "uuid": uuid, "security": "auto"}
		if tlsOn, ok := raw["tls"].(bool); ok && tlsOn {
			tlsCfg := map[string]any{"enabled": true, "insecure": true}
			if sni := strings.TrimSpace(fmt.Sprint(raw["servername"])); sni != "" {
				tlsCfg["server_name"] = sni
			}
			out["tls"] = tlsCfg
		}
		if netType := strings.ToLower(strings.TrimSpace(fmt.Sprint(raw["network"]))); netType == "ws" {
			transport := map[string]any{"type": "ws", "path": strings.TrimSpace(fmt.Sprint(raw["ws-path"]))}
			if host := strings.TrimSpace(fmt.Sprint(raw["ws-headers"])); host != "" {
				transport["headers"] = map[string]any{"Host": host}
			}
			out["transport"] = transport
		}
		return out, nil
	case "vless":
		uuid := toString(raw["uuid"])
		if uuid == "" || server == "" || port <= 0 {
			return nil, errors.New("invalid vless node")
		}
		out := map[string]any{"type": "vless", "tag": "probe", "server": server, "server_port": port, "uuid": uuid}
		if flow := toString(raw["flow"]); flow != "" {
			out["flow"] = flow
		}
		tlsOn, _ := raw["tls"].(bool)
		sec := strings.ToLower(toString(raw["security"]))
		_, hasRealityOpts := raw["reality-opts"]
		isReality := sec == "reality" || hasRealityOpts || toString(raw["pbk"]) != "" || toString(raw["reality-public-key"]) != ""
		if tlsOn || sec == "tls" || isReality {
			tlsCfg := map[string]any{"enabled": true, "insecure": true}
			sni := toString(raw["servername"])
			if sni == "" {
				sni = toString(raw["sni"])
			}
			if sni != "" {
				tlsCfg["server_name"] = sni
			}

			if isReality {
				pbk := toString(raw["pbk"])
				if pbk == "" {
					pbk = toString(raw["reality-public-key"])
				}
				sid := toString(raw["sid"])
				if sid == "" {
					sid = toString(raw["reality-short-id"])
				}
				fp := toString(raw["client-fingerprint"])
				if fp == "" {
					fp = toString(raw["fp"])
				}
				if opts, ok := raw["reality-opts"].(map[string]any); ok {
					if pbk == "" {
						pbk = toString(opts["public-key"])
						if pbk == "" {
							pbk = toString(opts["public_key"])
						}
					}
					if sid == "" {
						sid = toString(opts["short-id"])
						if sid == "" {
							sid = toString(opts["short_id"])
						}
					}
					if fp == "" {
						fp = toString(opts["fingerprint"])
					}
				}
				if pbk == "" {
					return nil, errors.New("invalid vless reality node: missing pbk")
				}
				reality := map[string]any{"enabled": true, "public_key": pbk}
				if sid != "" {
					reality["short_id"] = sid
				}
				tlsCfg["reality"] = reality
				if fp != "" {
					tlsCfg["utls"] = map[string]any{"enabled": true, "fingerprint": fp}
				}
			}
			out["tls"] = tlsCfg
		}
		if netType := strings.ToLower(strings.TrimSpace(fmt.Sprint(raw["network"]))); netType == "ws" {
			transport := map[string]any{"type": "ws", "path": strings.TrimSpace(fmt.Sprint(raw["ws-path"]))}
			if host := strings.TrimSpace(fmt.Sprint(raw["ws-headers"])); host != "" {
				transport["headers"] = map[string]any{"Host": host}
			}
			out["transport"] = transport
		}
		return out, nil
	default:
		return nil, errors.New("unsupported protocol: " + protocol)
	}
}

type shadowsocksURIConfig struct {
	Server     string
	Port       int
	Method     string
	Password   string
	Plugin     string
	PluginOpts string
}

func parseShadowsocksURI(raw string) (*shadowsocksURIConfig, error) {
	u, parseErr := url.Parse(raw)
	if parseErr != nil {
		return nil, parseErr
	}
	cfg := &shadowsocksURIConfig{Server: u.Hostname()}
	cfg.Port, _ = strconv.Atoi(u.Port())
	if u.User != nil {
		cfg.Method = u.User.Username()
		cfg.Password, _ = u.User.Password()
	}
	plugin, pluginOpts := parseSSPluginQuery(u.Query())
	cfg.Plugin = plugin
	cfg.PluginOpts = pluginOpts

	if cfg.Method == "" || cfg.Password == "" || cfg.Server == "" || cfg.Port <= 0 {
		inner := strings.TrimPrefix(raw, "ss://")
		inner = strings.Split(inner, "#")[0]
		inner = strings.Split(inner, "?")[0]
		if idx := strings.Index(inner, "@"); idx > 0 {
			left := inner[:idx]
			right := inner[idx+1:]
			if decoded, decodeErr := tryBase64Decode(left); decodeErr == nil {
				left = string(decoded)
			}
			if parts := strings.SplitN(left, ":", 2); len(parts) == 2 {
				cfg.Method = parts[0]
				cfg.Password = parts[1]
			}
			if h, p, splitErr := net.SplitHostPort(right); splitErr == nil {
				cfg.Server = h
				cfg.Port, _ = strconv.Atoi(p)
			}
		}
	}
	if cfg.Method == "" || cfg.Password == "" || cfg.Server == "" || cfg.Port <= 0 {
		return nil, errors.New("invalid ss uri")
	}
	return cfg, nil
}

func parseSSPluginQuery(q url.Values) (string, string) {
	plugin := strings.TrimSpace(q.Get("plugin"))
	pluginOpts := strings.TrimSpace(q.Get("plugin_opts"))
	if pluginOpts == "" {
		pluginOpts = strings.TrimSpace(q.Get("plugin-opts"))
	}
	if plugin != "" && strings.Contains(plugin, ";") {
		parts := strings.Split(plugin, ";")
		plugin = strings.TrimSpace(parts[0])
		if pluginOpts == "" && len(parts) > 1 {
			pluginOpts = strings.Join(parts[1:], ";")
		}
	}
	return plugin, pluginOpts
}

func applySSPluginToOutbound(out map[string]any, plugin string, pluginOpts string) {
	plugin = strings.TrimSpace(plugin)
	if plugin == "" {
		return
	}
	out["plugin"] = plugin
	if strings.TrimSpace(pluginOpts) != "" {
		out["plugin_opts"] = strings.TrimSpace(pluginOpts)
	}
}

func pluginOptsFromAny(v any) string {
	switch val := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(val)
	case map[string]any:
		parts := make([]string, 0, len(val))
		for k, raw := range val {
			parts = append(parts, fmt.Sprintf("%s=%v", k, raw))
		}
		sort.Strings(parts)
		return strings.Join(parts, ";")
	default:
		if v == nil {
			return ""
		}
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

func probeNodeOnce(addr string, timeoutMS int, useTLS bool, serverName string) (int, error) {
	start := time.Now()
	if useTLS {
		dialer := &net.Dialer{Timeout: time.Duration(timeoutMS) * time.Millisecond}
		conn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: serverName, InsecureSkipVerify: true})
		if err != nil {
			return 0, err
		}
		_ = conn.Close()
	} else {
		conn, err := net.DialTimeout("tcp", addr, time.Duration(timeoutMS)*time.Millisecond)
		if err != nil {
			return 0, err
		}
		_ = conn.Close()
	}
	lat := int(time.Since(start).Seconds()*1000 + 0.5)
	if lat < 1 {
		lat = 1
	}
	return lat, nil
}

func probeTransportPlan(node model.SubscriptionNode) (primaryTLS bool, fallbackTLS *bool, serverName string) {
	protocol := strings.ToLower(strings.TrimSpace(node.Protocol))
	serverName = node.Server
	if protocol == "trojan" || protocol == "tuic" || protocol == "hysteria" || protocol == "hysteria2" {
		return true, nil, serverName
	}
	if protocol == "vmess" || protocol == "vless" {
		fallback := false
		return true, &fallback, serverName
	}
	return false, nil, serverName
}

func shouldSkipBaselineProbe(node model.SubscriptionNode) bool {
	protocol := strings.ToLower(strings.TrimSpace(node.Protocol))
	return protocol == "tuic" || protocol == "hysteria" || protocol == "hysteria2" || protocol == "hy2"
}

func classifyE2EFailure(raw string) (string, string) {
	reason := strings.TrimSpace(strings.ToLower(raw))
	if reason == "" {
		return "e2e", "all_overseas_failed"
	}
	switch {
	case strings.Contains(reason, "first record does not look like a tls handshake"):
		return "proxy_handshake", "proxy_handshake_failed"
	case strings.Contains(reason, "proxy_handshake_timeout"):
		return "proxy_handshake", "proxy_handshake_timeout"
	case strings.Contains(reason, "proxy_handshake_failed"):
		return "proxy_handshake", "proxy_handshake_failed"
	case strings.Contains(reason, "dns_timeout_via_proxy"):
		return "dns", "dns_timeout_via_proxy"
	case strings.Contains(reason, "upstream_http_timeout"):
		return "e2e", "upstream_http_timeout"
	case strings.Contains(reason, "unsupported"):
		return "parse", reason
	default:
		return "e2e", reason
	}
}

func shouldFallbackToBaselineOnE2EFailure(node model.SubscriptionNode, baseline subscriptionBaselineResult, e2e subscriptionE2EResult) bool {
	if e2e.Success {
		return false
	}
	if baseline.TLSMS <= 0 {
		return false
	}
	protocol := strings.ToLower(strings.TrimSpace(node.Protocol))
	if protocol == "ss" || protocol == "shadowsocks" || protocol == "tuic" || protocol == "hysteria" || protocol == "hysteria2" {
		return false
	}
	reason := strings.ToLower(strings.TrimSpace(e2e.FailReason))
	if strings.Contains(reason, "proxy_handshake_failed") || strings.Contains(reason, "proxy_handshake_timeout") {
		return true
	}
	if strings.Contains(reason, "upstream_http_timeout") || strings.Contains(reason, "dns_timeout_via_proxy") {
		return true
	}
	if strings.Contains(reason, "first record does not look like a tls handshake") {
		return true
	}
	return false
}

func stripANSI(text string) string {
	if text == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(text))
	inEsc := false
	for i := 0; i < len(text); i++ {
		ch := text[i]
		if inEsc {
			if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') {
				inEsc = false
			}
			continue
		}
		if ch == 0x1b {
			inEsc = true
			continue
		}
		b.WriteByte(ch)
	}
	return b.String()
}

func valueOrZero(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}

func medianInt(vals []int) int {
	if len(vals) == 0 {
		return 0
	}
	sorted := append([]int(nil), vals...)
	sort.Ints(sorted)
	return sorted[len(sorted)/2]
}

func medianIntOrZero(vals []int) int {
	if len(vals) == 0 {
		return 0
	}
	return medianInt(vals)
}
