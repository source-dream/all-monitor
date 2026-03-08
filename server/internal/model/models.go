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
	IntervalSec int       `gorm:"not null" json:"interval_sec"`
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

type SubscriptionSnapshot struct {
	ID                uint       `gorm:"primaryKey" json:"id"`
	TargetID          uint       `gorm:"index;not null" json:"target_id"`
	Reachable         bool       `gorm:"index;not null" json:"reachable"`
	HTTPStatus        int        `gorm:"not null" json:"http_status"`
	LatencyMS         int        `gorm:"not null" json:"latency_ms"`
	ErrorMsg          string     `gorm:"type:text" json:"error_msg"`
	NodeTotal         int        `gorm:"not null;default:0" json:"node_total"`
	ProtocolStatsJSON string     `gorm:"type:text;default:'{}'" json:"protocol_stats_json"`
	UploadBytes       int64      `gorm:"not null;default:0" json:"upload_bytes"`
	DownloadBytes     int64      `gorm:"not null;default:0" json:"download_bytes"`
	TotalBytes        int64      `gorm:"not null;default:0" json:"total_bytes"`
	RemainingBytes    int64      `gorm:"not null;default:0" json:"remaining_bytes"`
	ExpireAt          *time.Time `json:"expire_at"`
	ContentHash       string     `gorm:"size:64;index" json:"content_hash"`
	CheckedAt         time.Time  `gorm:"index;not null" json:"checked_at"`
}

type SubscriptionNode struct {
	ID                   uint       `gorm:"primaryKey" json:"id"`
	TargetID             uint       `gorm:"index;not null" json:"target_id"`
	NodeUID              string     `gorm:"size:80;index;not null" json:"node_uid"`
	Name                 string     `gorm:"size:255" json:"name"`
	Protocol             string     `gorm:"size:32;index" json:"protocol"`
	Server               string     `gorm:"size:255;index" json:"server"`
	Port                 int        `gorm:"not null;default:0" json:"port"`
	SourceOrder          int        `gorm:"not null;default:0" json:"source_order"`
	LastLatencyMS        *int       `json:"last_latency_ms"`
	LastScoreMS          int        `gorm:"not null;default:0" json:"last_score_ms"`
	LastTCPMS            int        `gorm:"not null;default:0" json:"last_tcp_ms"`
	LastTLSMS            int        `gorm:"not null;default:0" json:"last_tls_ms"`
	LastE2EDomesticMS    int        `gorm:"not null;default:0" json:"last_e2e_domestic_ms"`
	LastE2EOverseasMS    int        `gorm:"not null;default:0" json:"last_e2e_overseas_ms"`
	LastJitterMS         int        `gorm:"not null;default:0" json:"last_jitter_ms"`
	LastProbeMode        string     `gorm:"size:32;index;not null;default:'mixed'" json:"last_probe_mode"`
	LastFailStage        string     `gorm:"size:64;index" json:"last_fail_stage"`
	LastFailReason       string     `gorm:"type:text" json:"last_fail_reason"`
	LastErrorMsg         string     `gorm:"type:text" json:"last_error_msg"`
	LastLatencyCheckedAt *time.Time `json:"last_latency_checked_at"`
	RawJSON              string     `gorm:"type:text;default:'{}'" json:"raw_json"`
	Availability24h      *float64   `gorm:"-" json:"availability_24h,omitempty"`
	CheckCount24h        int64      `gorm:"-" json:"check_count_24h,omitempty"`
	UpdatedAt            time.Time  `json:"updated_at"`
	CreatedAt            time.Time  `json:"created_at"`
}

type SubscriptionNodeCheck struct {
	ID            uint      `gorm:"primaryKey" json:"id"`
	TargetID      uint      `gorm:"index;not null" json:"target_id"`
	NodeUID       string    `gorm:"size:80;index;not null" json:"node_uid"`
	Success       bool      `gorm:"index;not null" json:"success"`
	LatencyMS     int       `gorm:"not null;default:0" json:"latency_ms"`
	ScoreMS       int       `gorm:"not null;default:0" json:"score_ms"`
	TCPMS         int       `gorm:"not null;default:0" json:"tcp_ms"`
	TLSMS         int       `gorm:"not null;default:0" json:"tls_ms"`
	E2EDomesticMS int       `gorm:"not null;default:0" json:"e2e_domestic_ms"`
	E2EOverseasMS int       `gorm:"not null;default:0" json:"e2e_overseas_ms"`
	JitterMS      int       `gorm:"not null;default:0" json:"jitter_ms"`
	ProbeMode     string    `gorm:"size:32;index;not null;default:'mixed'" json:"probe_mode"`
	FailStage     string    `gorm:"size:64;index" json:"fail_stage"`
	FailReason    string    `gorm:"type:text" json:"fail_reason"`
	ErrorMsg      string    `gorm:"type:text" json:"error_msg"`
	CheckedAt     time.Time `gorm:"index;not null" json:"checked_at"`
}

func AutoMigrateModels() []any {
	return []any{
		&User{},
		&SystemSetting{},
		&MonitorTarget{},
		&CheckResult{},
		&RelayFinanceSnapshot{},
		&TrackingEvent{},
		&SubscriptionSnapshot{},
		&SubscriptionNode{},
		&SubscriptionNodeCheck{},
	}
}
