package model

import "time"

type User struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Username     string    `gorm:"size:64;uniqueIndex;not null" json:"username"`
	PasswordHash string    `gorm:"size:255;not null" json:"-"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type SystemSetting struct {
	ID        uint   `gorm:"primaryKey"`
	Key       string `gorm:"size:64;uniqueIndex;not null"`
	Value     string `gorm:"type:text;not null"`
	CreatedAt time.Time
	UpdatedAt time.Time
}

type MonitorTarget struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"size:100;not null" json:"name"`
	Type        string    `gorm:"size:32;index;not null" json:"type"`
	Endpoint    string    `gorm:"type:text;not null" json:"endpoint"`
	IntervalSec int       `gorm:"not null;default:60" json:"interval_sec"`
	TimeoutMS   int       `gorm:"not null;default:5000" json:"timeout_ms"`
	Enabled     bool      `gorm:"not null;default:true" json:"enabled"`
	ConfigJSON  string    `gorm:"type:text;default:'{}'" json:"config_json"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type CheckResult struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	TargetID  uint      `gorm:"index;not null" json:"target_id"`
	Success   bool      `gorm:"index;not null" json:"success"`
	LatencyMS int       `gorm:"not null" json:"latency_ms"`
	ErrorMsg  string    `gorm:"type:text" json:"error_msg"`
	CheckedAt time.Time `gorm:"index;not null" json:"checked_at"`
}

type RelayFinanceSnapshot struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	TargetID    uint      `gorm:"index;not null" json:"target_id"`
	Currency    string    `gorm:"size:16;not null;default:'USD'" json:"currency"`
	LimitAmount float64   `gorm:"not null" json:"limit_amount"`
	UsedAmount  float64   `gorm:"not null" json:"used_amount"`
	Balance     float64   `gorm:"not null" json:"balance"`
	CheckedAt   time.Time `gorm:"index;not null" json:"checked_at"`
}

type TrackingEvent struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	TargetID   uint      `gorm:"index;not null" json:"target_id"`
	EventName  string    `gorm:"size:64;index;not null" json:"event_name"`
	Page       string    `gorm:"size:255" json:"page"`
	Count      int       `gorm:"not null;default:1" json:"count"`
	ClientID   string    `gorm:"size:128;index" json:"client_id"`
	UserID     string    `gorm:"size:128;index" json:"user_id"`
	UVKey      string    `gorm:"size:128;index" json:"uv_key"`
	ClientIP   string    `gorm:"size:64;index" json:"client_ip"`
	UserAgent  string    `gorm:"size:512" json:"user_agent"`
	Referer    string    `gorm:"size:1024" json:"referer"`
	GeoText    string    `gorm:"size:255" json:"geo_text"`
	MetaJSON   string    `gorm:"type:text;default:'{}'" json:"meta_json"`
	OccurredAt time.Time `gorm:"index;not null" json:"occurred_at"`
	CreatedAt  time.Time `json:"created_at"`
}

func AutoMigrateModels() []any {
	return []any{
		&User{},
		&SystemSetting{},
		&MonitorTarget{},
		&CheckResult{},
		&RelayFinanceSnapshot{},
		&TrackingEvent{},
	}
}
