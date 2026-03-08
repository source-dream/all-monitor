export type Target = {
	id: number
	name: string
	type: string
	endpoint: string
	interval_sec: number
	timeout_ms: number
	enabled: boolean
	config_json?: string
}

export type CheckResult = {
	id: number
	target_id: number
	success: boolean
	latency_ms: number
	error_msg: string
	checked_at: string
}

export type CreateTargetPayload = {
	name: string
	type: string
	endpoint: string
	interval_sec: number
	timeout_ms: number
	enabled: boolean
	config_json: string
}

export type FinanceSummary = {
	has_data: boolean
	currency?: string
	balance?: number
	used_total?: number
	limit_amount?: number
	daily_spent?: number
	updated_at?: string
}

export type TrackingSummary = {
	has_data: boolean
	pv?: number
	uv?: number
	last_event_at?: string
	last_event_name?: string
	last_event_page?: string
}

export type TrackingEvent = {
	id: number
	target_id: number
	event_name: string
	page: string
	count: number
	client_id: string
	user_id: string
	uv_key: string
	client_ip: string
	user_agent: string
	referer: string
	geo_text: string
	meta_json: string
	occurred_at: string
}

export type TrackingSeriesPoint = {
	bucket: string
	pv: number
	uv: number
}

export type SubscriptionSummary = {
	has_data: boolean
	reachable?: boolean
	http_status?: number
	latency_ms?: number
	error_msg?: string
	node_total?: number
	available_total?: number
	protocol_stats?: Record<string, number>
	upload_bytes?: number
	download_bytes?: number
	total_bytes?: number
	remaining_bytes?: number
	expire_at?: string
	last_checked_at?: string
}

export type SubscriptionNode = {
	id: number
	node_uid: string
	name: string
	protocol: string
	server: string
	port: number
	source_order: number
	last_latency_ms?: number
	last_score_ms?: number
	last_tcp_ms?: number
	last_tls_ms?: number
	last_e2e_domestic_ms?: number
	last_e2e_overseas_ms?: number
	last_jitter_ms?: number
	last_probe_mode?: string
	last_fail_stage?: string
	last_fail_reason?: string
	last_error_msg?: string
	last_latency_checked_at?: string
	availability_24h?: number
	check_count_24h?: number
	raw_json?: string
}

export type SubscriptionNodeCheck = {
	id: number
	target_id: number
	node_uid: string
	success: boolean
	latency_ms: number
	score_ms: number
	tcp_ms: number
	tls_ms: number
	e2e_domestic_ms: number
	e2e_overseas_ms: number
	jitter_ms: number
	probe_mode: string
	fail_stage: string
	fail_reason: string
	error_msg: string
	checked_at: string
}

export type SubscriptionNodeSummary = {
	node: SubscriptionNode
	availability_24h: number
	avg_latency_24h_ms: number
	check_count_24h: number
	success_count_24h: number
	latest_latency_ms?: number
	latest_checked_at?: string
}

export type SubscriptionNodeSeriesPoint = {
	checked_at: string
	success: boolean
	latency_ms: number
	availability: number
	error_msg: string
}

export type SubscriptionSeriesPoint = {
	bucket: string
	available_nodes: number
	availability: number
	total_checks: number
}

export type SubscriptionLatencyJobStatus = {
	job_id: string
	target_id: number
	status: 'running' | 'done' | 'failed'
	total: number
	done: number
	success: number
	failed: number
	started_at: string
	finished_at?: string
	updated_at: string
	message?: string
}

export type SubscriptionLatencyJobNode = {
	node_uid: string
	latency_ms?: number
	error_msg?: string
	checked_at: string
}

export type SubscriptionLatencyJobEvent = {
	type: string
	job: SubscriptionLatencyJobStatus
	node?: SubscriptionLatencyJobNode
}

export type TrackingMetricMode = 'pv' | 'uv' | 'both'
export type UVIdentity = 'client_id' | 'ip_ua_hash' | 'ip_client_hash'
export type UserGroupMode = 'ip' | 'device_id' | 'ip_device'
export type PortProtocol = 'tcp' | 'udp'
export type UDPMode = 'send_only' | 'request_response'

export type TrackingConfig = {
	write_key: string
	metric_mode: TrackingMetricMode
	uv_identity: UVIdentity
	inactive_threshold_min: number
	user_group_mode: UserGroupMode
}

export type PortConfig = {
	protocol: PortProtocol
	udp_mode: UDPMode
	udp_payload: string
	udp_expect: string
}

export type SubscriptionConfig = {
	latency_concurrency: number
	latency_timeout_ms: number
	e2e_timeout_ms: number
	fetch_timeout_ms: number
	fetch_retries: number
	fetch_proxy_url: string
	fetch_user_agent: string
	fetch_cookie: string
	latency_probe_count: number
	latency_interval_sec: number
	weight_domestic: number
	weight_overseas: number
	probe_urls_domestic: string[]
	probe_urls_overseas: string[]
	singbox_path: string
	manual_expire_at: string
	node_uris: string[]
}

export type PreferenceDefaultsPayload = {
	scope: string
	version: number
	values: Record<string, unknown>
	updated_at?: string
}

export type SubscriptionCreateDefaults = {
	latency_concurrency: number
	latency_timeout_ms: number
	e2e_timeout_ms: number
	fetch_timeout_ms: number
	fetch_retries: number
	fetch_proxy_url: string
	fetch_user_agent: string
	fetch_cookie: string
	latency_probe_count: number
	latency_interval_sec: number
	weight_domestic: number
	weight_overseas: number
	probe_urls_domestic: string[]
	probe_urls_overseas: string[]
	singbox_path: string
	interval_sec: number
	timeout_ms: number
}

export type TrackingStatusInfo = {
	label: string
	variant: 'ok' | 'down' | 'degraded' | 'paused'
}

export type UptimeBlock = {
	label: string
	status: 'up' | 'down' | 'unknown'
	latency: number | null
}

export type CardState = 'normal' | 'degraded' | 'down' | 'paused'
