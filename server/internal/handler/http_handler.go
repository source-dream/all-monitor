package handler

import (
	"all-monitor/server/internal/model"
	"all-monitor/server/internal/service"
	"all-monitor/server/pkg/response"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type Handler struct {
	Auth   *service.AuthService
	Target *service.TargetService
}

type trackingIngestRequest struct {
	Events []service.TrackingIngestItem `json:"events"`
}

type setupRequest struct {
	Username string `json:"username" binding:"required,min=3,max=32"`
	Password string `json:"password" binding:"required,min=8,max=64"`
}

type loginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

type createTargetRequest struct {
	Name        string `json:"name" binding:"required,min=2,max=100"`
	Type        string `json:"type" binding:"required,min=2,max=32"`
	Endpoint    string `json:"endpoint"`
	IntervalSec int    `json:"interval_sec"`
	TimeoutMS   int    `json:"timeout_ms"`
	Enabled     *bool  `json:"enabled"`
	ConfigJSON  string `json:"config_json"`
}

func (h *Handler) Setup(c *gin.Context) {
	var req setupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Err(c, 400, 40001, "invalid request")
		return
	}

	if err := h.Auth.BootstrapAdmin(req.Username, req.Password); err != nil {
		response.Err(c, 400, 40002, err.Error())
		return
	}

	response.OK(c, gin.H{"initialized": true})
}

func (h *Handler) InitStatus(c *gin.Context) {
	initialized, err := h.Auth.IsInitialized()
	if err != nil {
		response.Err(c, 500, 50001, "query init status failed")
		return
	}
	response.OK(c, gin.H{"initialized": initialized})
}

func (h *Handler) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Err(c, 400, 40001, "invalid request")
		return
	}

	token, err := h.Auth.Login(req.Username, req.Password)
	if err != nil {
		response.Err(c, 401, 40103, err.Error())
		return
	}

	response.OK(c, gin.H{"access_token": token})
}

func (h *Handler) CreateTarget(c *gin.Context) {
	var req createTargetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Err(c, 400, 40001, "invalid request")
		return
	}

	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	if req.TimeoutMS <= 0 {
		req.TimeoutMS = 5000
	}
	if req.ConfigJSON == "" {
		req.ConfigJSON = "{}"
	}
	req.Type = normalizeTargetType(req.Type)
	if req.Type == "subscription" {
		if req.IntervalSec < 0 {
			req.IntervalSec = 0
		}
	} else if req.IntervalSec <= 0 {
		req.IntervalSec = 60
	}
	if req.Type == "subscription" {
		normalizedCfg, cfgErr := normalizeSubscriptionConfig(req.ConfigJSON)
		if cfgErr != nil {
			response.Err(c, 400, 40001, cfgErr.Error())
			return
		}
		req.ConfigJSON = normalizedCfg
	}

	if req.Type == "tracking" {
		if strings.TrimSpace(req.Endpoint) == "" {
			req.Endpoint = "tracking://ingest"
		}
		req.IntervalSec = 60
		req.TimeoutMS = 5000
	} else if req.Type == "port" {
		if strings.TrimSpace(req.Endpoint) == "" {
			response.Err(c, 400, 40001, "endpoint is required")
			return
		}
		if req.ConfigJSON == "{}" {
			req.ConfigJSON = `{"protocol":"tcp"}`
		}
	} else if strings.TrimSpace(req.Endpoint) == "" {
		response.Err(c, 400, 40001, "endpoint is required")
		return
	}

	target := model.MonitorTarget{
		Name:        req.Name,
		Type:        req.Type,
		Endpoint:    req.Endpoint,
		IntervalSec: req.IntervalSec,
		TimeoutMS:   req.TimeoutMS,
		Enabled:     enabled,
		ConfigJSON:  req.ConfigJSON,
	}

	if err := h.Target.CreateTarget(&target); err != nil {
		response.Err(c, 500, 50011, "create target failed")
		return
	}

	response.OK(c, target)
}

func (h *Handler) ListTargets(c *gin.Context) {
	data, err := h.Target.ListTargets()
	if err != nil {
		response.Err(c, 500, 50012, "list targets failed")
		return
	}
	response.OK(c, data)
}

func (h *Handler) GetTarget(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	target, err := h.Target.GetTarget(uint(id))
	if err != nil {
		response.Err(c, 404, 40401, "target not found")
		return
	}

	response.OK(c, target)
}

func (h *Handler) UpdateTarget(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	var input model.MonitorTarget
	if err := c.ShouldBindJSON(&input); err != nil {
		response.Err(c, 400, 40001, "invalid request")
		return
	}

	input.Type = normalizeTargetType(input.Type)
	if input.Type == "subscription" {
		if input.IntervalSec < 0 {
			input.IntervalSec = 0
		}
	} else if input.IntervalSec <= 0 {
		input.IntervalSec = 60
	}
	if input.TimeoutMS <= 0 {
		input.TimeoutMS = 5000
	}
	if input.ConfigJSON == "" {
		input.ConfigJSON = "{}"
	}
	if input.Type == "subscription" {
		normalizedCfg, cfgErr := normalizeSubscriptionConfig(input.ConfigJSON)
		if cfgErr != nil {
			response.Err(c, 400, 40001, cfgErr.Error())
			return
		}
		input.ConfigJSON = normalizedCfg
	}

	if input.Type == "tracking" {
		if strings.TrimSpace(input.Endpoint) == "" {
			input.Endpoint = "tracking://ingest"
		}
		input.IntervalSec = 60
		input.TimeoutMS = 5000
	} else if input.Type == "port" {
		if strings.TrimSpace(input.Endpoint) == "" {
			response.Err(c, 400, 40001, "endpoint is required")
			return
		}
		if input.ConfigJSON == "{}" {
			input.ConfigJSON = `{"protocol":"tcp"}`
		}
	} else if strings.TrimSpace(input.Endpoint) == "" {
		response.Err(c, 400, 40001, "endpoint is required")
		return
	}

	if err := h.Target.UpdateTarget(uint(id), &input); err != nil {
		response.Err(c, 500, 50013, "update target failed")
		return
	}

	response.OK(c, gin.H{"updated": true})
}

func normalizeTargetType(raw string) string {
	val := strings.TrimSpace(strings.ToLower(raw))
	switch val {
	case "http":
		return "site"
	case "api":
		return "ai"
	case "tcp", "server", "node":
		return "port"
	default:
		return val
	}
}

func (h *Handler) DeleteTarget(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	if err := h.Target.DeleteTarget(uint(id)); err != nil {
		response.Err(c, 500, 50014, "delete target failed")
		return
	}

	response.OK(c, gin.H{"deleted": true})
}

func (h *Handler) Overview(c *gin.Context) {
	overview, err := h.Target.DashboardOverview()
	if err != nil {
		response.Err(c, 500, 50021, "load overview failed")
		return
	}
	response.OK(c, overview)
}

func (h *Handler) CheckNow(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	result, err := h.Target.CheckNow(uint(id))
	if err != nil {
		response.Err(c, 500, 50015, err.Error())
		return
	}

	response.OK(c, result)
}

func (h *Handler) TargetResults(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	limit := 100
	if val := c.Query("limit"); val != "" {
		if parsed, convErr := strconv.Atoi(val); convErr == nil {
			limit = parsed
		}
	}

	results, err := h.Target.ListResults(uint(id), limit)
	if err != nil {
		response.Err(c, 500, 50016, "load results failed")
		return
	}

	response.OK(c, results)
}

func (h *Handler) TargetFinance(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	summary, err := h.Target.FinanceSummary(uint(id))
	if err != nil {
		response.Err(c, 500, 50017, "load finance summary failed")
		return
	}

	response.OK(c, summary)
}

func (h *Handler) IngestTracking(c *gin.Context) {
	writeKey := c.Param("write_key")
	if writeKey == "" {
		response.Err(c, 400, 40004, "missing write key")
		return
	}

	raw, err := c.GetRawData()
	if err != nil {
		response.Err(c, 400, 40001, "invalid request")
		return
	}

	var req trackingIngestRequest
	if err := json.Unmarshal(raw, &req); err != nil || len(req.Events) == 0 {
		var one service.TrackingIngestItem
		if oneErr := json.Unmarshal(raw, &one); oneErr == nil {
			req.Events = []service.TrackingIngestItem{one}
		} else {
			response.Err(c, 400, 40001, "invalid request")
			return
		}
	}

	targetID, accepted, err := h.Target.IngestTracking(writeKey, req.Events, c.ClientIP(), c.GetHeader("User-Agent"), c.GetHeader("Referer"))
	if err != nil {
		response.Err(c, 400, 40005, err.Error())
		return
	}

	response.OK(c, gin.H{"target_id": targetID, "accepted": accepted})
}

func (h *Handler) TrackingSummary(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	rangeHours := 24
	if val := c.Query("hours"); val != "" {
		if parsed, convErr := strconv.Atoi(val); convErr == nil && parsed > 0 && parsed <= 24*30 {
			rangeHours = parsed
		}
	}
	since := time.Now().Add(-time.Duration(rangeHours) * time.Hour)

	summary, err := h.Target.TrackingSummary(uint(id), since)
	if err != nil {
		response.Err(c, 500, 50018, "load tracking summary failed")
		return
	}

	response.OK(c, summary)
}

func (h *Handler) TrackingSeries(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	rangeHours := 24
	if val := c.Query("hours"); val != "" {
		if parsed, convErr := strconv.Atoi(val); convErr == nil && parsed > 0 && parsed <= 24*30 {
			rangeHours = parsed
		}
	}
	since := time.Now().Add(-time.Duration(rangeHours) * time.Hour)

	series, err := h.Target.TrackingSeries(uint(id), since)
	if err != nil {
		response.Err(c, 500, 50019, "load tracking series failed")
		return
	}

	response.OK(c, series)
}

func (h *Handler) TrackingEvents(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	limit := 100
	if val := c.Query("limit"); val != "" {
		if parsed, convErr := strconv.Atoi(val); convErr == nil {
			limit = parsed
		}
	}

	var since *time.Time
	if val := c.Query("hours"); val != "" {
		if parsed, convErr := strconv.Atoi(val); convErr == nil && parsed > 0 && parsed <= 24*30 {
			s := time.Now().Add(-time.Duration(parsed) * time.Hour)
			since = &s
		}
	}

	events, err := h.Target.TrackingEvents(uint(id), limit, since)
	if err != nil {
		response.Err(c, 500, 50020, "load tracking events failed")
		return
	}

	response.OK(c, events)
}

func (h *Handler) SubscriptionSummary(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	data, err := h.Target.SubscriptionSummary(uint(id))
	if err != nil {
		response.Err(c, 500, 50030, "load subscription summary failed")
		return
	}
	response.OK(c, data)
}

func (h *Handler) SubscriptionNodes(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	sortBy := c.DefaultQuery("sort", "source")
	order := c.DefaultQuery("order", "asc")
	search := c.Query("search")
	protocol := c.Query("protocol")

	rows, err := h.Target.SubscriptionNodes(uint(id), sortBy, order, search, protocol)
	if err != nil {
		response.Err(c, 500, 50031, "load subscription nodes failed")
		return
	}
	response.OK(c, rows)
}

func (h *Handler) SubscriptionRefreshLatency(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	data, err := h.Target.RefreshSubscriptionLatency(uint(id))
	if err != nil {
		response.Err(c, 400, 40001, err.Error())
		return
	}
	response.OK(c, data)
}

func (h *Handler) StartSubscriptionLatencyJob(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}

	job, err := h.Target.StartSubscriptionLatencyJob(uint(id))
	if err != nil {
		response.Err(c, 400, 40001, err.Error())
		return
	}
	response.OK(c, job)
}

func (h *Handler) SubscriptionLatencyJobStatus(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}
	jobID := c.Param("job_id")
	if strings.TrimSpace(jobID) == "" {
		response.Err(c, 400, 40001, "missing job id")
		return
	}

	job, err := h.Target.SubscriptionLatencyJobStatus(uint(id), jobID)
	if err != nil {
		response.Err(c, 404, 40431, err.Error())
		return
	}
	response.OK(c, job)
}

func (h *Handler) SubscriptionLatencyJobEvents(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}
	jobID := c.Param("job_id")
	if strings.TrimSpace(jobID) == "" {
		response.Err(c, 400, 40001, "missing job id")
		return
	}

	snap, ch, cancel, err := h.Target.SubscribeSubscriptionLatencyJob(uint(id), jobID)
	if err != nil {
		response.Err(c, 404, 40431, err.Error())
		return
	}
	defer cancel()

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	if _, ok := c.Writer.(http.Flusher); !ok {
		response.Err(c, 500, 50036, "stream unsupported")
		return
	}

	c.SSEvent("snapshot", service.SubscriptionLatencyJobEvent{Type: "snapshot", Job: snap})
	c.Writer.Flush()

	pingTicker := time.NewTicker(10 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-pingTicker.C:
			c.SSEvent("ping", gin.H{"ts": time.Now().Unix()})
			c.Writer.Flush()
		case event, ok := <-ch:
			if !ok {
				return
			}
			c.SSEvent(event.Type, event)
			c.Writer.Flush()
			if event.Type == "done" || event.Type == "failed" {
				return
			}
		}
	}
}

func (h *Handler) SubscriptionNodeSummary(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}
	uid := c.Param("uid")
	since := time.Now().Add(-24 * time.Hour)
	data, err := h.Target.SubscriptionNodeSummary(uint(id), uid, since)
	if err != nil {
		response.Err(c, 500, 50032, "load subscription node summary failed")
		return
	}
	response.OK(c, data)
}

func (h *Handler) SubscriptionNodeSeries(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}
	uid := c.Param("uid")
	hours := 24
	if val := c.Query("hours"); val != "" {
		if n, convErr := strconv.Atoi(val); convErr == nil && n > 0 && n <= 24*30 {
			hours = n
		}
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour)
	data, err := h.Target.SubscriptionNodeSeries(uint(id), uid, since)
	if err != nil {
		response.Err(c, 500, 50033, "load subscription node series failed")
		return
	}
	response.OK(c, data)
}

func (h *Handler) SubscriptionNodeLogs(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}
	uid := c.Param("uid")
	limit := 100
	if val := c.Query("limit"); val != "" {
		if n, convErr := strconv.Atoi(val); convErr == nil {
			limit = n
		}
	}
	rows, err := h.Target.SubscriptionNodeLogs(uint(id), uid, limit)
	if err != nil {
		response.Err(c, 500, 50034, "load subscription node logs failed")
		return
	}
	response.OK(c, rows)
}

func (h *Handler) SubscriptionNodeCheckNow(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		response.Err(c, 400, 40003, "invalid id")
		return
	}
	uid := c.Param("uid")
	data, err := h.Target.SubscriptionNodeCheckNow(uint(id), uid)
	if err != nil {
		response.Err(c, 500, 50035, "subscription node check failed")
		return
	}
	response.OK(c, data)
}

type subscriptionConfigPayload struct {
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

func normalizeSubscriptionConfig(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	var cfg subscriptionConfigPayload
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return "", errors.New("invalid subscription config")
	}
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
	switch strings.ToLower(strings.TrimSpace(cfg.FetchHTTPMode)) {
	case "h1", "http1", "http1.1":
		cfg.FetchHTTPMode = "h1"
	case "h2", "http2":
		cfg.FetchHTTPMode = "h2"
	default:
		cfg.FetchHTTPMode = "auto"
	}
	if strings.TrimSpace(cfg.FetchUserAgent) == "" {
		cfg.FetchUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
	}
	cfg.FetchProxyURL = strings.TrimSpace(cfg.FetchProxyURL)
	cfg.FetchCookie = strings.TrimSpace(cfg.FetchCookie)
	if cfg.LatencyConcurrency <= 0 {
		return "", errors.New("latency_concurrency must be greater than 0")
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
	if strings.TrimSpace(cfg.SingBoxPath) == "" {
		cfg.SingBoxPath = "sing-box"
	}
	cfg.ManualExpireAt = strings.TrimSpace(cfg.ManualExpireAt)
	if cfg.ManualExpireAt != "" {
		layouts := []string{time.RFC3339, "2006-01-02T15:04", "2006-01-02 15:04:05"}
		valid := false
		for _, layout := range layouts {
			if _, err := time.Parse(layout, cfg.ManualExpireAt); err == nil {
				valid = true
				break
			}
			if _, err := time.ParseInLocation(layout, cfg.ManualExpireAt, time.Local); err == nil {
				valid = true
				break
			}
		}
		if !valid {
			return "", errors.New("manual_expire_at format invalid")
		}
	}
	normalized, _ := json.Marshal(cfg)
	return string(normalized), nil
}
