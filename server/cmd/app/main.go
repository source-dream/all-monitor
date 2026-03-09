package main

import (
	"all-monitor/server/internal/config"
	"all-monitor/server/internal/geo"
	"all-monitor/server/internal/handler"
	"all-monitor/server/internal/model"
	"all-monitor/server/internal/router"
	"all-monitor/server/internal/scheduler"
	"all-monitor/server/internal/service"
	"all-monitor/server/internal/webstatic"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
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
	if err := ensureDefaultEnvFile(".env"); err != nil {
		log.Printf("prepare default .env failed: %v", err)
	}

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

	if changed, err := normalizeLegacyTargetTypes(db); err != nil {
		log.Fatalf("normalize legacy target types failed: %v", err)
	} else if changed > 0 {
		log.Printf("normalized %d legacy targets", changed)
	}

	authService := &service.AuthService{DB: db, JWTSecret: cfg.JWTSecret}
	var geoResolver service.GeoResolver
	if cfg.IPRegionDB != "" {
		resolver, geoErr := geo.NewIP2RegionResolver(cfg.IPRegionDB)
		if geoErr != nil {
			if !errors.Is(geoErr, os.ErrNotExist) {
				log.Printf("ip region resolver disabled: %v", geoErr)
			}
		} else {
			geoResolver = resolver
			log.Printf("ip region resolver loaded: %s", cfg.IPRegionDB)
		}
	}

	targetService := &service.TargetService{DB: db, GeoResolver: geoResolver}
	prefService := &service.PreferenceService{DB: db}
	h := &handler.Handler{Auth: authService, Target: targetService, Pref: prefService}

	// 调度器独立协程运行，负责周期性写入检测结果。
	s := &scheduler.Scheduler{DB: db, Concurrency: 8, Target: targetService}
	go s.Start(context.Background())

	r := gin.Default()
	if err := r.SetTrustedProxies(nil); err != nil {
		log.Fatalf("configure trusted proxies failed: %v", err)
	}
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
	router.Register(r, h, cfg.JWTSecret, cfg.AppBasePath)
	registerEmbeddedWeb(r, cfg.AppBasePath)

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

func ensureDefaultEnvFile(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	jwtSecret, err := generateJWTSecret()
	if err != nil {
		return err
	}

	content := fmt.Sprintf("APP_PORT=8080\nAPP_BASE_PATH=/\nDB_DRIVER=sqlite\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_USER=sqlite\nDB_PASS=sqlite\nDB_NAME=all_monitor\nSQLITE_DSN=data/all-monitor.db\nJWT_SECRET=%s\nCORS_ALLOW=http://localhost:5173,auto\nIP_REGION_DB=data/ip2region.xdb\n", jwtSecret)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return err
	}

	log.Printf("created default %s", path)
	return nil
}

func generateJWTSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func registerEmbeddedWeb(r *gin.Engine, basePath string) {
	distFS, err := webstatic.DistFS()
	if err != nil || !webstatic.HasIndex(distFS) {
		log.Printf("embedded web assets not found, frontend static serving disabled")
		return
	}

	indexHTML, err := fs.ReadFile(distFS, "index.html")
	if err != nil {
		log.Printf("embedded web index load failed: %v", err)
		return
	}

	fileServer := http.FileServer(http.FS(distFS))
	indexWithBasePath := injectBasePath(indexHTML, basePath)
	apiPrefix := basePath + "/api"
	if basePath == "/" {
		apiPrefix = "/api"
	}
	basePathPrefix := strings.TrimRight(basePath, "/") + "/"
	r.NoRoute(func(c *gin.Context) {
		requestPath := c.Request.URL.Path
		if strings.HasPrefix(requestPath, apiPrefix+"/") || requestPath == apiPrefix {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		if basePath != "/" {
			if requestPath != basePath && !strings.HasPrefix(requestPath, basePathPrefix) {
				c.Status(http.StatusNotFound)
				return
			}
		}
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.Status(http.StatusNotFound)
			return
		}

		relativePath := requestPath
		if basePath != "/" {
			relativePath = strings.TrimPrefix(requestPath, basePath)
		}
		path := strings.TrimPrefix(relativePath, "/")
		if path == "" || path == "index.html" {
			c.Data(http.StatusOK, "text/html; charset=utf-8", indexWithBasePath)
			return
		}

		if st, statErr := fs.Stat(distFS, path); statErr == nil && !st.IsDir() {
			c.Request.URL.Path = "/" + path
			fileServer.ServeHTTP(c.Writer, c.Request)
			return
		}

		c.Data(http.StatusOK, "text/html; charset=utf-8", indexWithBasePath)
	})
	log.Printf("embedded web assets enabled")
}

func injectBasePath(indexHTML []byte, basePath string) []byte {
	if basePath == "" {
		basePath = "/"
	}
	html := string(indexHTML)
	if basePath != "/" {
		html = strings.ReplaceAll(html, "href=\"/", fmt.Sprintf("href=\"%s/", basePath))
		html = strings.ReplaceAll(html, "src=\"/", fmt.Sprintf("src=\"%s/", basePath))
	}
	snippet := fmt.Sprintf("<script>window.__APP_BASE_PATH__=%q;</script>", basePath)
	if strings.Contains(html, "</head>") {
		return []byte(strings.Replace(html, "</head>", snippet+"</head>", 1))
	}
	return []byte(snippet + html)
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

func normalizeLegacyTargetTypes(db *gorm.DB) (int, error) {
	var targets []model.MonitorTarget
	if err := db.Where("type IN ?", []string{"http", "api", "tcp", "server", "node"}).Find(&targets).Error; err != nil {
		return 0, err
	}

	updated := 0
	for _, target := range targets {
		newType := target.Type
		switch target.Type {
		case "http":
			newType = "site"
		case "api":
			newType = "ai"
		case "tcp", "server", "node":
			newType = "port"
		}

		configJSON := strings.TrimSpace(target.ConfigJSON)
		if configJSON == "" {
			configJSON = "{}"
		}

		if newType == "port" {
			cfg := map[string]any{}
			_ = json.Unmarshal([]byte(configJSON), &cfg)
			if _, ok := cfg["protocol"]; !ok {
				cfg["protocol"] = "tcp"
			}
			if _, ok := cfg["udp_mode"]; !ok {
				cfg["udp_mode"] = "send_only"
			}
			if _, ok := cfg["udp_payload"]; !ok {
				cfg["udp_payload"] = "ping"
			}
			buf, err := json.Marshal(cfg)
			if err == nil {
				configJSON = string(buf)
			}
		}

		if err := db.Model(&model.MonitorTarget{}).Where("id = ?", target.ID).Updates(map[string]any{
			"type":        newType,
			"config_json": configJSON,
		}).Error; err != nil {
			return updated, err
		}
		updated++
	}

	return updated, nil
}
