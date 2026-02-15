import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Clock3,
  Gauge,
  PauseCircle,
  Pencil,
  PlayCircle,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import Flatpickr from 'react-flatpickr'
import 'flatpickr/dist/flatpickr.min.css'
import { Mandarin } from 'flatpickr/dist/l10n/zh.js'
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { useRef } from 'react'

type ApiBody<T> = {
  code: number
  message: string
  data: T
}

type ThemeMode = 'light' | 'dark'

type Target = {
  id: number
  name: string
  type: string
  endpoint: string
  interval_sec: number
  timeout_ms: number
  enabled: boolean
  config_json?: string
}

type CheckResult = {
  id: number
  target_id: number
  success: boolean
  latency_ms: number
  error_msg: string
  checked_at: string
}

type CreateTargetPayload = {
  name: string
  type: string
  endpoint: string
  interval_sec: number
  timeout_ms: number
  enabled: boolean
  config_json: string
}

type FinanceSummary = {
	has_data: boolean
	currency?: string
	balance?: number
	used_total?: number
	limit_amount?: number
	daily_spent?: number
	updated_at?: string
}

type TrackingSummary = {
	has_data: boolean
	pv?: number
	uv?: number
	last_event_at?: string
	last_event_name?: string
	last_event_page?: string
}

type TrackingEvent = {
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

type TrackingSeriesPoint = {
	bucket: string
	pv: number
	uv: number
}

type TrackingMetricMode = 'pv' | 'uv' | 'both'
type UVIdentity = 'client_id' | 'ip_ua_hash' | 'ip_client_hash'
type UserGroupMode = 'ip' | 'device_id' | 'ip_device'

type TrackingConfig = {
	write_key: string
	metric_mode: TrackingMetricMode
	uv_identity: UVIdentity
	inactive_threshold_min: number
	user_group_mode: UserGroupMode
}

type TrackingStatusInfo = {
	label: string
	variant: 'ok' | 'down' | 'degraded' | 'paused'
}

type UptimeBlock = {
  label: string
  status: 'up' | 'down' | 'unknown'
  latency: number | null
}

type CardState = 'normal' | 'degraded' | 'down' | 'paused'

const TYPE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'site', label: '站点' },
  { value: 'api', label: 'AI官方' },
  { value: 'tracking', label: '埋点' },
  { value: 'server', label: '服务器' },
  { value: 'node', label: '节点' },
  { value: 'subscription', label: '订阅' },
  { value: 'ai', label: 'AI中转站' },
  { value: 'http', label: 'HTTP' },
  { value: 'tcp', label: 'TCP' },
]

const CREATE_TYPE_OPTIONS = TYPE_OPTIONS.filter((item) => item.value !== 'all')
const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080'

async function api<T>(path: string, options?: RequestInit, token?: string): Promise<T> {
  const headers = new Headers(options?.headers)
  headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers })
  const raw = await res.text()
  let body: ApiBody<T> | null = null
  try {
    body = raw ? (JSON.parse(raw) as ApiBody<T>) : null
  } catch {
    throw new Error(raw ? `服务返回异常响应：${raw.slice(0, 120)}` : `请求失败（HTTP ${res.status}）`)
  }

  if (!body) {
    throw new Error(`请求失败（HTTP ${res.status}）`)
  }

  if (!res.ok || body.code !== 0) {
    throw new Error(body.message || `请求失败（HTTP ${res.status}）`)
  }
  return body.data
}

function formatAgo(timeString: string): string {
  const ms = Date.now() - new Date(timeString).getTime()
  if (ms < 60_000) return '刚刚'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`
  return `${Math.floor(ms / 3_600_000)} 小时前`
}

function formatDateTime(timeString: string): string {
  const dt = new Date(timeString)
  return `${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}`
}

function summarizeUA(ua?: string): string {
	if (!ua) return '-'
	const s = ua.toLowerCase()
	let browser = 'Other'
	if (s.includes('edg/')) browser = 'Edge'
	else if (s.includes('chrome/')) browser = 'Chrome'
	else if (s.includes('safari/') && !s.includes('chrome/')) browser = 'Safari'
	else if (s.includes('firefox/')) browser = 'Firefox'

	let os = 'Other'
	if (s.includes('windows')) os = 'Windows'
	else if (s.includes('android')) os = 'Android'
	else if (s.includes('iphone') || s.includes('ipad') || s.includes('ios')) os = 'iOS'
	else if (s.includes('mac os')) os = 'macOS'
	else if (s.includes('linux')) os = 'Linux'

	const device = s.includes('mobile') ? 'Mobile' : 'Desktop'
	return `${browser} / ${os} / ${device}`
}

function toVisitURL(endpoint: string): string {
  const val = endpoint.trim()
  if (val.startsWith('http://') || val.startsWith('https://')) {
    return val
  }
  return `https://${val}`
}

function buildUptimeBlocks(results: CheckResult[]): UptimeBlock[] {
  const now = new Date()
  const latestInHour = new Map<number, CheckResult>()

  // 按小时保留最新检测结果，用于生成全天在线状态条。
  for (const row of results) {
    const dt = new Date(row.checked_at)
    const hourKey = Math.floor(dt.getTime() / 3_600_000)
    const prev = latestInHour.get(hourKey)
    if (!prev || new Date(row.checked_at).getTime() > new Date(prev.checked_at).getTime()) {
      latestInHour.set(hourKey, row)
    }
  }

  const blocks: UptimeBlock[] = []
  for (let i = 23; i >= 0; i -= 1) {
    const slot = new Date(now.getTime() - i * 3_600_000)
    const key = Math.floor(slot.getTime() / 3_600_000)
    const row = latestInHour.get(key)
    if (!row) {
      blocks.push({ label: `${slot.getHours()}:00`, status: 'unknown', latency: null })
      continue
    }
    blocks.push({
      label: `${slot.getHours()}:00`,
      status: row.success ? 'up' : 'down',
      latency: row.latency_ms > 0 ? row.latency_ms : null,
    })
  }
  return blocks
}

function buildChartSeries(results: CheckResult[]) {
  const rows = [...results].sort((a, b) => new Date(a.checked_at).getTime() - new Date(b.checked_at).getTime())
  const times: string[] = []
  const latency: Array<number | null> = []
  const availability: number[] = []

  let successCount = 0
  rows.forEach((row, index) => {
    if (row.success) successCount += 1
    times.push(new Date(row.checked_at).toLocaleTimeString())
    latency.push(row.success && row.latency_ms > 0 ? row.latency_ms : null)
    availability.push(Number(((successCount / (index + 1)) * 100).toFixed(2)))
  })

  return { rows, times, latency, availability }
}

function getTrackingStatusInfo(target: Target, tracking?: TrackingSummary): TrackingStatusInfo {
	if (!target.enabled) return { label: '已停用', variant: 'paused' }
	if (!tracking?.has_data || !tracking.last_event_at) return { label: '未上报', variant: 'degraded' }

	const cfg = readTrackingConfig(target.config_json)
	const last = new Date(tracking.last_event_at).getTime()
	if (!Number.isFinite(last)) return { label: '未上报', variant: 'degraded' }
	if (cfg.inactive_threshold_min > 0 && Date.now() - last > cfg.inactive_threshold_min * 60 * 1000) return { label: '失活', variant: 'down' }

	return { label: '活跃', variant: 'ok' }
}

function getCardState(target: Target, rows: CheckResult[], tracking?: TrackingSummary): CardState {
  if (!target.enabled) return 'paused'

	if (target.type === 'tracking') {
		const status = getTrackingStatusInfo(target, tracking)
		if (status.variant === 'ok') return 'normal'
		if (status.variant === 'paused') return 'paused'
		if (status.variant === 'degraded') return 'degraded'
		return 'down'
	}

  const latest = rows[0]
  if (latest && !latest.success) return 'down'

  const since = Date.now() - 24 * 60 * 60 * 1000
  const hasFailureIn24h = rows.some((row) => !row.success && new Date(row.checked_at).getTime() >= since)
  if (hasFailureIn24h) return 'degraded'

  return 'normal'
}

function cardStateLabel(state: CardState): string {
  switch (state) {
    case 'paused':
      return '已停用'
    case 'down':
      return '故障中'
    case 'degraded':
      return '24h 有故障'
    default:
      return '正常'
  }
}

function getTypeLabel(value: string): string {
	const found = TYPE_OPTIONS.find((item) => item.value === value)
	return found?.label ?? value
}

function readAPIKey(configJSON?: string): string {
	if (!configJSON) return ''
	try {
		const parsed = JSON.parse(configJSON) as { api_key?: string }
		return parsed.api_key ?? ''
	} catch {
		return ''
	}
}

function readTrackingConfig(configJSON?: string): TrackingConfig {
	const defaults: TrackingConfig = {
		write_key: '',
		metric_mode: 'both',
		uv_identity: 'client_id',
		inactive_threshold_min: 0,
		user_group_mode: 'ip_device',
	}
	if (!configJSON) {
		return defaults
	}
	try {
		const parsed = JSON.parse(configJSON) as {
			write_key?: string
			metric_mode?: string
			uv_identity?: string
			inactive_threshold_min?: number
			user_group_mode?: string
		}
		const metric_mode: TrackingMetricMode =
			parsed.metric_mode === 'pv' || parsed.metric_mode === 'uv' || parsed.metric_mode === 'both'
				? parsed.metric_mode
				: 'both'
		const uv_identity: UVIdentity =
			parsed.uv_identity === 'client_id' || parsed.uv_identity === 'ip_ua_hash' || parsed.uv_identity === 'ip_client_hash'
				? parsed.uv_identity
				: 'client_id'
		const inactive_threshold_min =
			typeof parsed.inactive_threshold_min === 'number' && Number.isFinite(parsed.inactive_threshold_min) && parsed.inactive_threshold_min >= 0
				? Math.round(parsed.inactive_threshold_min)
				: 0
		const user_group_mode: UserGroupMode =
			parsed.user_group_mode === 'ip' || parsed.user_group_mode === 'device_id' || parsed.user_group_mode === 'ip_device'
				? parsed.user_group_mode
				: 'ip_device'
		return {
			write_key: parsed.write_key ?? '',
			metric_mode,
			uv_identity,
			inactive_threshold_min,
			user_group_mode,
		}
	} catch {
		return defaults
	}
}

function generateWriteKey(): string {
	return `trk_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2, 8)}`
}

function buildTrackingSnippet(writeKey: string, publicOrigin: string): string {
	return `(() => {
  const API_BASE = '${publicOrigin}'
  const WRITE_KEY = '${writeKey}'

  function getClientId() {
    const key = 'ym_monitor_cid'
    const old = localStorage.getItem(key)
    if (old) return old
    const id = 'cid_' + Math.random().toString(36).slice(2, 10)
    localStorage.setItem(key, id)
    return id
  }

  function track(eventName, meta = {}) {
    const payload = {
      event_name: eventName,
      page: location.pathname,
      client_id: getClientId(),
      occurred_at: Date.now(),
      meta,
    }
    const url = API_BASE + '/api/ingest/' + WRITE_KEY
    const body = JSON.stringify(payload)
    const blob = new Blob([body], { type: 'application/json' })
    if (navigator.sendBeacon && navigator.sendBeacon(url, blob)) return
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  }

  track('page_view', { title: document.title })
  window.ymTrack = track
})()`
}

function buildTrackingScriptTagSnippet(writeKey: string, publicOrigin: string): string {
	return `<script defer src="${publicOrigin}/sdk/ym-track.min.js" data-write-key="${writeKey}"></script>`
}

function buildTrackingManualSnippet(writeKey: string, publicOrigin: string): string {
	return `fetch('${publicOrigin}/api/ingest/${writeKey}', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    event_name: 'button_click',
    page: location.pathname,
    client_id: localStorage.getItem('ym_monitor_cid') || 'cid_demo',
    occurred_at: Date.now(),
    meta: { btn: 'buy_now' }
  }),
  keepalive: true,
})`
}

function presetToHours(preset: '1h' | '6h' | '12h' | '24h' | 'custom'): number {
	if (preset === '1h') return 1
	if (preset === '6h') return 6
	if (preset === '12h') return 12
	return 24
}

function isRouteNotFoundError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err)
	return msg.includes('404')
}

function formatMinuteTime(date: Date | null): string {
  if (!date) return '请选择时间'
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function DashboardPage({
  token,
  theme,
  setTheme,
  onLogout,
}: {
  token: string
  theme: ThemeMode
  setTheme: (theme: ThemeMode) => void
  onLogout: () => void
}) {
  const navigate = useNavigate()
  const [targets, setTargets] = useState<Target[]>([])
  const [resultMap, setResultMap] = useState<Record<number, CheckResult[]>>({})
  const [financeMap, setFinanceMap] = useState<Record<number, FinanceSummary>>({})
  const [trackingMap, setTrackingMap] = useState<Record<number, TrackingSummary>>({})
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [checkingMap, setCheckingMap] = useState<Record<number, boolean>>({})
  const [disablingMap, setDisablingMap] = useState<Record<number, boolean>>({})
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [onlyAbnormal, setOnlyAbnormal] = useState(false)
  const [createType, setCreateType] = useState('http')
  const [createAPIKey, setCreateAPIKey] = useState('')
  const [createMetricMode, setCreateMetricMode] = useState<TrackingMetricMode>('both')
  const [createUVIdentity, setCreateUVIdentity] = useState<UVIdentity>('client_id')
  const [createInactiveThreshold, setCreateInactiveThreshold] = useState(0)
  const [createWriteKey, setCreateWriteKey] = useState(() => generateWriteKey())

  async function loadDashboard() {
    setError('')
    try {
      const targetsData = await api<Target[]>('/api/targets', undefined, token)
      setTargets(targetsData)

      const resultEntries = await Promise.all(
        targetsData.map(async (target) => {
          const rows = await api<CheckResult[]>(`/api/targets/${target.id}/results?limit=240`, undefined, token)
          return [target.id, rows] as const
        }),
      )
      setResultMap(Object.fromEntries(resultEntries))

	  const aiTargets = targetsData.filter((target) => target.type === 'ai' || target.type === 'api')
	  const financeEntries = await Promise.all(
		  aiTargets.map(async (target) => {
			  const summary = await api<FinanceSummary>(`/api/targets/${target.id}/finance`, undefined, token)
			  return [target.id, summary] as const
		  }),
	  )
	  setFinanceMap(Object.fromEntries(financeEntries))

	  const trackingTargets = targetsData.filter((target) => target.type === 'tracking')
	  const trackingEntries = await Promise.all(
		  trackingTargets.map(async (target) => {
			  try {
				const summary = await api<TrackingSummary>(`/api/targets/${target.id}/tracking/summary?hours=24`, undefined, token)
				return [target.id, summary] as const
			  } catch (err) {
				if (isRouteNotFoundError(err)) {
				  return [target.id, { has_data: false }] as const
				}
				throw err
			  }
		  }),
	  )
	  setTrackingMap(Object.fromEntries(trackingEntries))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    void loadDashboard()
  }, [])

  async function handleCheckNow(id: number) {
    setCheckingMap((prev) => ({ ...prev, [id]: true }))
    try {
      await api(`/api/targets/${id}/check-now`, { method: 'POST' }, token)
      await loadDashboard()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCheckingMap((prev) => ({ ...prev, [id]: false }))
    }
  }

  async function handleCreateTarget(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formEl = e.currentTarget
    const form = new FormData(formEl)
    const payload: CreateTargetPayload = {
      name: String(form.get('name') ?? ''),
      type: createType,
      endpoint: createType === 'tracking' ? 'tracking://ingest' : String(form.get('endpoint') ?? ''),
      interval_sec: createType === 'tracking' ? 60 : Number(form.get('interval_sec') ?? 60),
      timeout_ms: createType === 'tracking' ? 5000 : Number(form.get('timeout_ms') ?? 5000),
      enabled: true,
      config_json: (createType === 'ai' || createType === 'api')
		? JSON.stringify({ api_key: createAPIKey.trim() })
		: (createType === 'tracking'
			? JSON.stringify({
				write_key: createWriteKey,
				metric_mode: createMetricMode,
				uv_identity: createUVIdentity,
				user_group_mode: 'ip_device',
				inactive_threshold_min: createInactiveThreshold,
			})
			: '{}'),
    }

	if ((createType === 'ai' || createType === 'api') && !createAPIKey.trim()) {
		setError('AI中转站/AI官方类型必须填写 API Key')
		return
	}
	if (createType === 'tracking' && !createWriteKey.trim()) {
		setError('埋点类型必须填写 write key')
		return
	}
	if (createType !== 'tracking' && !String(form.get('endpoint') ?? '').trim()) {
		setError('该类型必须填写地址')
		return
	}

    setCreating(true)
    try {
      await api('/api/targets', { method: 'POST', body: JSON.stringify(payload) }, token)
      formEl.reset()
      setCreateType('http')
	  setCreateAPIKey('')
	  setCreateMetricMode('both')
	  setCreateUVIdentity('client_id')
	  setCreateInactiveThreshold(0)
	  setCreateWriteKey(generateWriteKey())
      await loadDashboard()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  async function handleToggleTarget(target: Target) {
    setDisablingMap((prev) => ({ ...prev, [target.id]: true }))
    try {
      await api(`/api/targets/${target.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...target,
          enabled: !target.enabled,
          config_json: target.config_json ?? '{}',
        }),
      }, token)
      await loadDashboard()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDisablingMap((prev) => ({ ...prev, [target.id]: false }))
    }
  }

  const filteredTargets = useMemo(() => {
    return targets.filter((item) => {
      const hitKeyword = !search.trim() || `${item.name} ${item.endpoint}`.toLowerCase().includes(search.toLowerCase())
      const hitType = typeFilter === 'all' || item.type === typeFilter
      const state = getCardState(item, resultMap[item.id] ?? [], trackingMap[item.id])
      const hitAbnormal = !onlyAbnormal || state === 'down' || state === 'degraded'
      return hitKeyword && hitType && hitAbnormal
    })
  }, [targets, search, typeFilter, onlyAbnormal, resultMap, trackingMap])

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div>
          <p className="muted">源梦监控</p>
          <h1>监控工作台</h1>
        </div>
        <div className="header-actions">
          <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '白天模式' : '黑夜模式'}
          </button>
          <button type="button" onClick={() => void loadDashboard()}>刷新</button>
          <button type="button" onClick={onLogout}>退出登录</button>
        </div>
      </header>

      {error ? <p className="error panel">{error}</p> : null}

      <section className="panel toolbar">
        <input
          aria-label="搜索目标"
          placeholder="搜索目标名称或地址"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="type-chips" role="tablist" aria-label="类型筛选">
          {TYPE_OPTIONS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`chip ${typeFilter === item.value ? 'active' : ''}`}
              onClick={() => setTypeFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            className={`chip ${onlyAbnormal ? 'active danger' : ''}`}
            onClick={() => setOnlyAbnormal((prev) => !prev)}
          >
            仅异常
          </button>
        </div>
      </section>

      <section className="main-grid">
        <article className="panel create-panel">
          <div className="panel-head">
            <h3>新增监控</h3>
            <span>按需添加目标</span>
          </div>
          <form className="target-form" onSubmit={handleCreateTarget}>
            <label>
              名称
              <input name="name" placeholder="例如：主站健康检查" required />
            </label>
            <label>
              类型
              <div className="type-chips" role="radiogroup" aria-label="创建目标类型">
                {CREATE_TYPE_OPTIONS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={`chip ${createType === item.value ? 'active' : ''}`}
                    onClick={() => {
					  setCreateType(item.value)
					  if (item.value === 'tracking') {
						  setCreateWriteKey(generateWriteKey())
					  }
					}}
                    aria-pressed={createType === item.value}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </label>
			{createType !== 'tracking' ? (
			  <label>
				地址
				<input name="endpoint" placeholder="https://example.com/health 或 1.2.3.4:443" required />
			  </label>
			) : null}
			{createType === 'ai' || createType === 'api' ? (
			  <label>
				API Key
				<input
				  value={createAPIKey}
				  onChange={(e) => setCreateAPIKey(e.target.value)}
				  placeholder="请输入 API Key"
				  type="password"
				  required
				/>
			  </label>
			) : null}
			{createType === 'tracking' ? (
			  <>
				<label>
				  Write Key
				  <div className="inline-input-row">
					<input
					  value={createWriteKey}
					  onChange={(e) => setCreateWriteKey(e.target.value)}
					  placeholder="埋点写入密钥"
					  required
					/>
					<button type="button" onClick={() => setCreateWriteKey(generateWriteKey())}>重置</button>
				  </div>
				</label>
				<label>
				  统计维度
				  <div className="type-chips">
					{[
					  { value: 'pv', label: '仅PV' },
					  { value: 'uv', label: '仅UV' },
					  { value: 'both', label: 'PV+UV' },
					].map((item) => (
					  <button
						key={item.value}
						type="button"
						className={`chip ${createMetricMode === item.value ? 'active' : ''}`}
						onClick={() => setCreateMetricMode(item.value as 'pv' | 'uv' | 'both')}
					  >
						{item.label}
					  </button>
					))}
				  </div>
				</label>
				<label>
				  UV去重方式
				  <div className="type-chips">
					{[
					  { value: 'client_id', label: 'client_id' },
					  { value: 'ip_ua_hash', label: 'ip_ua_hash' },
					  { value: 'ip_client_hash', label: 'ip+client_id' },
					].map((item) => (
					  <button
						key={item.value}
						type="button"
						className={`chip ${createUVIdentity === item.value ? 'active' : ''}`}
						onClick={() => setCreateUVIdentity(item.value as UVIdentity)}
					  >
						{item.label}
					  </button>
					))}
				  </div>
				</label>
				<label>
				  超过多久无上报判定失活(分钟)
				  <input
					type="number"
					min={0}
					value={createInactiveThreshold}
					onChange={(e) => setCreateInactiveThreshold(Math.max(0, Number(e.target.value) || 0))}
					required
				  />
				</label>
			  </>
			) : null}
			{createType !== 'tracking' ? (
			  <div className="form-row">
				<label>
				  间隔(秒)
				  <input name="interval_sec" type="number" defaultValue={60} min={10} required />
				</label>
				<label>
				  超时(ms)
				  <input name="timeout_ms" type="number" defaultValue={5000} min={200} required />
				</label>
			  </div>
			) : null}
            <button className="primary" type="submit" disabled={creating}>
              {creating ? '创建中...' : '创建目标'}
            </button>
          </form>
        </article>

        <div className="card-grid">
          {filteredTargets.map((target) => {
            const rows = resultMap[target.id] ?? []
            const finance = financeMap[target.id]
            const tracking = trackingMap[target.id]
            const trackingStatus = target.type === 'tracking' ? getTrackingStatusInfo(target, tracking) : null
            const latest = rows[0]
            const state = getCardState(target, rows, tracking)
            const successRows = rows.filter((x) => x.success)
            const uptime = rows.length > 0 ? (successRows.length / rows.length) * 100 : 0
            const avgLatency = successRows.length > 0
              ? Math.round(successRows.reduce((sum, x) => sum + x.latency_ms, 0) / successRows.length)
              : 0
            const blocks = buildUptimeBlocks(rows)

            return (
              <article
                className={`panel monitor-card clickable state-${state}`}
                key={target.id}
                onClick={() => navigate(`/targets/${target.id}`)}
              >
                <div className="card-head">
                  <div>
                    <h3>{target.name}</h3>
					{target.type !== 'tracking' ? (
					  <a
						className="endpoint-link"
						href={toVisitURL(target.endpoint)}
						target="_blank"
						rel="noreferrer"
						onClick={(event) => event.stopPropagation()}
						title="打开目标地址"
					  >
						{target.endpoint}
					  </a>
					) : (
					  <p className="muted">被动上报</p>
					)}
                  </div>
                  <div className="card-head-actions">
					{target.type !== 'tracking' ? (
					  <button
						type="button"
						className="icon-button"
						onClick={(event) => {
						  event.stopPropagation()
						  void handleCheckNow(target.id)
						}}
						title="手动检测"
						aria-label={`手动检测 ${target.name}`}
						disabled={Boolean(checkingMap[target.id]) || !target.enabled}
					  >
						<RefreshCcw className={checkingMap[target.id] ? 'spinning' : ''} size={16} />
					  </button>
					) : null}
                    <button
                      type="button"
                      className={`icon-button ${target.enabled ? 'danger' : ''}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        void handleToggleTarget(target)
                      }}
                      title={target.enabled ? '停用该目标' : '恢复该目标'}
                      aria-label={`${target.enabled ? '停用' : '恢复'} ${target.name}`}
                      disabled={Boolean(disablingMap[target.id])}
                    >
                      {target.enabled ? (
                        <PauseCircle className={disablingMap[target.id] ? 'spinning' : ''} size={16} />
                      ) : (
                        <PlayCircle className={disablingMap[target.id] ? 'spinning' : ''} size={16} />
                      )}
                    </button>
					{target.type === 'tracking' && trackingStatus ? (
					  <span className={`status ${trackingStatus.variant}`}>
						{trackingStatus.label}
					  </span>
					) : (
					  <span className={`status ${state === 'paused' ? 'paused' : state === 'down' ? 'down' : state === 'degraded' ? 'degraded' : 'ok'}`}>
						{cardStateLabel(state)}
					  </span>
					)}
                  </div>
                </div>

				{target.type === 'tracking' ? (
				  <div className="metrics">
					<div>
					  <p className="muted">PV(24h)</p>
					  <strong>{tracking?.has_data ? String(tracking.pv ?? 0) : '--'}</strong>
					</div>
					<div>
					  <p className="muted">UV(24h)</p>
					  <strong>{tracking?.has_data ? String(tracking.uv ?? 0) : '--'}</strong>
					</div>
					<div>
					  <p className="muted">最后上报</p>
					  <strong>{tracking?.last_event_at ? formatAgo(tracking.last_event_at) : '--'}</strong>
					</div>
				  </div>
				) : (
				  <div className="metrics">
					<div>
					  <p className="muted">当前延迟</p>
					  <strong>{latest?.latency_ms ? `${latest.latency_ms}ms` : '--'}</strong>
					</div>
					<div>
					  <p className="muted">24h 可用率</p>
					  <strong>{rows.length > 0 ? `${uptime.toFixed(1)}%` : '--'}</strong>
					</div>
					<div>
					  <p className="muted">平均延迟</p>
					  <strong>{avgLatency > 0 ? `${avgLatency}ms` : '--'}</strong>
					</div>
				  </div>
				)}

				{target.type === 'ai' || target.type === 'api' ? (
				  <div className="metrics finance-metrics">
					<div>
					  <p className="muted">余额</p>
					  <strong>{finance?.has_data ? `${(finance.balance ?? 0).toFixed(2)} ${finance.currency ?? 'USD'}` : '--'}</strong>
					</div>
					<div>
					  <p className="muted">24h 消耗</p>
					  <strong>{finance?.has_data ? `${(finance.daily_spent ?? 0).toFixed(2)} ${finance.currency ?? 'USD'}` : '--'}</strong>
					</div>
				  </div>
				) : null}

				{target.type !== 'tracking' ? (
				<div className="uptime-wrap">
				  <p className="muted">全天在线情况</p>
				  <div className="uptime-bar" aria-label="全天在线状态条">
                    {blocks.map((block, idx) => (
                      <span
                        className={`uptime-block ${block.status}`}
                        key={`${target.id}-${idx}`}
                        title={`${block.label} ${block.status === 'up' ? '在线' : block.status === 'down' ? '异常' : '未知'}${block.latency ? ` / ${block.latency}ms` : ''}`}
                      />
                    ))}
				  </div>
				</div>
				) : (
				  <p className="muted">最近事件：{tracking?.last_event_name || '-'}</p>
				)}

                <div className="card-actions">
				  <span className="muted">
					{target.type === 'tracking'
					  ? `最后上报：${tracking?.last_event_at ? formatAgo(tracking.last_event_at) : '暂无'}`
					  : `最后检测：${latest ? formatAgo(latest.checked_at) : '暂无'}`}
				  </span>
                </div>
              </article>
            )
          })}
        </div>
      </section>

    </div>
  )
}

function TargetDetailPage({ token }: { token: string }) {
  const navigate = useNavigate()
  const params = useParams()
  const id = Number(params.id)

  const [target, setTarget] = useState<Target | null>(null)
  const [results, setResults] = useState<CheckResult[]>([])
  const [finance, setFinance] = useState<FinanceSummary | null>(null)
  const [trackingSummary, setTrackingSummary] = useState<TrackingSummary | null>(null)
  const [trackingEvents, setTrackingEvents] = useState<TrackingEvent[]>([])
  const [trackingSeries, setTrackingSeries] = useState<TrackingSeriesPoint[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [onlyAbnormal, setOnlyAbnormal] = useState(false)
  const [logSearch, setLogSearch] = useState('')
  const [visibleLogs, setVisibleLogs] = useState(10)
  const [rangePreset, setRangePreset] = useState<'1h' | '6h' | '12h' | '24h' | 'custom'>('24h')
  const [customStart, setCustomStart] = useState<Date | null>(new Date(Date.now() - 24 * 60 * 60 * 1000))
  const [customEnd, setCustomEnd] = useState<Date | null>(new Date())
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [copyDone, setCopyDone] = useState(false)
  const [testingIngest, setTestingIngest] = useState(false)
  const [guideMode, setGuideMode] = useState<'script' | 'inline' | 'manual'>('script')
  const [userRankSort, setUserRankSort] = useState<'pv' | 'uv' | 'events' | 'recent'>('pv')
  const [deviceRankSort, setDeviceRankSort] = useState<'pv' | 'uv' | 'events' | 'recent'>('pv')
  const [userRankSearch, setUserRankSearch] = useState('')
  const [deviceRankSearch, setDeviceRankSearch] = useState('')
  const startPickerRef = useRef<any>(null)
  const endPickerRef = useRef<any>(null)

  const pickerOptions = useMemo(() => ({
    locale: Mandarin,
    enableTime: true,
    time_24hr: true,
    minuteIncrement: 1,
    dateFormat: 'Y-m-d H:i',
    monthSelectorType: 'static' as const,
    disableMobile: true,
  }), [])
  const [editForm, setEditForm] = useState({
    name: '',
    type: 'http',
    endpoint: '',
    interval_sec: 60,
    timeout_ms: 5000,
    enabled: true,
    api_key: '',
	write_key: '',
	metric_mode: 'both' as TrackingMetricMode,
	uv_identity: 'client_id' as UVIdentity,
	user_group_mode: 'ip_device' as UserGroupMode,
	inactive_threshold_min: 0,
  })

  async function loadDetail() {
    if (!Number.isFinite(id) || id <= 0) return
    setLoading(true)
    setError('')
    try {
      const [targetData, rows] = await Promise.all([
        api<Target>(`/api/targets/${id}`, undefined, token),
        api<CheckResult[]>(`/api/targets/${id}/results?limit=240`, undefined, token),
      ])
      setTarget(targetData)
      setEditForm({
        name: targetData.name,
        type: targetData.type,
        endpoint: targetData.endpoint,
        interval_sec: targetData.interval_sec,
        timeout_ms: targetData.timeout_ms,
        enabled: targetData.enabled,
        api_key: readAPIKey(targetData.config_json),
		...readTrackingConfig(targetData.config_json),
      })
      setResults(rows)
	  if (targetData.type === 'ai' || targetData.type === 'api') {
		const financeSummary = await api<FinanceSummary>(`/api/targets/${id}/finance`, undefined, token)
		setFinance(financeSummary)
		setTrackingSummary(null)
		setTrackingEvents([])
		setTrackingSeries([])
	  } else if (targetData.type === 'tracking') {
		const [summary, events, series] = await Promise.all([
			api<TrackingSummary>(`/api/targets/${id}/tracking/summary?hours=24`, undefined, token).catch((err) => {
			  if (isRouteNotFoundError(err)) return { has_data: false }
			  throw err
			}),
			api<TrackingEvent[]>(`/api/targets/${id}/tracking/events?limit=500&hours=${presetToHours(rangePreset)}`, undefined, token).catch((err) => {
			  if (isRouteNotFoundError(err)) return []
			  throw err
			}),
			api<TrackingSeriesPoint[]>(`/api/targets/${id}/tracking/series?hours=${presetToHours(rangePreset)}`, undefined, token).catch((err) => {
			  if (isRouteNotFoundError(err)) return []
			  throw err
			}),
		])
		setTrackingSummary(summary)
		setTrackingEvents(events)
		setTrackingSeries(series)
		setFinance(null)
	  } else {
		setFinance(null)
		setTrackingSummary(null)
		setTrackingEvents([])
		setTrackingSeries([])
	  }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadDetail()
  }, [id])

  useEffect(() => {
	if (!Number.isFinite(id) || id <= 0) return
	if (target?.type !== 'tracking') return
	if (rangePreset === 'custom') return
	void Promise.all([
	  api<TrackingSeriesPoint[]>(`/api/targets/${id}/tracking/series?hours=${presetToHours(rangePreset)}`, undefined, token),
	  api<TrackingEvent[]>(`/api/targets/${id}/tracking/events?limit=500&hours=${presetToHours(rangePreset)}`, undefined, token),
	])
	  .then(([seriesRows, eventRows]) => {
		setTrackingSeries(seriesRows)
		setTrackingEvents(eventRows)
	  })
	  .catch((err) => {
		if (isRouteNotFoundError(err)) {
		  setTrackingSeries([])
		  setTrackingEvents([])
		  return
		}
		setError((err as Error).message)
	  })
  }, [id, target?.type, rangePreset, token])

  async function handleCheckNow() {
    if (!Number.isFinite(id) || id <= 0) return
    setChecking(true)
    try {
      await api(`/api/targets/${id}/check-now`, { method: 'POST' }, token)
      await loadDetail()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  async function handleSaveConfig(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!Number.isFinite(id) || id <= 0) return
	if ((editForm.type === 'ai' || editForm.type === 'api') && !editForm.api_key.trim()) {
		setError('AI中转站/AI官方类型必须填写 API Key')
		return
	}
	if (editForm.type === 'tracking' && !editForm.write_key.trim()) {
		setError('埋点类型必须填写 write key')
		return
	}
    setSaving(true)
    try {
	  const payload = {
		...editForm,
		endpoint: editForm.type === 'tracking' ? 'tracking://ingest' : editForm.endpoint,
		interval_sec: editForm.type === 'tracking' ? 60 : editForm.interval_sec,
		timeout_ms: editForm.type === 'tracking' ? 5000 : editForm.timeout_ms,
		config_json: (editForm.type === 'ai' || editForm.type === 'api')
		  ? JSON.stringify({ api_key: editForm.api_key.trim() })
		  : (editForm.type === 'tracking'
			  ? JSON.stringify({
				  write_key: editForm.write_key.trim(),
				  metric_mode: editForm.metric_mode,
				  uv_identity: editForm.uv_identity,
				  user_group_mode: editForm.user_group_mode,
				  inactive_threshold_min: editForm.inactive_threshold_min,
			  })
			  : '{}'),
	  }
      await api(`/api/targets/${id}`, {
        method: 'PUT',
		body: JSON.stringify(payload),
      }, token)
      setEditing(false)
      await loadDetail()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteTarget() {
    if (!Number.isFinite(id) || id <= 0) return
    setDeleting(true)
    try {
      await api(`/api/targets/${id}`, { method: 'DELETE' }, token)
      navigate('/')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const latest = results[0]
  const rangeWindow = useMemo(() => {
    const endTs = rangePreset === 'custom' ? (customEnd ? customEnd.getTime() : NaN) : Date.now()
    const startTs = (() => {
      if (rangePreset === 'custom') return customStart ? customStart.getTime() : NaN
      if (rangePreset === '1h') return Date.now() - 1 * 60 * 60 * 1000
      if (rangePreset === '6h') return Date.now() - 6 * 60 * 60 * 1000
      if (rangePreset === '12h') return Date.now() - 12 * 60 * 60 * 1000
      return Date.now() - 24 * 60 * 60 * 1000
    })()
    return { startTs, endTs }
  }, [rangePreset, customStart, customEnd])

  const rangeInvalid = !Number.isFinite(rangeWindow.startTs)
    || !Number.isFinite(rangeWindow.endTs)
    || rangeWindow.startTs > rangeWindow.endTs

  const windowedResults = useMemo(() => {
    if (rangeInvalid) return []
    return results.filter((row) => {
      const ts = new Date(row.checked_at).getTime()
      return ts >= rangeWindow.startTs && ts <= rangeWindow.endTs
    })
  }, [results, rangeWindow, rangeInvalid])

  const windowedTrackingEvents = useMemo(() => {
	if (rangeInvalid) return []
	return trackingEvents.filter((row) => {
		const ts = new Date(row.occurred_at).getTime()
		return ts >= rangeWindow.startTs && ts <= rangeWindow.endTs
	})
  }, [trackingEvents, rangeWindow, rangeInvalid])

  const successRows = useMemo(() => windowedResults.filter((row) => row.success), [windowedResults])
  const failureRows = useMemo(() => windowedResults.filter((row) => !row.success), [windowedResults])
  const uptime = windowedResults.length > 0 ? (successRows.length / windowedResults.length) * 100 : 0
  const avgLatency = successRows.length > 0
    ? Math.round(successRows.reduce((sum, row) => sum + row.latency_ms, 0) / successRows.length)
    : 0
  const chartSeries = useMemo(() => buildChartSeries(windowedResults), [windowedResults])

  const trackingChart = useMemo(() => {
	if (rangePreset !== 'custom' && trackingSeries.length > 0) {
		const times = trackingSeries.map((item) => new Date(item.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
		return {
			times,
			pv: trackingSeries.map((item) => item.pv),
			uv: trackingSeries.map((item) => item.uv),
		}
	}
	const buckets = new Map<string, { pv: number; uv: Set<string> }>()
	windowedTrackingEvents.forEach((item) => {
		const key = new Date(item.occurred_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		if (!buckets.has(key)) buckets.set(key, { pv: 0, uv: new Set<string>() })
		const cur = buckets.get(key)!
		cur.pv += item.count
		if (item.uv_key) cur.uv.add(item.uv_key)
	})
	const times = Array.from(buckets.keys())
	const pv = times.map((t) => buckets.get(t)?.pv ?? 0)
	const uv = times.map((t) => buckets.get(t)?.uv.size ?? 0)
	return { times, pv, uv }
  }, [windowedTrackingEvents, rangePreset, trackingSeries])

  const isTrackingTarget = target?.type === 'tracking'
  const trackingConfig = useMemo(() => readTrackingConfig(target?.config_json), [target?.config_json])
  const guidePublicOrigin = useMemo(() => {
	if (typeof window !== 'undefined' && window.location?.origin) {
	  return window.location.origin
	}
	return API_BASE
  }, [])
  const trackingSnippet = useMemo(() => buildTrackingSnippet(trackingConfig.write_key, guidePublicOrigin), [trackingConfig.write_key, guidePublicOrigin])
  const trackingScriptTagSnippet = useMemo(() => buildTrackingScriptTagSnippet(trackingConfig.write_key, guidePublicOrigin), [trackingConfig.write_key, guidePublicOrigin])
  const trackingManualSnippet = useMemo(() => buildTrackingManualSnippet(trackingConfig.write_key, guidePublicOrigin), [trackingConfig.write_key, guidePublicOrigin])
  const guideCode = useMemo(() => {
	if (guideMode === 'inline') return trackingSnippet
	if (guideMode === 'manual') return trackingManualSnippet
	return trackingScriptTagSnippet
  }, [guideMode, trackingManualSnippet, trackingScriptTagSnippet, trackingSnippet])
  const guideRows = guideMode === 'script' ? 3 : (guideMode === 'manual' ? 12 : 18)

  async function handleCopyTrackingSnippet() {
	if (!trackingConfig.write_key) return
	try {
	  await navigator.clipboard.writeText(guideCode)
	  setCopyDone(true)
	  setTimeout(() => setCopyDone(false), 1500)
	} catch {
	  setError('复制失败，请手动复制下方代码')
	}
  }

  async function handleSendTestEvent() {
	if (!trackingConfig.write_key) {
	  setError('未找到 write key，请先在配置中填写')
	  return
	}
	setTestingIngest(true)
	try {
	  const payload = {
		event_name: 'test_event',
		page: '/test',
		count: 1,
		client_id: `debug_${Math.random().toString(36).slice(2, 8)}`,
		occurred_at: Date.now(),
		meta: { source: 'console_test' },
	  }
	  const res = await fetch(`${API_BASE}/api/ingest/${trackingConfig.write_key}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	  })
	  const raw = await res.text()
	  let body: ApiBody<{ accepted: number }> | null = null
	  try {
		body = raw ? (JSON.parse(raw) as ApiBody<{ accepted: number }>) : null
	  } catch {
		throw new Error(raw ? `发送测试事件失败：${raw.slice(0, 120)}` : `发送测试事件失败（HTTP ${res.status}）`)
	  }
	  if (!body || !res.ok || body.code !== 0) {
		throw new Error(body?.message || `发送测试事件失败（HTTP ${res.status}）`)
	  }
	  await loadDetail()
	} catch (err) {
	  setError((err as Error).message)
	} finally {
	  setTestingIngest(false)
	}
  }

  const latencyOption = useMemo(() => ({
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      backgroundColor: 'rgba(15,23,42,0.92)',
      borderColor: '#334155',
      textStyle: { color: '#e2e8f0' },
      formatter: (params: Array<{ dataIndex: number; axisValueLabel: string; data: number | null }>) => {
        const first = params[0]
        if (!first) return ''
		if (isTrackingTarget) {
			return `${first.axisValueLabel}<br/>PV: ${first.data ?? 0}`
		}
        const row = chartSeries.rows[first.dataIndex]
        if (!row) return first.axisValueLabel
        const status = row.success ? '在线' : '异常'
        const latency = row.latency_ms > 0 ? `${row.latency_ms}ms` : '--'
        return `${formatDateTime(row.checked_at)}<br/>状态: ${status}<br/>延迟: ${latency}<br/>错误: ${row.error_msg || '无'}`
      },
    },
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: {
      type: 'category',
      data: isTrackingTarget ? trackingChart.times : chartSeries.times,
      axisLabel: { color: '#94a3b8', fontSize: 11 },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    yAxis: {
      type: 'value',
      name: isTrackingTarget ? 'count' : 'ms',
      nameTextStyle: { color: '#94a3b8' },
      axisLabel: { color: '#94a3b8' },
      splitLine: { lineStyle: { color: 'rgba(100,116,139,0.2)' } },
    },
    series: [
      {
        name: isTrackingTarget ? 'PV' : '延迟',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: isTrackingTarget ? trackingChart.pv : chartSeries.latency,
        lineStyle: { color: '#3b82f6', width: 2 },
        itemStyle: { color: '#3b82f6' },
        areaStyle: { color: 'rgba(59,130,246,0.15)' },
      },
    ],
  }), [chartSeries, isTrackingTarget, trackingChart])

  const availabilityOption = useMemo(() => ({
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      backgroundColor: 'rgba(15,23,42,0.92)',
      borderColor: '#334155',
      textStyle: { color: '#e2e8f0' },
      formatter: (params: Array<{ dataIndex: number; axisValueLabel: string; data: number }>) => {
        const first = params[0]
        if (!first) return ''
		if (isTrackingTarget) {
			return `${first.axisValueLabel}<br/>UV: ${first.data}`
		}
        const row = chartSeries.rows[first.dataIndex]
        const status = row?.success ? '在线' : row ? '异常' : '未知'
        return `${first.axisValueLabel}<br/>可用率: ${first.data}%<br/>状态: ${status}`
      },
    },
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: {
      type: 'category',
      data: isTrackingTarget ? trackingChart.times : chartSeries.times,
      axisLabel: { color: '#94a3b8', fontSize: 11 },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: isTrackingTarget ? undefined : 100,
      name: isTrackingTarget ? 'count' : '%',
      nameTextStyle: { color: '#94a3b8' },
      axisLabel: { color: '#94a3b8' },
      splitLine: { lineStyle: { color: 'rgba(100,116,139,0.2)' } },
    },
    series: [
      {
        name: isTrackingTarget ? 'UV' : '可用率',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: isTrackingTarget ? trackingChart.uv : chartSeries.availability,
        lineStyle: { color: '#22c55e', width: 2 },
        itemStyle: { color: '#22c55e' },
        areaStyle: { color: 'rgba(34,197,94,0.12)' },
      },
    ],
  }), [chartSeries, isTrackingTarget, trackingChart])

  const filteredLogs = useMemo(() => {
    return windowedResults
      .filter((row) => (!onlyAbnormal || !row.success))
      .filter((row) => {
        const text = `${row.error_msg} ${formatDateTime(row.checked_at)} ${row.latency_ms}`.toLowerCase()
        return !logSearch.trim() || text.includes(logSearch.toLowerCase())
      })
  }, [windowedResults, onlyAbnormal, logSearch])

  const filteredTrackingLogs = useMemo(() => {
	return windowedTrackingEvents
	  .filter((row) => (!onlyAbnormal || row.event_name.toLowerCase().includes('error') || row.event_name.toLowerCase().includes('fail')))
	  .filter((row) => {
		const text = `${row.event_name} ${row.page} ${row.client_ip} ${row.geo_text} ${row.referer} ${row.user_agent} ${formatDateTime(row.occurred_at)}`.toLowerCase()
		return !logSearch.trim() || text.includes(logSearch.toLowerCase())
	  })
  }, [windowedTrackingEvents, onlyAbnormal, logSearch])

  const logsToShow = isTrackingTarget
	? filteredTrackingLogs.slice(0, visibleLogs)
	: filteredLogs.slice(0, visibleLogs)

  const userRanking = useMemo(() => {
	const bucket = new Map<string, {
		key: string
		pv: number
		uv: Set<string>
		events: number
		lastAt: number
		lastPage: string
		lastIP: string
		lastGeo: string
		lastDevice: string
	}>()
	for (const row of windowedTrackingEvents) {
		const key = row.client_ip || 'unknown_ip'
		const ts = new Date(row.occurred_at).getTime()
		if (!bucket.has(key)) {
			bucket.set(key, {
				key,
				pv: 0,
				uv: new Set<string>(),
				events: 0,
				lastAt: ts,
				lastPage: row.page || '-',
				lastIP: row.client_ip || '-',
				lastGeo: row.geo_text || '未知',
				lastDevice: summarizeUA(row.user_agent),
			})
		}
		const cur = bucket.get(key)!
		cur.pv += row.count
		cur.events += 1
		if (row.uv_key) cur.uv.add(row.uv_key)
		if (ts >= cur.lastAt) {
			cur.lastAt = ts
			cur.lastPage = row.page || '-'
			cur.lastIP = row.client_ip || '-'
			cur.lastGeo = row.geo_text || '未知'
			cur.lastDevice = summarizeUA(row.user_agent)
		}
	}
	const rows = Array.from(bucket.values()).map((item) => ({
		key: item.key,
		pv: item.pv,
		uv: item.uv.size,
		events: item.events,
		lastAt: item.lastAt,
		lastPage: item.lastPage,
		lastIP: item.lastIP,
		lastGeo: item.lastGeo,
		lastDevice: item.lastDevice,
	}))
	rows.sort((a, b) => {
		if (userRankSort === 'recent') return b.lastAt - a.lastAt
		if (userRankSort === 'uv') return b.uv - a.uv
		if (userRankSort === 'events') return b.events - a.events
		return b.pv - a.pv
	})
	return rows.slice(0, 20)
  }, [windowedTrackingEvents, userRankSort])

  const deviceRanking = useMemo(() => {
	const bucket = new Map<string, { device: string; pv: number; uv: Set<string>; events: number; lastAt: number }>()
	for (const row of windowedTrackingEvents) {
		const device = summarizeUA(row.user_agent)
		const ts = new Date(row.occurred_at).getTime()
		if (!bucket.has(device)) {
			bucket.set(device, { device, pv: 0, uv: new Set<string>(), events: 0, lastAt: ts })
		}
		const cur = bucket.get(device)!
		cur.pv += row.count
		cur.events += 1
		if (row.uv_key) cur.uv.add(row.uv_key)
		if (ts >= cur.lastAt) cur.lastAt = ts
	}
	const rows = Array.from(bucket.values()).map((item) => ({
		device: item.device,
		pv: item.pv,
		uv: item.uv.size,
		events: item.events,
		lastAt: item.lastAt,
	}))
	rows.sort((a, b) => {
		if (deviceRankSort === 'recent') return b.lastAt - a.lastAt
		if (deviceRankSort === 'events') return b.events - a.events
		if (deviceRankSort === 'uv') return b.uv - a.uv
		return b.pv - a.pv
	})
	return rows.slice(0, 20)
  }, [windowedTrackingEvents, deviceRankSort])

  if (!Number.isFinite(id) || id <= 0) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div>
          <button type="button" className="back-button" onClick={() => navigate('/')}>
            <ArrowLeft size={16} /> 返回
          </button>
          <h1 className="detail-title">{target?.name ?? '目标详情'}</h1>
          {target && target.type !== 'tracking' ? (
            <a
              className="endpoint-link"
              href={toVisitURL(target.endpoint)}
              target="_blank"
              rel="noreferrer"
              title="打开目标地址"
            >
              {target.endpoint}
            </a>
          ) : target ? (
            <p className="muted">被动上报（通过 write key 接入）</p>
          ) : (
            <p className="muted">加载中...</p>
          )}
        </div>
        <div className="header-actions">
          <button type="button" onClick={() => setEditing(true)}>
            <Pencil size={16} /> 编辑配置
          </button>
          <button type="button" onClick={() => void loadDetail()}>
            <RefreshCcw size={16} /> 刷新
          </button>
          <button type="button" className="danger-btn" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={16} /> 删除目标
          </button>
		  {target?.type !== 'tracking' ? (
			<button type="button" className="primary" onClick={() => void handleCheckNow()} disabled={checking || !target?.enabled}>
			  <RefreshCcw className={checking ? 'spinning' : ''} size={16} /> 手动检测
			</button>
		  ) : null}
        </div>
      </header>

      {error ? <p className="error panel">{error}</p> : null}

      <section className="kpi-grid">
        <article className="panel metric-card">
          <p className="panel-title"><ShieldCheck size={15} /> {isTrackingTarget ? '窗口PV' : '窗口可用率'}</p>
          <p className="panel-value">{loading ? '...' : (isTrackingTarget ? String(windowedTrackingEvents.reduce((sum, item) => sum + item.count, 0)) : `${uptime.toFixed(1)}%`)}</p>
        </article>
        <article className="panel metric-card">
          <p className="panel-title"><Gauge size={15} /> {isTrackingTarget ? '窗口UV' : '平均延迟'}</p>
          <p className="panel-value">{loading ? '...' : (isTrackingTarget ? String(new Set(windowedTrackingEvents.map((item) => item.uv_key).filter(Boolean)).size) : (avgLatency > 0 ? `${avgLatency}ms` : '--'))}</p>
        </article>
        <article className="panel metric-card">
          <p className="panel-title"><AlertTriangle size={15} /> {isTrackingTarget ? '事件条数' : '失败次数'}</p>
          <p className="panel-value">{loading ? '...' : (isTrackingTarget ? String(windowedTrackingEvents.length) : String(failureRows.length))}</p>
        </article>
        <article className="panel metric-card">
          <p className="panel-title"><Clock3 size={15} /> {isTrackingTarget ? '最后事件' : '最后检测'}</p>
          <p className="panel-value">{loading ? '...' : (isTrackingTarget ? (trackingSummary?.last_event_at ? formatAgo(trackingSummary.last_event_at) : '--') : (latest ? formatAgo(latest.checked_at) : '--'))}</p>
        </article>
		{target?.type === 'ai' || target?.type === 'api' ? (
		  <>
			<article className="panel metric-card">
			  <p className="panel-title"><ShieldCheck size={15} /> 余额</p>
			  <p className="panel-value">{loading ? '...' : (finance?.has_data ? `${(finance.balance ?? 0).toFixed(2)} ${finance.currency ?? 'USD'}` : '--')}</p>
			</article>
			<article className="panel metric-card">
			  <p className="panel-title"><Clock3 size={15} /> 24h 消耗</p>
			  <p className="panel-value">{loading ? '...' : (finance?.has_data ? `${(finance.daily_spent ?? 0).toFixed(2)} ${finance.currency ?? 'USD'}` : '--')}</p>
			</article>
		  </>
		) : null}
      </section>

      <section className="detail-grid">
        <article className="panel">
          <div className="panel-head">
            <h3><Activity size={16} /> 监控趋势</h3>
            <span>{target ? getTypeLabel(target.type) : '-'}</span>
          </div>

          <div className="range-toolbar">
            <div className="type-chips" aria-label="图表时间范围">
              <button type="button" className={`chip ${rangePreset === '1h' ? 'active' : ''}`} onClick={() => setRangePreset('1h')}>1H</button>
              <button type="button" className={`chip ${rangePreset === '6h' ? 'active' : ''}`} onClick={() => setRangePreset('6h')}>6H</button>
              <button type="button" className={`chip ${rangePreset === '12h' ? 'active' : ''}`} onClick={() => setRangePreset('12h')}>12H</button>
              <button type="button" className={`chip ${rangePreset === '24h' ? 'active' : ''}`} onClick={() => setRangePreset('24h')}>24H</button>
              <button type="button" className={`chip ${rangePreset === 'custom' ? 'active' : ''}`} onClick={() => setRangePreset('custom')}>自定义</button>
            </div>

            {rangePreset === 'custom' ? (
              <div className="custom-range">
                <div
                  className="time-picker-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => startPickerRef.current?.flatpickr?.open()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      startPickerRef.current?.flatpickr?.open()
                    }
                  }}
                >
                  <span className="muted">开始</span>
                  <Flatpickr
                    ref={startPickerRef}
                    value={customStart ?? undefined}
                    options={{
                      ...pickerOptions,
                      maxDate: customEnd ?? undefined,
                    }}
                    onChange={(dates) => setCustomStart(dates[0] ?? null)}
                    className="time-input"
                  />
                  <strong>{formatMinuteTime(customStart)}</strong>
                </div>
                <span className="muted">至</span>
                <div
                  className="time-picker-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => endPickerRef.current?.flatpickr?.open()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      endPickerRef.current?.flatpickr?.open()
                    }
                  }}
                >
                  <span className="muted">结束</span>
                  <Flatpickr
                    ref={endPickerRef}
                    value={customEnd ?? undefined}
                    options={{
                      ...pickerOptions,
                      minDate: customStart ?? undefined,
                    }}
                    onChange={(dates) => setCustomEnd(dates[0] ?? null)}
                    className="time-input"
                  />
                  <strong>{formatMinuteTime(customEnd)}</strong>
                </div>
              </div>
            ) : null}
          </div>

          {rangeInvalid ? <p className="error">时间范围无效，请检查开始和结束时间。</p> : null}

          <div className="chart-grid">
            <div className="chart-panel">
              <div className="panel-head">
                <h3>{isTrackingTarget ? 'PV趋势' : '延迟趋势'}</h3>
                <span>按悬浮位置查看时点</span>
              </div>
              <ReactECharts option={latencyOption} style={{ height: 220 }} notMerge lazyUpdate />
            </div>
            <div className="chart-panel">
              <div className="panel-head">
                <h3>{isTrackingTarget ? 'UV趋势' : '可用率趋势'}</h3>
                <span>{isTrackingTarget ? '按时段去重统计' : '累计统计'}</span>
              </div>
              <ReactECharts option={availabilityOption} style={{ height: 220 }} notMerge lazyUpdate />
            </div>
          </div>

        </article>

        <article className="panel">
          <div className="panel-head">
            <h3><Clock3 size={16} /> 查询日志</h3>
            <span>{rangePreset === 'custom' ? '自定义时间' : rangePreset.toUpperCase()}</span>
          </div>

          <div className="log-filters">
            <input
              aria-label="搜索日志"
              placeholder="搜索日志错误信息"
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
            />
            <button
              type="button"
              className={`chip ${onlyAbnormal ? 'active danger' : ''}`}
              onClick={() => setOnlyAbnormal((prev) => !prev)}
            >
              仅异常
            </button>
            <select
              aria-label="日志显示条数"
              value={String(visibleLogs)}
              onChange={(e) => setVisibleLogs(Number(e.target.value))}
            >
              <option value="10">显示 10 条</option>
              <option value="20">显示 20 条</option>
              <option value="50">显示 50 条</option>
              <option value="100">显示 100 条</option>
            </select>
          </div>

          <div className="logs-list">
            {isTrackingTarget
			? (logsToShow as TrackingEvent[]).map((row) => (
				<div className="log-row" key={row.id}>
				  <div className="log-row-head">
					<span className="status ok">事件</span>
					<span className="muted">{formatDateTime(row.occurred_at)}</span>
				  </div>
				  <div className="log-row-body">
					<span>事件名：{row.event_name}</span>
					<span>页面：{row.page || '-'}</span>
					<span>计数：{row.count}</span>
					<span>IP：{row.client_ip || '-'}</span>
					<span>归属地：{row.geo_text || '未知'}</span>
					<span>设备：{summarizeUA(row.user_agent)}</span>
					<span>来源：{row.referer || '-'}</span>
					{row.user_agent ? <span title={row.user_agent}>UA：{row.user_agent}</span> : null}
				  </div>
				</div>
			  ))
			: (logsToShow as CheckResult[]).map((row) => (
				<div className="log-row" key={row.id}>
				  <div className="log-row-head">
					<span className={`status ${row.success ? 'ok' : 'down'}`}>{row.success ? '在线' : '异常'}</span>
					<span className="muted">{formatDateTime(row.checked_at)}</span>
				  </div>
				  <div className="log-row-body">
					<span>延迟：{row.latency_ms > 0 ? `${row.latency_ms}ms` : '--'}</span>
					<span>错误：{row.error_msg || '无'}</span>
				  </div>
				</div>
			  ))}
            {logsToShow.length === 0 ? <p className="muted">暂无日志</p> : null}
          </div>
        </article>

		{isTrackingTarget ? (
		  <article className="panel">
			<div className="panel-head">
			  <h3>访问排行</h3>
			  <span>按 IP 聚合</span>
			</div>
			<div className="log-filters">
			  <input value={userRankSearch} onChange={(e) => setUserRankSearch(e.target.value)} placeholder="搜索用户标识 / 页面 / IP" />
			  <div className="type-chips">
				<button type="button" className={`chip ${userRankSort === 'pv' ? 'active' : ''}`} onClick={() => setUserRankSort('pv')}>按PV</button>
				<button type="button" className={`chip ${userRankSort === 'uv' ? 'active' : ''}`} onClick={() => setUserRankSort('uv')}>按UV</button>
				<button type="button" className={`chip ${userRankSort === 'events' ? 'active' : ''}`} onClick={() => setUserRankSort('events')}>按事件数</button>
				<button type="button" className={`chip ${userRankSort === 'recent' ? 'active' : ''}`} onClick={() => setUserRankSort('recent')}>按最近上报</button>
			  </div>
			  <span className="muted">TOP 20</span>
			</div>
			<div className="rank-list">
			  {userRanking
				.filter((row) => {
				  const key = `${row.key} ${row.lastPage} ${row.lastIP} ${row.lastGeo}`.toLowerCase()
				  return !userRankSearch.trim() || key.includes(userRankSearch.toLowerCase())
				})
				.map((row) => (
				  <div key={row.key} className="rank-row">
					<div className="rank-row-head">
					  <strong>{row.key}</strong>
					  <span className="muted">{new Date(row.lastAt).toLocaleString()}</span>
					</div>
					<div className="rank-row-body">
					  <span>PV：{row.pv}</span>
					  <span>UV：{row.uv}</span>
					  <span>事件：{row.events}</span>
					  <span>最后页面：{row.lastPage}</span>
					  <span>IP：{row.lastIP}</span>
					  <span>归属地：{row.lastGeo}</span>
					  <span>设备：{row.lastDevice}</span>
					</div>
				  </div>
				))}
			  {userRanking.length === 0 ? <p className="muted">暂无排行数据</p> : null}
			</div>
		  </article>
		) : null}

		{isTrackingTarget ? (
		  <article className="panel">
			<div className="panel-head">
			  <h3>访问设备列表</h3>
			  <span>按设备聚合</span>
			</div>
			<div className="log-filters">
			  <input value={deviceRankSearch} onChange={(e) => setDeviceRankSearch(e.target.value)} placeholder="搜索设备" />
			  <div className="type-chips">
				<button type="button" className={`chip ${deviceRankSort === 'pv' ? 'active' : ''}`} onClick={() => setDeviceRankSort('pv')}>按PV</button>
				<button type="button" className={`chip ${deviceRankSort === 'uv' ? 'active' : ''}`} onClick={() => setDeviceRankSort('uv')}>按UV</button>
				<button type="button" className={`chip ${deviceRankSort === 'events' ? 'active' : ''}`} onClick={() => setDeviceRankSort('events')}>按事件数</button>
				<button type="button" className={`chip ${deviceRankSort === 'recent' ? 'active' : ''}`} onClick={() => setDeviceRankSort('recent')}>按最近上报</button>
			  </div>
			  <span className="muted">TOP 20</span>
			</div>
			<div className="rank-list">
			  {deviceRanking
				.filter((row) => !deviceRankSearch.trim() || row.device.toLowerCase().includes(deviceRankSearch.toLowerCase()))
				.map((row) => (
				  <div key={row.device} className="rank-row">
					<div className="rank-row-head">
					  <strong>{row.device}</strong>
					  <span className="muted">{new Date(row.lastAt).toLocaleString()}</span>
					</div>
					<div className="rank-row-body">
					  <span>PV：{row.pv}</span>
					  <span>UV：{row.uv}</span>
					  <span>事件：{row.events}</span>
					</div>
				  </div>
				))}
			  {deviceRanking.length === 0 ? <p className="muted">暂无设备数据</p> : null}
			</div>
		  </article>
		) : null}
      </section>

	  {isTrackingTarget ? (
		<section className="panel guide-panel">
		  <div className="panel-head">
			<h3>接入指南</h3>
			<span>先选方式，再复制代码</span>
		  </div>
		  <p className="muted">当前识别域名：{guidePublicOrigin}</p>
		  <p className="muted">1) 选择接入方式并复制；2) 打开页面触发事件；3) 回到本页刷新查看数据。</p>
		  <div className="type-chips guide-mode-chips">
			<button type="button" className={`chip ${guideMode === 'script' ? 'active' : ''}`} onClick={() => setGuideMode('script')}>一行引用</button>
			<button type="button" className={`chip ${guideMode === 'inline' ? 'active' : ''}`} onClick={() => setGuideMode('inline')}>内联脚本</button>
			<button type="button" className={`chip ${guideMode === 'manual' ? 'active' : ''}`} onClick={() => setGuideMode('manual')}>手动上报</button>
		  </div>
		  <div className="confirm-actions guide-actions">
			<button type="button" onClick={() => void handleCopyTrackingSnippet()} disabled={!trackingConfig.write_key}>
			  {copyDone ? '已复制' : '复制当前代码'}
			</button>
			<button type="button" className="primary" onClick={() => void handleSendTestEvent()} disabled={testingIngest || !trackingConfig.write_key}>
			  {testingIngest ? '发送中...' : '发送测试事件'}
			</button>
		  </div>
		  <label className="guide-code-wrap">
			代码示例
			<textarea className="guide-code" readOnly value={guideCode} rows={guideRows} />
		  </label>
		</section>
	  ) : null}

      {editing ? (
        <div className="drawer-mask" role="dialog" aria-modal="true">
          <aside className="drawer panel">
            <div className="panel-head">
              <h3>编辑监控配置</h3>
              <button type="button" className="icon-button" onClick={() => setEditing(false)}>
                <X size={16} />
              </button>
            </div>

            <form className="target-form" onSubmit={handleSaveConfig}>
              <label>
                名称
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                  required
                />
              </label>
              <label>
                类型
                <div className="type-chips">
                  {CREATE_TYPE_OPTIONS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={`chip ${editForm.type === item.value ? 'active' : ''}`}
                      onClick={() => setEditForm((prev) => ({ ...prev, type: item.value }))}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </label>
			  {editForm.type !== 'tracking' ? (
				<label>
				  地址
				  <input
					value={editForm.endpoint}
					onChange={(e) => setEditForm((prev) => ({ ...prev, endpoint: e.target.value }))}
					required
				  />
				</label>
			  ) : null}
			  {editForm.type === 'ai' || editForm.type === 'api' ? (
				<label>
				  API Key
				  <input
					value={editForm.api_key}
					onChange={(e) => setEditForm((prev) => ({ ...prev, api_key: e.target.value }))}
					placeholder="请输入 API Key"
					type="password"
					required
				  />
				</label>
			  ) : null}
			  {editForm.type === 'tracking' ? (
				<>
				  <label>
					Write Key
					<div className="inline-input-row">
					  <input
						value={editForm.write_key}
						onChange={(e) => setEditForm((prev) => ({ ...prev, write_key: e.target.value }))}
						required
					  />
					  <button type="button" onClick={() => setEditForm((prev) => ({ ...prev, write_key: generateWriteKey() }))}>重置</button>
					</div>
				  </label>
				  <label>
					统计维度
					<div className="type-chips">
					  {[
						{ value: 'pv', label: '仅PV' },
						{ value: 'uv', label: '仅UV' },
						{ value: 'both', label: 'PV+UV' },
					  ].map((item) => (
						<button
						  key={item.value}
						  type="button"
						  className={`chip ${editForm.metric_mode === item.value ? 'active' : ''}`}
						  onClick={() => setEditForm((prev) => ({ ...prev, metric_mode: item.value as 'pv' | 'uv' | 'both' }))}
						>
						  {item.label}
						</button>
					  ))}
					</div>
				  </label>
				  <label>
					UV去重方式
					<div className="type-chips">
					  {[
						{ value: 'client_id', label: 'client_id' },
						{ value: 'ip_ua_hash', label: 'ip_ua_hash' },
						{ value: 'ip_client_hash', label: 'ip+client_id' },
					  ].map((item) => (
						<button
						  key={item.value}
						  type="button"
						  className={`chip ${editForm.uv_identity === item.value ? 'active' : ''}`}
						  onClick={() => setEditForm((prev) => ({ ...prev, uv_identity: item.value as UVIdentity }))}
						>
						  {item.label}
						</button>
					  ))}
					</div>
				  </label>
				  <label>
					超过多久无上报判定失活(分钟)
					<input
					  type="number"
					  min={0}
					  value={editForm.inactive_threshold_min}
					  onChange={(e) => setEditForm((prev) => ({ ...prev, inactive_threshold_min: Math.max(0, Number(e.target.value) || 0) }))}
					  required
					/>
				  </label>
				</>
			  ) : null}
			  {editForm.type !== 'tracking' ? (
				<div className="form-row">
				  <label>
					间隔(秒)
					<input
					  type="number"
					  min={10}
					  value={editForm.interval_sec}
					  onChange={(e) => setEditForm((prev) => ({ ...prev, interval_sec: Number(e.target.value) || 60 }))}
					  required
					/>
				  </label>
				  <label>
					超时(ms)
					<input
					  type="number"
					  min={200}
					  value={editForm.timeout_ms}
					  onChange={(e) => setEditForm((prev) => ({ ...prev, timeout_ms: Number(e.target.value) || 5000 }))}
					  required
					/>
				  </label>
				</div>
			  ) : null}

              <button
                type="button"
                className="switch-field"
                role="switch"
                aria-checked={editForm.enabled}
                onClick={() => setEditForm((prev) => ({ ...prev, enabled: !prev.enabled }))}
              >
                <span className={`switch-track ${editForm.enabled ? 'on' : 'off'}`} aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
                <span className="switch-label">启用该监控目标</span>
              </button>

              <div className="confirm-actions">
                <button type="button" onClick={() => setEditing(false)} disabled={saving}>取消</button>
                <button type="submit" className="primary" disabled={saving}>{saving ? '保存中...' : '保存配置'}</button>
              </div>
            </form>
          </aside>
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="confirm-card panel">
            <h3>确认删除该目标？</h3>
            <p className="muted">删除后不可恢复，相关检测结果也会一并删除。</p>
            <div className="confirm-actions">
              <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting}>取消</button>
              <button type="button" className="danger-btn" onClick={() => void handleDeleteTarget()} disabled={deleting}>
                {deleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function App() {
  const [initialized, setInitialized] = useState<boolean | null>(null)
  const [token, setToken] = useState<string>(() => localStorage.getItem('all_monitor_token') ?? '')
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('all_monitor_theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const [error, setError] = useState('')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('all_monitor_theme', theme)
  }, [theme])

  useEffect(() => {
    void api<{ initialized: boolean }>('/api/init/status')
      .then((d) => setInitialized(d.initialized))
      .catch((e: Error) => setError(e.message))
  }, [])

  async function handleSetup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    try {
      await api('/api/init/setup', {
        method: 'POST',
        body: JSON.stringify({
          username: form.get('username'),
          password: form.get('password'),
        }),
      })
      setInitialized(true)
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    try {
      const data = await api<{ access_token: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: form.get('username'),
          password: form.get('password'),
        }),
      })
      localStorage.setItem('all_monitor_token', data.access_token)
      setToken(data.access_token)
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (initialized === null) {
    return <div className="center-card">正在检查系统初始化状态...</div>
  }

  if (!initialized) {
    return (
      <div className="center-wrap">
        <form className="center-card form-card" onSubmit={handleSetup}>
          <h2>首次初始化</h2>
          <p>配置管理员账号后即可开始监控。</p>
          <label>
            用户名
            <input name="username" required minLength={3} maxLength={32} />
          </label>
          <label>
            密码
            <input name="password" type="password" required minLength={8} maxLength={64} />
          </label>
          <button className="primary" type="submit">完成初始化</button>
          {error ? <p className="error">{error}</p> : null}
        </form>
      </div>
    )
  }

  if (!token) {
    return (
      <div className="center-wrap">
        <form className="center-card form-card" onSubmit={handleLogin}>
          <h2>登录源梦监控工作台</h2>
          <p>私有使用环境，输入账号密码进入。</p>
          <label>
            用户名
            <input name="username" required />
          </label>
          <label>
            密码
            <input name="password" type="password" required />
          </label>
          <button className="primary" type="submit">登录</button>
          {error ? <p className="error">{error}</p> : null}
        </form>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={(
            <DashboardPage
              token={token}
              theme={theme}
              setTheme={setTheme}
              onLogout={() => {
                localStorage.removeItem('all_monitor_token')
                setToken('')
              }}
            />
          )}
        />
        <Route path="/targets/:id" element={<TargetDetailPage token={token} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
