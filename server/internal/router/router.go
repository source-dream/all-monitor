package router

import (
	"all-monitor/server/internal/handler"
	"all-monitor/server/internal/middleware"

	"github.com/gin-gonic/gin"
)

func Register(r *gin.Engine, h *handler.Handler, jwtSecret, basePath string) {
	root := r.Group(basePath)
	root.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	api := root.Group("/api")
	{
		api.GET("/init/status", h.InitStatus)
		api.POST("/init/setup", h.Setup)
		api.POST("/auth/login", h.Login)
		api.POST("/ingest/:write_key", h.IngestTracking)
		api.POST("/public/shares/:token/access", h.PublicShareAccess)
		api.GET("/public/shares/:token/dashboard", h.PublicShareDashboard)
	}

	authed := api.Group("", middleware.JWTAuth(jwtSecret))
	{
		authed.GET("/dashboard/overview", h.Overview)
		authed.GET("/targets", h.ListTargets)
		authed.GET("/targets/:id", h.GetTarget)
		authed.POST("/targets", h.CreateTarget)
		authed.PUT("/targets/:id", h.UpdateTarget)
		authed.DELETE("/targets/:id", h.DeleteTarget)
		authed.POST("/targets/:id/check-now", h.CheckNow)
		authed.GET("/targets/:id/results", h.TargetResults)
		authed.GET("/targets/:id/finance", h.TargetFinance)
		authed.GET("/targets/:id/tracking/summary", h.TrackingSummary)
		authed.GET("/targets/:id/tracking/series", h.TrackingSeries)
		authed.GET("/targets/:id/tracking/events", h.TrackingEvents)
		authed.GET("/targets/:id/subscription/summary", h.SubscriptionSummary)
		authed.GET("/targets/:id/subscription/series", h.SubscriptionSeries)
		authed.GET("/targets/:id/subscription/nodes", h.SubscriptionNodes)
		authed.POST("/targets/:id/subscription/latency/refresh", h.SubscriptionRefreshLatency)
		authed.POST("/targets/:id/subscription/latency/jobs", h.StartSubscriptionLatencyJob)
		authed.GET("/targets/:id/subscription/latency/jobs/:job_id", h.SubscriptionLatencyJobStatus)
		authed.GET("/targets/:id/subscription/latency/jobs/:job_id/events", h.SubscriptionLatencyJobEvents)
		authed.GET("/targets/:id/subscription/nodes/:uid/summary", h.SubscriptionNodeSummary)
		authed.GET("/targets/:id/subscription/nodes/:uid/series", h.SubscriptionNodeSeries)
		authed.GET("/targets/:id/subscription/nodes/:uid/logs", h.SubscriptionNodeLogs)
		authed.POST("/targets/:id/subscription/nodes/:uid/check-now", h.SubscriptionNodeCheckNow)
		authed.DELETE("/targets/:id/subscription/nodes/:uid", h.SubscriptionNodeDelete)
		authed.GET("/preferences/defaults/:scope", h.GetPreferenceDefaults)
		authed.PUT("/preferences/defaults/:scope", h.UpdatePreferenceDefaults)
		authed.POST("/shares", h.CreateShareTask)
		authed.GET("/shares", h.ListShareTasks)
		authed.PUT("/shares/:id", h.UpdateShareTask)
		authed.DELETE("/shares/:id", h.DeleteShareTask)
	}
}
