package handler

import (
	"all-monitor/server/internal/model"
	"all-monitor/server/internal/service"
	"all-monitor/server/pkg/response"
	"encoding/json"
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
	if req.IntervalSec <= 0 {
		req.IntervalSec = 60
	}
	if req.TimeoutMS <= 0 {
		req.TimeoutMS = 5000
	}
	if req.ConfigJSON == "" {
		req.ConfigJSON = "{}"
	}

	if req.Type == "tracking" {
		if strings.TrimSpace(req.Endpoint) == "" {
			req.Endpoint = "tracking://ingest"
		}
		req.IntervalSec = 60
		req.TimeoutMS = 5000
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

	if err := h.Target.UpdateTarget(uint(id), &input); err != nil {
		response.Err(c, 500, 50013, "update target failed")
		return
	}

	response.OK(c, gin.H{"updated": true})
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
