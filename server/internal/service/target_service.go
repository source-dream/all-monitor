package service

import (
	"all-monitor/server/internal/checker"
	"all-monitor/server/internal/model"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"gorm.io/gorm"
)

type TargetService struct {
	DB          *gorm.DB
	GeoResolver GeoResolver
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
