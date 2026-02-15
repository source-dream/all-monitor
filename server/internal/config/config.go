package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	AppPort    string
	DBDriver   string
	DBHost     string
	DBPort     string
	DBUser     string
	DBPass     string
	DBName     string
	SQLiteDSN  string
	JWTSecret  string
	CORSAllow  string
	IPRegionDB string
}

func Load() (*Config, error) {
	cfg := &Config{
		AppPort:    getOrDefault("APP_PORT", "8080"),
		DBDriver:   getOrDefault("DB_DRIVER", "sqlite"),
		DBHost:     getOrDefault("DB_HOST", "127.0.0.1"),
		DBPort:     getOrDefault("DB_PORT", "5432"),
		DBUser:     getOrDefault("DB_USER", "postgres"),
		DBPass:     getOrDefault("DB_PASS", "postgres"),
		DBName:     getOrDefault("DB_NAME", "all_monitor"),
		SQLiteDSN:  getOrDefault("SQLITE_DSN", "data/all-monitor.db"),
		JWTSecret:  os.Getenv("JWT_SECRET"),
		CORSAllow:  getOrDefault("CORS_ALLOW", "http://localhost:5173"),
		IPRegionDB: getOrDefault("IP_REGION_DB", "data/ip2region.xdb"),
	}

	if cfg.JWTSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET is required")
	}

	cfg.DBDriver = strings.ToLower(cfg.DBDriver)

	return cfg, nil
}

func (c *Config) PostgresDSN() string {
	return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		c.DBHost, c.DBPort, c.DBUser, c.DBPass, c.DBName)
}

func getOrDefault(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
