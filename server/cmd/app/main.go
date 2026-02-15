package main

import (
	"all-monitor/server/internal/config"
	"all-monitor/server/internal/geo"
	"all-monitor/server/internal/handler"
	"all-monitor/server/internal/model"
	"all-monitor/server/internal/router"
	"all-monitor/server/internal/scheduler"
	"all-monitor/server/internal/service"
	"context"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func main() {
	// 开发环境优先加载 .env 文件，方便本地直接运行。
	_ = godotenv.Load()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config failed: %v", err)
	}

	db, err := openDB(cfg)
	if err != nil {
		log.Fatalf("connect database failed: %v", err)
	}

	if err := db.AutoMigrate(model.AutoMigrateModels()...); err != nil {
		log.Fatalf("auto migrate failed: %v", err)
	}

	authService := &service.AuthService{DB: db, JWTSecret: cfg.JWTSecret}
	var geoResolver service.GeoResolver
	if cfg.IPRegionDB != "" {
		resolver, geoErr := geo.NewIP2RegionResolver(cfg.IPRegionDB)
		if geoErr != nil {
			log.Printf("ip region resolver disabled: %v", geoErr)
		} else {
			geoResolver = resolver
			log.Printf("ip region resolver loaded: %s", cfg.IPRegionDB)
		}
	}

	targetService := &service.TargetService{DB: db, GeoResolver: geoResolver}
	h := &handler.Handler{Auth: authService, Target: targetService}

	// 调度器独立协程运行，负责周期性写入检测结果。
	s := &scheduler.Scheduler{DB: db, Concurrency: 8}
	go s.Start(context.Background())

	r := gin.Default()
	allowedOrigins, allowLAN := parseCORSAllow(cfg.CORSAllow)
	r.Use(cors.New(cors.Config{
		AllowOriginFunc: func(origin string) bool {
			if len(allowedOrigins) == 1 && allowedOrigins[0] == "*" {
				return true
			}
			for _, item := range allowedOrigins {
				if origin == item {
					return true
				}
			}
			if allowLAN {
				return isPrivateLANOrigin(origin)
			}
			return false
		},
		AllowMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders: []string{"Authorization", "Content-Type"},
	}))
	router.Register(r, h, cfg.JWTSecret)

	listener, boundPort, err := listenWithFallback(cfg.AppPort, 20)
	if err != nil {
		log.Fatalf("bind server port failed: %v", err)
	}
	if boundPort != cfg.AppPort {
		log.Printf("port %s is busy, switched to :%s", cfg.AppPort, boundPort)
	}
	log.Printf("server started at :%s", boundPort)
	if err := r.RunListener(listener); err != nil {
		log.Fatalf("run server failed: %v", err)
	}
}

func listenWithFallback(basePort string, maxRetry int) (net.Listener, string, error) {
	start, err := strconv.Atoi(basePort)
	if err != nil {
		return nil, "", fmt.Errorf("invalid APP_PORT %q: %w", basePort, err)
	}

	if maxRetry < 0 {
		maxRetry = 0
	}

	for i := 0; i <= maxRetry; i++ {
		port := strconv.Itoa(start + i)
		addr := ":" + port
		listener, listenErr := net.Listen("tcp", addr)
		if listenErr == nil {
			return listener, port, nil
		}

		if !isAddrInUseErr(listenErr) {
			return nil, "", listenErr
		}
	}

	return nil, "", fmt.Errorf("no available port in range %d-%d", start, start+maxRetry)
}

func isAddrInUseErr(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "address already in use")
}

func parseCORSAllow(raw string) ([]string, bool) {
	parts := strings.Split(raw, ",")
	origins := make([]string, 0, len(parts))
	allowLAN := false
	for _, part := range parts {
		item := strings.TrimSpace(part)
		if item == "" {
			continue
		}
		if strings.EqualFold(item, "auto") || strings.EqualFold(item, "lan") {
			allowLAN = true
			continue
		}
		origins = append(origins, item)
	}
	if len(origins) == 0 {
		origins = []string{"http://localhost:5173"}
	}
	return origins, allowLAN
}

func isPrivateLANOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	return ip.IsPrivate()
}

func openDB(cfg *config.Config) (*gorm.DB, error) {
	if cfg.DBDriver == "sqlite" {
		if err := os.MkdirAll(filepath.Dir(cfg.SQLiteDSN), 0o755); err != nil {
			return nil, err
		}
		return gorm.Open(sqlite.Open(cfg.SQLiteDSN), &gorm.Config{})
	}

	db, err := gorm.Open(postgres.Open(cfg.PostgresDSN()), &gorm.Config{})
	if err != nil {
		return nil, err
	}
	return db, nil
}
