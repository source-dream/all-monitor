import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, InputHTMLAttributes, MouseEvent as ReactMouseEvent } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  Clock3,
  Gauge,
  Moon,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import Flatpickr from 'react-flatpickr'
import 'flatpickr/dist/flatpickr.min.css'
import { Mandarin } from 'flatpickr/dist/l10n/zh.js'
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { ConfirmDialog } from './components/ui/ConfirmDialog'
import { ToastViewport } from './components/ui/ToastViewport'
import { nodeLatencyState, isSubscriptionNodeAvailable, subscriptionNodeCopyText } from './features/subscription/nodeHelpers'
import { useToastManager } from './hooks/useToastManager'
import { useWorkspaceScrollbar } from './hooks/useWorkspaceScrollbar'
import { api, API_BASE, AUTH_EXPIRED_EVENT } from './lib/api'
import type { ApiBody } from './lib/api'
import { copyTextToClipboard } from './lib/clipboard'
import { fetchGithubReleases, resolveVersionUpdateNotice } from './lib/version'
import type { VersionUpdateNotice } from './lib/version'
import { SubscriptionNodeDetailPage } from './pages/SubscriptionNodeDetailPage'
import type {
	CardState,
	CheckResult,
	CreateTargetPayload,
	FinanceSummary,
	PortConfig,
	PortProtocol,
	PreferenceDefaultsPayload,
	SubscriptionConfig,
	SubscriptionCreateDefaults,
	SubscriptionLatencyJobEvent,
	SubscriptionLatencyJobNode,
	SubscriptionLatencyJobStatus,
	SubscriptionNode,
	SubscriptionSeriesPoint,
	SubscriptionSummary,
	Target,
	TrackingConfig,
	TrackingEvent,
	TrackingMetricMode,
	TrackingSeriesPoint,
	TrackingStatusInfo,
	TrackingSummary,
	UDPMode,
	UptimeBlock,
	UserGroupMode,
	UVIdentity,
} from './types/api'
import type { ThemeMode, ToastNotifier } from './types/ui'

const DEFAULT_SUB_FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const APP_VERSION = ((import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() || 'v0.0.0')
const DISMISSED_UPDATE_NOTICE_KEY = 'all_monitor_dismissed_update_tag'


const TYPE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'site', label: '站点' },
  { value: 'tracking', label: '埋点' },
  { value: 'port', label: '端口监控' },
  { value: 'node_group', label: '节点组' },
  { value: 'subscription', label: '订阅' },
  { value: 'ai', label: 'AI中转站' },
]

const CREATE_TYPE_OPTIONS = TYPE_OPTIONS.filter((item) => item.value !== 'all')

const NODE_VIRTUAL_THRESHOLD = 800
const NODE_DEFAULT_PAGE_SIZE = 100
const SUBSCRIPTION_CREATE_SCOPE = 'subscription_create'
const TARGET_DETAIL_SCROLL_KEY_PREFIX = 'target_detail_scroll:'
const SUBSCRIPTION_CREATE_DEFAULTS: SubscriptionCreateDefaults = {
	latency_concurrency: 20,
	latency_timeout_ms: 1200,
	e2e_timeout_ms: 6000,
	fetch_timeout_ms: 20000,
	fetch_retries: 2,
	fetch_proxy_url: '',
	fetch_user_agent: DEFAULT_SUB_FETCH_UA,
	fetch_cookie: '',
	latency_probe_count: 3,
	latency_interval_sec: 300,
	weight_domestic: 0.3,
	weight_overseas: 0.7,
	probe_urls_domestic: ['https://connectivitycheck.platform.hicloud.com/generate_204', 'https://www.qq.com/favicon.ico'],
	probe_urls_overseas: ['https://www.google.com/generate_204', 'https://cp.cloudflare.com/generate_204'],
	singbox_path: 'sing-box',
	interval_sec: 0,
	timeout_ms: 5000,
}

const SUBSCRIPTION_CURRENCY_OPTIONS = [
	{ value: 'CNY', label: '¥-人民币' },
	{ value: 'USD', label: '$-美元' },
	{ value: 'EUR', label: '€-欧元' },
	{ value: 'GBP', label: '£-英镑' },
	{ value: 'RUB', label: '₽-卢布' },
	{ value: 'CHF', label: '₣-法郎' },
	{ value: 'INR', label: '₹-卢比' },
	{ value: 'VND', label: '₫-越南盾' },
	{ value: 'THB', label: '฿-泰铢' },
]

const SUBSCRIPTION_BILLING_CYCLE_OPTIONS = [
	{ value: 'weekly', label: '周' },
	{ value: 'monthly', label: '月' },
	{ value: 'quarterly', label: '季度' },
	{ value: 'yearly', label: '年' },
]

function toFiniteNumber(raw: unknown): number | null {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
	return raw
}

function normalizeSubscriptionCreateDefaults(values?: Record<string, unknown>): SubscriptionCreateDefaults {
	const source = values ?? {}
	const defaults = SUBSCRIPTION_CREATE_DEFAULTS
	const normalizeURLs = (items: unknown, fallback: string[]) => {
		if (!Array.isArray(items)) return fallback
		const rows = items
			.map((x) => String(x ?? '').trim())
			.filter((x) => x.startsWith('http://') || x.startsWith('https://'))
		return rows.length > 0 ? rows : fallback
	}
	const wdRaw = toFiniteNumber(source.weight_domestic)
	const woRaw = toFiniteNumber(source.weight_overseas)
	let wd = wdRaw !== null && wdRaw >= 0 ? wdRaw : defaults.weight_domestic
	let wo = woRaw !== null && woRaw >= 0 ? woRaw : defaults.weight_overseas
	if (wd + wo <= 0) {
		wd = defaults.weight_domestic
		wo = defaults.weight_overseas
	}
	const sum = wd + wo
	return {
		latency_concurrency: Math.max(1, Math.round(toFiniteNumber(source.latency_concurrency) ?? defaults.latency_concurrency)),
		latency_timeout_ms: Math.max(100, Math.round(toFiniteNumber(source.latency_timeout_ms) ?? defaults.latency_timeout_ms)),
		e2e_timeout_ms: Math.max(500, Math.round(toFiniteNumber(source.e2e_timeout_ms) ?? defaults.e2e_timeout_ms)),
		fetch_timeout_ms: Math.max(1000, Math.round(toFiniteNumber(source.fetch_timeout_ms) ?? defaults.fetch_timeout_ms)),
		fetch_retries: Math.max(0, Math.min(5, Math.round(toFiniteNumber(source.fetch_retries) ?? defaults.fetch_retries))),
		fetch_proxy_url: String(source.fetch_proxy_url ?? defaults.fetch_proxy_url).trim(),
		fetch_user_agent: String(source.fetch_user_agent ?? defaults.fetch_user_agent).trim() || defaults.fetch_user_agent,
		fetch_cookie: String(source.fetch_cookie ?? defaults.fetch_cookie).trim(),
		latency_probe_count: Math.max(1, Math.round(toFiniteNumber(source.latency_probe_count) ?? defaults.latency_probe_count)),
		latency_interval_sec: Math.max(0, Math.round(toFiniteNumber(source.latency_interval_sec) ?? defaults.latency_interval_sec)),
		weight_domestic: wd / sum,
		weight_overseas: wo / sum,
		probe_urls_domestic: normalizeURLs(source.probe_urls_domestic, defaults.probe_urls_domestic),
		probe_urls_overseas: normalizeURLs(source.probe_urls_overseas, defaults.probe_urls_overseas),
		singbox_path: String(source.singbox_path ?? defaults.singbox_path).trim() || defaults.singbox_path,
		interval_sec: Math.max(0, Math.round(toFiniteNumber(source.interval_sec) ?? defaults.interval_sec)),
		timeout_ms: Math.max(200, Math.round(toFiniteNumber(source.timeout_ms) ?? defaults.timeout_ms)),
	}
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

function isAuthExpiredMessage(message: string): boolean {
	return message.includes('登录已失效')
}

function formatNextRun(lastTime?: string, intervalSec?: number, nowMs?: number): string {
	if (!intervalSec || intervalSec <= 0) return '--'
	const now = typeof nowMs === 'number' ? nowMs : Date.now()
	const base = lastTime ? new Date(lastTime).getTime() : now
	if (!Number.isFinite(base)) return '--'
	const nextTs = base + intervalSec * 1000
	const diff = nextTs - now
	if (diff <= 0) {
		const overdue = Math.abs(diff)
		if (overdue <= 90_000) return '即将执行'
		if (overdue < 3_600_000) return `调度延迟 ${Math.ceil(overdue / 60_000)} 分钟`
		return `调度延迟 ${Math.ceil(overdue / 3_600_000)} 小时`
	}
	if (diff < 60_000) return `${Math.ceil(diff / 1000)} 秒后`
	if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)} 分钟后`
	if (diff < 86_400_000) return `${Math.ceil(diff / 3_600_000)} 小时后`
	return formatDateTime(new Date(nextTs).toISOString())
}

function getEffectiveCheckIntervalSec(target: Pick<Target, 'interval_sec'>): number {
	return target.interval_sec
}

function formatSubscriptionFee(config?: SubscriptionConfig | null): string {
	if (!config) return '免费'
	const price = typeof config.price === 'number' && Number.isFinite(config.price) ? Math.max(0, config.price) : 0
	if (price <= 0) return '免费'
	const symbolMap: Record<string, string> = {
		CNY: '¥',
		USD: '$',
		EUR: '€',
		GBP: '£',
		RUB: '₽',
		CHF: '₣',
		INR: '₹',
		VND: '₫',
		THB: '฿',
	}
	const cycleMap: Record<string, string> = {
		weekly: '/周',
		monthly: '/月',
		quarterly: '/季度',
		yearly: '/年',
	}
	const currency = (config.currency || 'CNY').toUpperCase()
	const symbol = symbolMap[currency] ?? `${currency} `
	const cycle = cycleMap[config.billing_cycle] ?? '/月'
	const amount = Number.isInteger(price) ? String(price) : price.toFixed(2).replace(/\.00$/, '')
	return `${symbol}${amount}${cycle}`
}

function isSubscriptionPaid(config?: SubscriptionConfig | null): boolean {
	if (!config) return false
	return typeof config.price === 'number' && Number.isFinite(config.price) && config.price > 0
}

function formatPriceInput(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return '0'
	return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '')
}

function parsePriceInput(raw: string): number {
	const normalized = raw.trim()
	if (!normalized) return 0
	const num = Number(normalized)
	if (!Number.isFinite(num) || num < 0) return -1
	return num
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

function getTargetDetailScrollKey(targetID: number): string {
	return `${TARGET_DETAIL_SCROLL_KEY_PREFIX}${targetID}`
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

function isSubscriptionInvalid(summary?: SubscriptionSummary): boolean {
	const msg = (summary?.error_msg ?? '').toLowerCase()
	return msg.includes('empty subscription content')
}

function getSubscriptionStatusText(summary?: SubscriptionSummary): string {
	if (!summary?.has_data) return '待检测'
	if (isSubscriptionInvalid(summary)) return '订阅失效'
	if (summary.reachable) return '可访问'
	return summary.error_msg || '异常'
}

function getCardState(target: Target, rows: CheckResult[], tracking?: TrackingSummary, subscription?: SubscriptionSummary): CardState {
  if (!target.enabled) return 'paused'

	if (target.type === 'subscription' && isSubscriptionInvalid(subscription)) {
		return 'down'
	}

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
	if (value === 'http') return '站点'
	if (value === 'api') return 'AI中转站'
	if (value === 'tcp' || value === 'server' || value === 'node') return '端口监控'
	if (value === 'nodegroup' || value === 'node-group' || value === 'nodes') return '节点组'
	const found = TYPE_OPTIONS.find((item) => item.value === value)
	return found?.label ?? value
}

function normalizeType(value: string): string {
	if (value === 'http') return 'site'
	if (value === 'api') return 'ai'
	if (value === 'tcp' || value === 'server' || value === 'node') return 'port'
	if (value === 'nodegroup' || value === 'node-group' || value === 'nodes') return 'node_group'
	return value
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

function readPortConfig(configJSON?: string): PortConfig {
	const defaults: PortConfig = {
		protocol: 'tcp',
		udp_mode: 'send_only',
		udp_payload: 'ping',
		udp_expect: '',
	}
	if (!configJSON) return defaults
	try {
		const parsed = JSON.parse(configJSON) as {
			protocol?: string
			udp_mode?: string
			udp_payload?: string
			udp_expect?: string
		}
		return {
			protocol: parsed.protocol === 'udp' ? 'udp' : 'tcp',
			udp_mode: parsed.udp_mode === 'request_response' ? 'request_response' : 'send_only',
			udp_payload: (parsed.udp_payload ?? 'ping').trim() || 'ping',
			udp_expect: parsed.udp_expect ?? '',
		}
	} catch {
		return defaults
	}
}

function readSubscriptionConfig(configJSON?: string): SubscriptionConfig {
	const defaults: SubscriptionConfig = {
		latency_concurrency: 20,
		latency_timeout_ms: 1200,
		e2e_timeout_ms: 6000,
		fetch_timeout_ms: 20000,
		fetch_retries: 2,
		fetch_proxy_url: '',
		fetch_user_agent: DEFAULT_SUB_FETCH_UA,
		fetch_cookie: '',
		latency_probe_count: 3,
		latency_interval_sec: 300,
		weight_domestic: 0.3,
		weight_overseas: 0.7,
		probe_urls_domestic: ['https://connectivitycheck.platform.hicloud.com/generate_204', 'https://www.qq.com/favicon.ico'],
		probe_urls_overseas: ['https://www.google.com/generate_204', 'https://cp.cloudflare.com/generate_204'],
		singbox_path: 'sing-box',
		manual_expire_at: '',
		price: 0,
		currency: 'CNY',
		billing_cycle: 'monthly',
		node_uris: [],
	}
	if (!configJSON) return defaults
	try {
		const parsed = JSON.parse(configJSON) as {
			latency_concurrency?: number
			latency_timeout_ms?: number
			e2e_timeout_ms?: number
			fetch_timeout_ms?: number
			fetch_retries?: number
			fetch_proxy_url?: string
			fetch_user_agent?: string
			fetch_cookie?: string
			latency_probe_count?: number
			latency_interval_sec?: number
			weight_domestic?: number
			weight_overseas?: number
			probe_urls_domestic?: string[]
			probe_urls_overseas?: string[]
			singbox_path?: string
			manual_expire_at?: string
			price?: number
			currency?: string
			billing_cycle?: string
			node_uris?: string[]
		}
		const wd = typeof parsed.weight_domestic === 'number' && parsed.weight_domestic >= 0 ? parsed.weight_domestic : defaults.weight_domestic
		const wo = typeof parsed.weight_overseas === 'number' && parsed.weight_overseas >= 0 ? parsed.weight_overseas : defaults.weight_overseas
		const sum = wd + wo > 0 ? wd + wo : defaults.weight_domestic + defaults.weight_overseas
		const normalizeURLs = (items: unknown, fallback: string[]) => {
			if (!Array.isArray(items)) return fallback
			const rows = items
				.map((x) => String(x ?? '').trim())
				.filter((x) => x.startsWith('http://') || x.startsWith('https://'))
			return rows.length > 0 ? rows : fallback
		}
		const normalizeDateTimeLocal = (input: string): string => {
			const raw = input.trim()
			if (!raw) return ''
			if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return raw
			const d = new Date(raw)
			if (Number.isNaN(d.getTime())) return ''
			const pad = (n: number) => String(n).padStart(2, '0')
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
		}
		return {
			latency_concurrency: typeof parsed.latency_concurrency === 'number' && parsed.latency_concurrency > 0 ? parsed.latency_concurrency : 20,
			latency_timeout_ms: typeof parsed.latency_timeout_ms === 'number' && parsed.latency_timeout_ms > 0 ? parsed.latency_timeout_ms : 1200,
			e2e_timeout_ms: typeof parsed.e2e_timeout_ms === 'number' && parsed.e2e_timeout_ms > 0 ? parsed.e2e_timeout_ms : 6000,
			fetch_timeout_ms: typeof parsed.fetch_timeout_ms === 'number' && parsed.fetch_timeout_ms > 0 ? parsed.fetch_timeout_ms : 20000,
			fetch_retries: typeof parsed.fetch_retries === 'number' && parsed.fetch_retries >= 0 ? Math.min(5, parsed.fetch_retries) : 2,
			fetch_proxy_url: (parsed.fetch_proxy_url ?? '').trim(),
			fetch_user_agent: (parsed.fetch_user_agent ?? '').trim() || defaults.fetch_user_agent,
			fetch_cookie: (parsed.fetch_cookie ?? '').trim(),
			latency_probe_count: typeof parsed.latency_probe_count === 'number' && parsed.latency_probe_count > 0 ? parsed.latency_probe_count : 3,
			latency_interval_sec: typeof parsed.latency_interval_sec === 'number' && parsed.latency_interval_sec >= 0 ? parsed.latency_interval_sec : 300,
			weight_domestic: wd / sum,
			weight_overseas: wo / sum,
			probe_urls_domestic: normalizeURLs(parsed.probe_urls_domestic, defaults.probe_urls_domestic),
			probe_urls_overseas: normalizeURLs(parsed.probe_urls_overseas, defaults.probe_urls_overseas),
			singbox_path: (parsed.singbox_path ?? '').trim() || defaults.singbox_path,
			manual_expire_at: normalizeDateTimeLocal(parsed.manual_expire_at ?? ''),
			price: typeof parsed.price === 'number' && Number.isFinite(parsed.price) && parsed.price >= 0 ? parsed.price : defaults.price,
			currency: (parsed.currency ?? '').toString().trim().toUpperCase() || defaults.currency,
			billing_cycle: ['weekly', 'monthly', 'quarterly', 'yearly'].includes((parsed.billing_cycle ?? '').toString().trim().toLowerCase())
				? (parsed.billing_cycle ?? '').toString().trim().toLowerCase()
				: defaults.billing_cycle,
			node_uris: Array.isArray(parsed.node_uris) ? parsed.node_uris.map((x) => String(x ?? '').trim()).filter(Boolean) : [],
		}
	} catch {
		return defaults
	}
}

function AutoGrowTextarea({
	value,
	onChange,
	rows = 3,
	placeholder,
	className,
}: {
	value: string
	onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void
	rows?: number
	placeholder?: string
	className?: string
}) {
	const ref = useRef<HTMLTextAreaElement | null>(null)

	const resize = () => {
		const el = ref.current
		if (!el) return
		el.style.height = 'auto'
		el.style.height = `${el.scrollHeight}px`
	}

	useEffect(() => {
		resize()
	}, [value])

	return (
		<textarea
			ref={ref}
			rows={rows}
			value={value}
			onChange={onChange}
			onInput={resize}
			placeholder={placeholder}
			className={className ? `auto-grow-textarea ${className}` : 'auto-grow-textarea'}
		/>
	)
}

type NumberStepperInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

function NumberStepperInput(props: NumberStepperInputProps) {
	const { className, ...rest } = props
	return <input type="number" className={className ? `number-stepper ${className}` : 'number-stepper'} {...rest} />
}

function FormDropdown({
	value,
	options,
	onChange,
	ariaLabel,
}: {
	value: string
	options: Array<{ value: string; label: string }>
	onChange: (next: string) => void
	ariaLabel: string
}) {
	const [open, setOpen] = useState(false)
	const ref = useRef<HTMLDivElement | null>(null)
	const active = options.find((item) => item.value === value) ?? options[0]

	useEffect(() => {
		if (!open) return
		const onPointerDown = (event: MouseEvent) => {
			if (!ref.current) return
			if (!ref.current.contains(event.target as Node)) {
				setOpen(false)
			}
		}
		const onEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setOpen(false)
		}
		window.addEventListener('mousedown', onPointerDown)
		window.addEventListener('keydown', onEscape)
		return () => {
			window.removeEventListener('mousedown', onPointerDown)
			window.removeEventListener('keydown', onEscape)
		}
	}, [open])

	return (
		<div className={`form-dropdown${open ? ' open' : ''}`} ref={ref}>
			<button
				type="button"
				className="form-dropdown-trigger"
				onClick={() => setOpen((prev) => !prev)}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={ariaLabel}
			>
				<span>{active?.label ?? value}</span>
				<ChevronDown size={14} />
			</button>
			{open ? (
				<div className="form-dropdown-menu" role="listbox" aria-label={ariaLabel}>
					{options.map((item) => (
						<button
							key={item.value}
							type="button"
							className={`form-dropdown-option${item.value === value ? ' active' : ''}`}
							onClick={() => {
								onChange(item.value)
								setOpen(false)
							}}
							role="option"
							aria-selected={item.value === value}
						>
							{item.label}
						</button>
					))}
				</div>
			) : null}
		</div>
	)
}

function openDateTimePicker(input: HTMLInputElement) {
	input.focus()
	const pickerInput = input as HTMLInputElement & { showPicker?: () => void }
	pickerInput.showPicker?.()
}

function formatBytes(val?: number): string {
	if (!val || val <= 0) return '--'
	const units = ['B', 'KB', 'MB', 'GB', 'TB']
	let n = val
	let i = 0
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024
		i += 1
	}
	return `${n.toFixed(i === 0 ? 0 : 1)}${units[i]}`
}

function generateWriteKey(): string {
	return `trk_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2, 8)}`
}

function buildTrackingSnippet(writeKey: string, publicOrigin: string): string {
	return `(() => {
  const API_BASE = '${publicOrigin}'
  const WRITE_KEY = '${writeKey}'
  const ENDPOINT = API_BASE + '/api/ingest/' + WRITE_KEY
  const ENDPOINT_ORIGIN = new URL(ENDPOINT, location.href).origin

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
    const body = JSON.stringify(payload)
    const blob = new Blob([body], { type: 'application/json' })
    if (ENDPOINT_ORIGIN === location.origin) {
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) return
    }
    fetch(ENDPOINT, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
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
	return `<script defer src="${publicOrigin}/sdk/ym-track.min.js" data-write-key="${writeKey}" data-api-base="${API_BASE}"></script>`
}

function buildTrackingManualSnippet(writeKey: string, publicOrigin: string): string {
	return `fetch('${publicOrigin}/api/ingest/${writeKey}', {
  method: 'POST',
  mode: 'cors',
  credentials: 'omit',
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

function buildTrackingVueSnippet(writeKey: string, publicOrigin: string): string {
	return `<script lang="ts" setup>
import { onMounted } from 'vue'

onMounted(() => {
  if (document.querySelector('script[data-ym-track="1"]')) return
  const s = document.createElement('script')
  s.defer = true
  s.src = '${publicOrigin}/sdk/ym-track.min.js'
  s.setAttribute('data-write-key', '${writeKey}')
  s.setAttribute('data-api-base', '${API_BASE}')
  s.setAttribute('data-ym-track', '1')
  document.head.appendChild(s)
})
</script>`
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
  onToggleTheme,
  notify,
  onLogout,
}: {
  token: string
  theme: ThemeMode
  onToggleTheme: (nextTheme: ThemeMode, origin: { x: number; y: number }) => void
  notify: ToastNotifier
  onLogout: () => void
}) {
  useWorkspaceScrollbar()
  const navigate = useNavigate()
  const [targets, setTargets] = useState<Target[]>([])
  const [resultMap, setResultMap] = useState<Record<number, CheckResult[]>>({})
  const [financeMap, setFinanceMap] = useState<Record<number, FinanceSummary>>({})
  const [trackingMap, setTrackingMap] = useState<Record<number, TrackingSummary>>({})
  const [subscriptionMap, setSubscriptionMap] = useState<Record<number, SubscriptionSummary>>({})
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [checkingMap, setCheckingMap] = useState<Record<number, boolean>>({})
  const [disablingMap, setDisablingMap] = useState<Record<number, boolean>>({})
  const [selectedTargetIds, setSelectedTargetIds] = useState<number[]>([])
  const [selectionAnchorId, setSelectionAnchorId] = useState<number | null>(null)
  const [bulkRefreshing, setBulkRefreshing] = useState(false)
  const [bulkDisabling, setBulkDisabling] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [onlyAbnormal, setOnlyAbnormal] = useState(false)
  const [versionNotice, setVersionNotice] = useState<VersionUpdateNotice | null>(null)
  const [createType, setCreateType] = useState('site')
  const [createAPIKey, setCreateAPIKey] = useState('')
  const [createSubConcurrency, setCreateSubConcurrency] = useState(SUBSCRIPTION_CREATE_DEFAULTS.latency_concurrency)
  const [createSubTimeoutMS, setCreateSubTimeoutMS] = useState(SUBSCRIPTION_CREATE_DEFAULTS.latency_timeout_ms)
  const [createSubE2ETimeoutMS, setCreateSubE2ETimeoutMS] = useState(SUBSCRIPTION_CREATE_DEFAULTS.e2e_timeout_ms)
  const [createSubFetchTimeoutMS, setCreateSubFetchTimeoutMS] = useState(SUBSCRIPTION_CREATE_DEFAULTS.fetch_timeout_ms)
  const [createSubFetchRetries, setCreateSubFetchRetries] = useState(SUBSCRIPTION_CREATE_DEFAULTS.fetch_retries)
  const [createSubFetchProxyURL, setCreateSubFetchProxyURL] = useState(SUBSCRIPTION_CREATE_DEFAULTS.fetch_proxy_url)
  const [createSubFetchUA, setCreateSubFetchUA] = useState(SUBSCRIPTION_CREATE_DEFAULTS.fetch_user_agent)
  const [createSubFetchCookie, setCreateSubFetchCookie] = useState(SUBSCRIPTION_CREATE_DEFAULTS.fetch_cookie)
  const [createSubProbeCount, setCreateSubProbeCount] = useState(SUBSCRIPTION_CREATE_DEFAULTS.latency_probe_count)
  const [createSubIntervalSec, setCreateSubIntervalSec] = useState(SUBSCRIPTION_CREATE_DEFAULTS.latency_interval_sec)
  const [createSubWeightDomestic, setCreateSubWeightDomestic] = useState(SUBSCRIPTION_CREATE_DEFAULTS.weight_domestic)
  const [createSubWeightOverseas, setCreateSubWeightOverseas] = useState(SUBSCRIPTION_CREATE_DEFAULTS.weight_overseas)
  const [createSubURLsDomestic, setCreateSubURLsDomestic] = useState(SUBSCRIPTION_CREATE_DEFAULTS.probe_urls_domestic.join('\n'))
  const [createSubURLsOverseas, setCreateSubURLsOverseas] = useState(SUBSCRIPTION_CREATE_DEFAULTS.probe_urls_overseas.join('\n'))
  const [createSingBoxPath, setCreateSingBoxPath] = useState(SUBSCRIPTION_CREATE_DEFAULTS.singbox_path)
  const [createSubTargetIntervalSec, setCreateSubTargetIntervalSec] = useState(SUBSCRIPTION_CREATE_DEFAULTS.interval_sec)
  const [createSubTargetTimeoutMS, setCreateSubTargetTimeoutMS] = useState(SUBSCRIPTION_CREATE_DEFAULTS.timeout_ms)
  const [createSubManualExpireAt, setCreateSubManualExpireAt] = useState('')
  const [createNodeGroupURIs, setCreateNodeGroupURIs] = useState('')
  const [createPortProtocol, setCreatePortProtocol] = useState<PortProtocol>('tcp')
  const [createUDPMode, setCreateUDPMode] = useState<UDPMode>('send_only')
  const [createUDPPayload, setCreateUDPPayload] = useState('ping')
  const [createUDPExpect, setCreateUDPExpect] = useState('')
  const [createMetricMode, setCreateMetricMode] = useState<TrackingMetricMode>('both')
  const [createUVIdentity, setCreateUVIdentity] = useState<UVIdentity>('client_id')
  const [createInactiveThreshold, setCreateInactiveThreshold] = useState(0)
  const [createWriteKey, setCreateWriteKey] = useState(() => generateWriteKey())
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [subDefaultsHydrated, setSubDefaultsHydrated] = useState(false)

  useEffect(() => {
	let cancelled = false
	if (!token) {
		setSubDefaultsHydrated(false)
		return
	}
	void api<PreferenceDefaultsPayload>(`/api/preferences/defaults/${SUBSCRIPTION_CREATE_SCOPE}`, undefined, token)
		.then((payload) => {
			if (cancelled) return
			const normalized = normalizeSubscriptionCreateDefaults(payload.values)
			setCreateSubConcurrency(normalized.latency_concurrency)
			setCreateSubTimeoutMS(normalized.latency_timeout_ms)
			setCreateSubE2ETimeoutMS(normalized.e2e_timeout_ms)
			setCreateSubFetchTimeoutMS(normalized.fetch_timeout_ms)
			setCreateSubFetchRetries(normalized.fetch_retries)
			setCreateSubFetchProxyURL(normalized.fetch_proxy_url)
			setCreateSubFetchUA(normalized.fetch_user_agent)
			setCreateSubFetchCookie(normalized.fetch_cookie)
			setCreateSubProbeCount(normalized.latency_probe_count)
			setCreateSubIntervalSec(normalized.latency_interval_sec)
			setCreateSubWeightDomestic(normalized.weight_domestic)
			setCreateSubWeightOverseas(normalized.weight_overseas)
			setCreateSubURLsDomestic(normalized.probe_urls_domestic.join('\n'))
			setCreateSubURLsOverseas(normalized.probe_urls_overseas.join('\n'))
			setCreateSingBoxPath(normalized.singbox_path)
			setCreateSubTargetIntervalSec(normalized.interval_sec)
			setCreateSubTargetTimeoutMS(normalized.timeout_ms)
		})
		.finally(() => {
			if (!cancelled) setSubDefaultsHydrated(true)
		})
	return () => {
		cancelled = true
	}
  }, [token])

  useEffect(() => {
	if (!token || !subDefaultsHydrated) return
	const normalized = normalizeSubscriptionCreateDefaults({
		latency_concurrency: createSubConcurrency,
		latency_timeout_ms: createSubTimeoutMS,
		e2e_timeout_ms: createSubE2ETimeoutMS,
		fetch_timeout_ms: createSubFetchTimeoutMS,
		fetch_retries: createSubFetchRetries,
		fetch_proxy_url: createSubFetchProxyURL,
		fetch_user_agent: createSubFetchUA,
		fetch_cookie: createSubFetchCookie,
		latency_probe_count: createSubProbeCount,
		latency_interval_sec: createSubIntervalSec,
		weight_domestic: createSubWeightDomestic,
		weight_overseas: createSubWeightOverseas,
		probe_urls_domestic: createSubURLsDomestic.split('\n').map((x) => x.trim()).filter(Boolean),
		probe_urls_overseas: createSubURLsOverseas.split('\n').map((x) => x.trim()).filter(Boolean),
		singbox_path: createSingBoxPath,
		interval_sec: createSubTargetIntervalSec,
		timeout_ms: createSubTargetTimeoutMS,
	})
	const timer = window.setTimeout(() => {
		void api<PreferenceDefaultsPayload>(`/api/preferences/defaults/${SUBSCRIPTION_CREATE_SCOPE}`, {
			method: 'PUT',
			body: JSON.stringify({ values: normalized }),
		}, token).catch(() => undefined)
	}, 600)
	return () => window.clearTimeout(timer)
  }, [
	token,
	subDefaultsHydrated,
	createSubConcurrency,
	createSubTimeoutMS,
	createSubE2ETimeoutMS,
	createSubFetchTimeoutMS,
	createSubFetchRetries,
	createSubFetchProxyURL,
	createSubFetchUA,
	createSubFetchCookie,
	createSubProbeCount,
	createSubIntervalSec,
	createSubWeightDomestic,
	createSubWeightOverseas,
	createSubURLsDomestic,
	createSubURLsOverseas,
	createSingBoxPath,
	createSubTargetIntervalSec,
	createSubTargetTimeoutMS,
  ])

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

	  const subscriptionTargets = targetsData.filter((target) => target.type === 'subscription' || target.type === 'node_group')
	  const subscriptionEntries = await Promise.all(
		subscriptionTargets.map(async (target) => {
		  try {
			const summary = await api<SubscriptionSummary>(`/api/targets/${target.id}/subscription/summary`, undefined, token)
			return [target.id, summary] as const
		  } catch {
			return [target.id, { has_data: false }] as const
		  }
		}),
	  )
	  setSubscriptionMap(Object.fromEntries(subscriptionEntries))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    void loadDashboard()
  }, [])

  useEffect(() => {
	const timer = window.setInterval(() => {
		void loadDashboard()
	}, 30_000)
	return () => window.clearInterval(timer)
  }, [token])

  useEffect(() => {
	const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
	return () => window.clearInterval(timer)
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
    const subscriptionIntervalRaw = Number(form.get('interval_sec'))
    const subscriptionTimeoutRaw = Number(form.get('timeout_ms'))
    const subscriptionIntervalSec = Number.isFinite(subscriptionIntervalRaw)
      ? Math.max(0, Math.round(subscriptionIntervalRaw))
      : createSubTargetIntervalSec
    const subscriptionTimeoutMS = Number.isFinite(subscriptionTimeoutRaw)
      ? Math.max(200, Math.round(subscriptionTimeoutRaw))
      : createSubTargetTimeoutMS
    const payload: CreateTargetPayload = {
      name: String(form.get('name') ?? ''),
      type: createType,
	  endpoint: createType === 'tracking' ? 'tracking://ingest' : (createType === 'node_group' ? 'node-group://manual' : String(form.get('endpoint') ?? '')),
	  interval_sec: createType === 'tracking' ? 60 : (createType === 'subscription' ? subscriptionIntervalSec : (createType === 'node_group' ? 0 : Number(form.get('interval_sec') ?? 60))),
	  timeout_ms: createType === 'tracking' ? 5000 : (createType === 'subscription' ? subscriptionTimeoutMS : (createType === 'node_group' ? 5000 : Number(form.get('timeout_ms') ?? 5000))),
      enabled: true,
	  config_json: createType === 'ai'
		? JSON.stringify({ api_key: createAPIKey.trim() })
		: ((createType === 'subscription' || createType === 'node_group')
			? JSON.stringify({
				latency_concurrency: createSubConcurrency,
				latency_timeout_ms: createSubTimeoutMS,
				e2e_timeout_ms: createSubE2ETimeoutMS,
				fetch_timeout_ms: createSubFetchTimeoutMS,
				fetch_retries: createSubFetchRetries,
				fetch_proxy_url: createSubFetchProxyURL.trim(),
				fetch_user_agent: createSubFetchUA.trim() || DEFAULT_SUB_FETCH_UA,
				fetch_cookie: createSubFetchCookie.trim(),
				latency_probe_count: createSubProbeCount,
				latency_interval_sec: createSubIntervalSec,
				weight_domestic: createSubWeightDomestic,
				weight_overseas: createSubWeightOverseas,
				probe_urls_domestic: createSubURLsDomestic.split('\n').map((x) => x.trim()).filter(Boolean),
				probe_urls_overseas: createSubURLsOverseas.split('\n').map((x) => x.trim()).filter(Boolean),
				singbox_path: createSingBoxPath.trim() || 'sing-box',
				manual_expire_at: createType === 'subscription' ? createSubManualExpireAt.trim() : '',
				price: 0,
				currency: 'CNY',
				billing_cycle: 'monthly',
				node_uris: createType === 'node_group' ? createNodeGroupURIs.split('\n').map((x) => x.trim()).filter(Boolean) : [],
			})
		: (createType === 'port'
			? JSON.stringify({
				protocol: createPortProtocol,
				udp_mode: createUDPMode,
				udp_payload: createUDPPayload.trim() || 'ping',
				udp_expect: createUDPExpect.trim(),
			})
		: (createType === 'tracking'
			? JSON.stringify({
				write_key: createWriteKey,
				metric_mode: createMetricMode,
				uv_identity: createUVIdentity,
				user_group_mode: 'ip_device',
				inactive_threshold_min: createInactiveThreshold,
			})
			: '{}'))),
    }

	if (createType === 'ai' && !createAPIKey.trim()) {
		setError('AI中转站类型必须填写 API Key')
		return
	}
	if (createType === 'tracking' && !createWriteKey.trim()) {
		setError('埋点类型必须填写 write key')
		return
	}
	if ((createType === 'subscription' || createType === 'node_group') && createSubConcurrency <= 0) {
		setError('订阅测速并发必须大于 0')
		return
	}
	if ((createType === 'subscription' || createType === 'node_group') && createSubProbeCount <= 0) {
		setError('单节点探测次数必须大于 0')
		return
	}
	if ((createType === 'subscription' || createType === 'node_group') && createSubE2ETimeoutMS <= 0) {
		setError('E2E 超时必须大于 0')
		return
	}
	if ((createType === 'subscription' || createType === 'node_group') && createSubFetchTimeoutMS <= 0) {
		setError('订阅拉取超时必须大于 0')
		return
	}
	if ((createType === 'subscription' || createType === 'node_group') && createSubFetchRetries < 0) {
		setError('订阅拉取重试次数不能小于 0')
		return
	}
	if ((createType === 'subscription' || createType === 'node_group') && createSubIntervalSec < 0) {
		setError('自动测速间隔不能小于 0（0 表示不定时测速）')
		return
	}
	if (createType === 'subscription' && createSubTargetIntervalSec < 0) {
		setError('订阅拉取间隔不能小于 0（0 表示不定时拉取）')
		return
	}
	if (createType === 'subscription' && createSubTargetTimeoutMS <= 0) {
		setError('超时必须大于 0')
		return
	}
	if ((createType === 'subscription' || createType === 'node_group') && (createSubWeightDomestic < 0 || createSubWeightOverseas < 0 || (createSubWeightDomestic + createSubWeightOverseas) <= 0)) {
		setError('国内/海外权重需大于等于0且总和大于0')
		return
	}
	if (createType === 'port' && createPortProtocol === 'udp' && createUDPMode === 'request_response' && !createUDPExpect.trim()) {
		setError('UDP 校验回包模式下请填写期望回包')
		return
	}
	if (createType !== 'tracking' && createType !== 'node_group' && !String(form.get('endpoint') ?? '').trim()) {
		setError('该类型必须填写地址')
		return
	}

    setCreating(true)
    try {
      await api('/api/targets', { method: 'POST', body: JSON.stringify(payload) }, token)
      formEl.reset()
	  setCreateType('site')
	  setCreateAPIKey('')
	  setCreateSubManualExpireAt('')
	  setCreatePortProtocol('tcp')
	  setCreateUDPMode('send_only')
	  setCreateUDPPayload('ping')
	  setCreateUDPExpect('')
	  setCreateMetricMode('both')
	  setCreateUVIdentity('client_id')
	  setCreateInactiveThreshold(0)
	  setCreateWriteKey(generateWriteKey())
	  void loadDashboard()
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

  function updateSelectionAfterModifierClick(targetId: number, useRange: boolean) {
    if (useRange) {
      const visibleIds = filteredTargets.map((item) => item.id)
      const anchorId = selectionAnchorId !== null && visibleIds.includes(selectionAnchorId) ? selectionAnchorId : targetId
      const anchorIdx = visibleIds.indexOf(anchorId)
      const targetIdx = visibleIds.indexOf(targetId)
      if (anchorIdx === -1 || targetIdx === -1) {
        setSelectedTargetIds((prev) => (prev.includes(targetId) ? prev : [...prev, targetId]))
        setSelectionAnchorId(targetId)
        return
      }
      const [start, end] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
      const rangeIds = visibleIds.slice(start, end + 1)
      setSelectedTargetIds((prev) => Array.from(new Set([...prev, ...rangeIds])))
      setSelectionAnchorId(anchorId)
      return
    }

    setSelectedTargetIds((prev) => {
      if (prev.includes(targetId)) {
        return prev.filter((id) => id !== targetId)
      }
      return [...prev, targetId]
    })
    setSelectionAnchorId(targetId)
  }

  async function handleBulkRefresh() {
    const selectedTargets = targets.filter((target) => selectedTargetIds.includes(target.id))
    const runnableTargets = selectedTargets.filter((target) => target.type !== 'tracking' && target.enabled)
    const skippedCount = selectedTargets.length - runnableTargets.length
    if (runnableTargets.length === 0) {
      notify.warning('当前选择中没有可刷新的目标（埋点类型或已停用将被跳过）')
      return
    }

    setBulkRefreshing(true)
    setCheckingMap((prev) => {
      const next = { ...prev }
      runnableTargets.forEach((target) => {
        next[target.id] = true
      })
      return next
    })

    try {
      const results = await Promise.allSettled(
        runnableTargets.map((target) => api(`/api/targets/${target.id}/check-now`, { method: 'POST' }, token)),
      )
      const failedCount = results.filter((row) => row.status === 'rejected').length
      const successCount = runnableTargets.length - failedCount
      if (failedCount === 0) {
        notify.success(`批量刷新完成：成功 ${successCount}${skippedCount > 0 ? `，跳过 ${skippedCount}` : ''}`)
      } else {
        notify.warning(`批量刷新完成：成功 ${successCount}，失败 ${failedCount}${skippedCount > 0 ? `，跳过 ${skippedCount}` : ''}`)
      }
      await loadDashboard()
      setSelectedTargetIds([])
      setSelectionAnchorId(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCheckingMap((prev) => {
        const next = { ...prev }
        runnableTargets.forEach((target) => {
          next[target.id] = false
        })
        return next
      })
      setBulkRefreshing(false)
    }
  }

  async function handleBulkDisable() {
    const selectedTargets = targets.filter((target) => selectedTargetIds.includes(target.id))
    const runnableTargets = selectedTargets.filter((target) => target.enabled)
    const skippedCount = selectedTargets.length - runnableTargets.length
    if (runnableTargets.length === 0) {
      notify.warning('当前选择中没有可禁用的目标')
      return
    }

    setBulkDisabling(true)
    setDisablingMap((prev) => {
      const next = { ...prev }
      runnableTargets.forEach((target) => {
        next[target.id] = true
      })
      return next
    })

    try {
      const results = await Promise.allSettled(
        runnableTargets.map((target) => api(`/api/targets/${target.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            ...target,
            enabled: false,
            config_json: target.config_json ?? '{}',
          }),
        }, token)),
      )
      const failedCount = results.filter((row) => row.status === 'rejected').length
      const successCount = runnableTargets.length - failedCount
      if (failedCount === 0) {
        notify.success(`批量禁用完成：成功 ${successCount}${skippedCount > 0 ? `，跳过 ${skippedCount}` : ''}`)
      } else {
        notify.warning(`批量禁用完成：成功 ${successCount}，失败 ${failedCount}${skippedCount > 0 ? `，跳过 ${skippedCount}` : ''}`)
      }
      await loadDashboard()
      setSelectedTargetIds([])
      setSelectionAnchorId(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDisablingMap((prev) => {
        const next = { ...prev }
        runnableTargets.forEach((target) => {
          next[target.id] = false
        })
        return next
      })
      setBulkDisabling(false)
    }
  }

  async function handleBulkDelete() {
    const selectedTargets = targets.filter((target) => selectedTargetIds.includes(target.id))
    if (selectedTargets.length === 0) return

    setBulkDeleting(true)
    try {
      const results = await Promise.allSettled(
        selectedTargets.map((target) => api(`/api/targets/${target.id}`, { method: 'DELETE' }, token)),
      )
      const failedIds: number[] = []
      results.forEach((row, idx) => {
        if (row.status === 'rejected') failedIds.push(selectedTargets[idx].id)
      })
      const failedCount = failedIds.length
      const successCount = selectedTargets.length - failedCount
      if (failedCount === 0) {
        notify.success(`批量删除完成：已删除 ${successCount} 个目标`)
      } else {
        notify.warning(`批量删除完成：成功 ${successCount}，失败 ${failedCount}`)
      }
      await loadDashboard()
      setSelectedTargetIds(failedIds)
      setSelectionAnchorId(failedIds.length > 0 ? failedIds[failedIds.length - 1] : null)
      setConfirmBulkDelete(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBulkDeleting(false)
    }
  }

  const filteredTargets = useMemo(() => {
    return targets.filter((item) => {
      const hitKeyword = !search.trim() || `${item.name} ${item.endpoint}`.toLowerCase().includes(search.toLowerCase())
      const hitType =
		typeFilter === 'all' ||
		item.type === typeFilter ||
		(typeFilter === 'site' && item.type === 'http') ||
		(typeFilter === 'ai' && item.type === 'api') ||
		(typeFilter === 'port' && (item.type === 'tcp' || item.type === 'server' || item.type === 'node'))
      const state = getCardState(item, resultMap[item.id] ?? [], trackingMap[item.id], subscriptionMap[item.id])
      const hitAbnormal = !onlyAbnormal || state === 'down' || state === 'degraded'
      return hitKeyword && hitType && hitAbnormal
    })
  }, [targets, search, typeFilter, onlyAbnormal, resultMap, trackingMap])

  const selectedTargetSet = useMemo(() => new Set(selectedTargetIds), [selectedTargetIds])
  const visibleTargetIds = useMemo(() => filteredTargets.map((target) => target.id), [filteredTargets])
  const visibleSelectedCount = useMemo(
    () => visibleTargetIds.filter((id) => selectedTargetSet.has(id)).length,
    [visibleTargetIds, selectedTargetSet],
  )
  const allVisibleSelected = visibleTargetIds.length > 0 && visibleSelectedCount === visibleTargetIds.length

  function handleToggleSelectAllVisible() {
    if (visibleTargetIds.length === 0) return
    if (allVisibleSelected) {
      const visibleSet = new Set(visibleTargetIds)
      setSelectedTargetIds((prev) => prev.filter((id) => !visibleSet.has(id)))
      setSelectionAnchorId((prev) => (prev !== null && visibleSet.has(prev) ? null : prev))
      return
    }
    setSelectedTargetIds((prev) => Array.from(new Set([...prev, ...visibleTargetIds])))
    setSelectionAnchorId((prev) => prev ?? visibleTargetIds[0])
  }

  useEffect(() => {
    const existingIds = new Set(targets.map((target) => target.id))
    setSelectedTargetIds((prev) => prev.filter((id) => existingIds.has(id)))
    setSelectionAnchorId((prev) => (prev !== null && existingIds.has(prev) ? prev : null))
  }, [targets])

  useEffect(() => {
	let cancelled = false
	void (async () => {
		try {
			const releases = await fetchGithubReleases()
			if (cancelled || releases.length === 0) return
			const notice = resolveVersionUpdateNotice(APP_VERSION, releases)
			if (!notice || cancelled) return
			const dismissedTag = localStorage.getItem(DISMISSED_UPDATE_NOTICE_KEY) ?? ''
			if (dismissedTag === notice.latestTag) {
				setVersionNotice(null)
				return
			}
			setVersionNotice(notice)
		} catch {
			if (!cancelled) setVersionNotice(null)
		}
	})()
	return () => {
		cancelled = true
	}
  }, [])

  return (
    <>
      <header className="workspace-header dashboard-nav">
        <div className="dashboard-nav-inner">
          <div className="header-main">
            <h1>全能监控</h1>
            <div className="header-version-wrap">
              <span className="header-version-badge">{APP_VERSION}</span>
              {versionNotice ? (
				<div className="header-version-update-wrap">
				  <a
					className={`header-version-update ${versionNotice.kind === 'stable' ? 'stable' : 'prerelease'}`}
					href={versionNotice.url}
					target="_blank"
					rel="noreferrer"
				  >
					{versionNotice.kind === 'stable' ? `有正式版更新 ${versionNotice.latestTag}` : `有预发布更新 ${versionNotice.latestTag}`}
				  </a>
				  <button
					type="button"
					className="header-version-dismiss"
					onClick={() => {
						localStorage.setItem(DISMISSED_UPDATE_NOTICE_KEY, versionNotice.latestTag)
						setVersionNotice(null)
					}}
					aria-label="关闭更新提示"
					title="关闭更新提示"
				  >
					<X size={12} />
				  </button>
				</div>
              ) : null}
            </div>
          </div>
          <div className="header-actions">
            <button type="button" onClick={onLogout}>退出登录</button>
            <button
              type="button"
              className="mode-toggle-btn"
              onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                const nextTheme: ThemeMode = theme === 'dark' ? 'light' : 'dark'
                onToggleTheme(nextTheme, { x: event.clientX, y: event.clientY })
              }}
              aria-label={theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}
              title={theme === 'dark' ? '白天模式' : '黑夜模式'}
            >
              <span className={`theme-icon-stack ${theme === 'dark' ? 'show-sun' : 'show-moon'}`}>
                <Sun size={16} className="theme-icon sun-icon" />
                <Moon size={16} className="theme-icon moon-icon" />
              </span>
            </button>
          </div>
        </div>
      </header>

    <div className="workspace dashboard-workspace">

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
          <button
            type="button"
            className={`chip ${allVisibleSelected ? 'active' : ''}`}
            onClick={handleToggleSelectAllVisible}
            disabled={visibleTargetIds.length === 0}
          >
            {allVisibleSelected ? '取消全选' : '全选'}
          </button>
        </div>
      </section>

      {selectedTargetIds.length > 0 ? (
        <section className="panel selection-toolbar">
          <div className="selection-summary">
            <strong>已选 {selectedTargetIds.length} 个目标</strong>
          </div>
          <div className="selection-actions">
            <button type="button" onClick={() => void handleBulkRefresh()} disabled={bulkRefreshing || bulkDisabling || bulkDeleting}>
              {bulkRefreshing ? '批量刷新中...' : '批量刷新'}
            </button>
            <button type="button" onClick={() => void handleBulkDisable()} disabled={bulkRefreshing || bulkDisabling || bulkDeleting}>
              {bulkDisabling ? '批量禁用中...' : '批量禁用'}
            </button>
            <button
              type="button"
              onClick={handleToggleSelectAllVisible}
              disabled={visibleTargetIds.length === 0 || bulkRefreshing || bulkDisabling || bulkDeleting}
            >
              {allVisibleSelected ? '取消全选' : '全选'}
            </button>
            <button
              type="button"
              className="danger-btn"
              onClick={() => setConfirmBulkDelete(true)}
              disabled={bulkRefreshing || bulkDisabling || bulkDeleting}
            >
              批量删除
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedTargetIds([])
                setSelectionAnchorId(null)
              }}
              disabled={bulkRefreshing || bulkDisabling || bulkDeleting}
            >
              清空选择
            </button>
          </div>
        </section>
      ) : null}

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
					  if (item.value === 'port') {
						  setCreatePortProtocol('tcp')
						  setCreateUDPMode('send_only')
						  setCreateUDPPayload('ping')
						  setCreateUDPExpect('')
					  }
					}}
                    aria-pressed={createType === item.value}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </label>
			{createType !== 'tracking' && createType !== 'node_group' ? (
			  <label>
				地址
				<input name="endpoint" placeholder={createType === 'port' ? '127.0.0.1:6379' : 'https://example.com/health 或 1.2.3.4:443'} required />
			  </label>
			) : null}
			{createType === 'port' ? (
			  <>
				<label>
				  协议
				  <div className="type-chips">
					<button type="button" className={`chip ${createPortProtocol === 'tcp' ? 'active' : ''}`} onClick={() => setCreatePortProtocol('tcp')}>TCP</button>
					<button type="button" className={`chip ${createPortProtocol === 'udp' ? 'active' : ''}`} onClick={() => setCreatePortProtocol('udp')}>UDP</button>
				  </div>
				</label>
				{createPortProtocol === 'udp' ? (
				  <>
					<label>
					  UDP 模式
					  <div className="type-chips">
						<button type="button" className={`chip ${createUDPMode === 'send_only' ? 'active' : ''}`} onClick={() => setCreateUDPMode('send_only')}>仅发送</button>
						<button type="button" className={`chip ${createUDPMode === 'request_response' ? 'active' : ''}`} onClick={() => setCreateUDPMode('request_response')}>发送并校验回包</button>
					  </div>
					</label>
					<label>
					  UDP 发送内容
					  <input value={createUDPPayload} onChange={(e) => setCreateUDPPayload(e.target.value)} placeholder="ping" />
					</label>
					{createUDPMode === 'request_response' ? (
					  <label>
						期望回包（包含）
						<input value={createUDPExpect} onChange={(e) => setCreateUDPExpect(e.target.value)} placeholder="pong" required />
					  </label>
					) : null}
				  </>
				) : null}
			  </>
			) : null}
			{createType === 'ai' ? (
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
			{createType === 'subscription' || createType === 'node_group' ? (
			  <>
			  {createType === 'node_group' ? (
				<label>
				  节点 URI 列表（每行一个，可选）
				  <AutoGrowTextarea value={createNodeGroupURIs} onChange={(e) => setCreateNodeGroupURIs(e.target.value)} rows={5} placeholder="vmess://...\nvless://..." />
				</label>
			  ) : null}
			  <div className="form-row">
				<label>
				  测速并发（大于等于1）
				  <NumberStepperInput min={1} value={createSubConcurrency} onChange={(e) => setCreateSubConcurrency(Number(e.target.value) || 1)} required />
				</label>
				<label>
				  测速超时(ms)
				  <NumberStepperInput min={100} value={createSubTimeoutMS} onChange={(e) => setCreateSubTimeoutMS(Number(e.target.value) || 1200)} required />
				</label>
				<label>
				  E2E超时(ms)
				  <NumberStepperInput min={500} value={createSubE2ETimeoutMS} onChange={(e) => setCreateSubE2ETimeoutMS(Number(e.target.value) || 6000)} required />
				</label>
				{createType === 'subscription' ? (
				  <>
					<label>
					  订阅拉取超时(ms)
					  <NumberStepperInput min={1000} value={createSubFetchTimeoutMS} onChange={(e) => setCreateSubFetchTimeoutMS(Number(e.target.value) || 20000)} required />
					</label>
					<label>
					  拉取重试次数
					  <NumberStepperInput min={0} max={5} value={createSubFetchRetries} onChange={(e) => setCreateSubFetchRetries(Math.max(0, Math.min(5, Number(e.target.value) || 0)))} required />
					</label>
				  </>
				) : null}
				<label>
				  单节点探测次数
				  <NumberStepperInput min={1} value={createSubProbeCount} onChange={(e) => setCreateSubProbeCount(Number(e.target.value) || 3)} required />
				</label>
				<label>
				  自动测速间隔(秒，0=不定时)
				  <NumberStepperInput
					min={0}
					value={createSubIntervalSec}
					onChange={(e) => {
						const next = Number(e.target.value)
						setCreateSubIntervalSec(Number.isFinite(next) ? Math.max(0, Math.round(next)) : 0)
					}}
					required
				  />
				</label>
				<label>
				  国内权重
				  <NumberStepperInput min={0} step={0.1} value={createSubWeightDomestic} onChange={(e) => setCreateSubWeightDomestic(Math.max(0, Number(e.target.value) || 0))} required />
				</label>
				<label>
				  海外权重
				  <NumberStepperInput min={0} step={0.1} value={createSubWeightOverseas} onChange={(e) => setCreateSubWeightOverseas(Math.max(0, Number(e.target.value) || 0))} required />
				</label>
			  </div>
			  <label>
				国内测速URL（每行一个）
				<AutoGrowTextarea value={createSubURLsDomestic} onChange={(e) => setCreateSubURLsDomestic(e.target.value)} rows={3} />
			  </label>
			  <label>
				海外测速URL（每行一个）
				<AutoGrowTextarea value={createSubURLsOverseas} onChange={(e) => setCreateSubURLsOverseas(e.target.value)} rows={3} />
			  </label>
			  <label>
				sing-box 路径
				<input value={createSingBoxPath} onChange={(e) => setCreateSingBoxPath(e.target.value)} placeholder="sing-box" />
			  </label>
			  {createType === 'subscription' ? (
				<>
				  <label>
					订阅拉取代理（可选）
					<input value={createSubFetchProxyURL} onChange={(e) => setCreateSubFetchProxyURL(e.target.value)} placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7890" />
				  </label>
				  <label>
					订阅拉取 UA
					<input value={createSubFetchUA} onChange={(e) => setCreateSubFetchUA(e.target.value)} placeholder={DEFAULT_SUB_FETCH_UA} />
				  </label>
				  <label>
					订阅拉取 Cookie（可选）
					<AutoGrowTextarea value={createSubFetchCookie} onChange={(e) => setCreateSubFetchCookie(e.target.value)} rows={2} />
				  </label>
				  <label>
					手动到期时间（可选）
					<input
						type="datetime-local"
						value={createSubManualExpireAt}
						onChange={(e) => setCreateSubManualExpireAt(e.target.value)}
						onClick={(e) => openDateTimePicker(e.currentTarget)}
						onFocus={(e) => openDateTimePicker(e.currentTarget)}
					/>
				  </label>
				</>
			  ) : null}
			  </>
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
				  <NumberStepperInput
					min={0}
					value={createInactiveThreshold}
					onChange={(e) => setCreateInactiveThreshold(Math.max(0, Number(e.target.value) || 0))}
					required
				  />
				</label>
			  </>
			) : null}
			{createType !== 'tracking' && createType !== 'node_group' ? (
			  <div className="form-row">
				<label>
			  {createType === 'subscription' ? '订阅拉取间隔(秒，0=不定时)' : '间隔(秒)'}
			  {createType === 'subscription' ? (
					<NumberStepperInput
						name="interval_sec"
						min={0}
						value={createSubTargetIntervalSec}
						onChange={(e) => {
							const next = Number(e.target.value)
							setCreateSubTargetIntervalSec(Number.isFinite(next) ? Math.max(0, Math.round(next)) : 0)
						}}
						required
					/>
				  ) : (
					<NumberStepperInput key={`interval-${createType}`} name="interval_sec" defaultValue={60} min={10} required />
				  )}
				</label>
				<label>
				  超时(ms)
			  {createType === 'subscription' ? (
					<NumberStepperInput
						name="timeout_ms"
						min={200}
						value={createSubTargetTimeoutMS}
						onChange={(e) => {
							const next = Number(e.target.value)
							setCreateSubTargetTimeoutMS(Number.isFinite(next) ? Math.max(200, Math.round(next)) : 5000)
						}}
						required
					/>
				  ) : (
					<NumberStepperInput name="timeout_ms" defaultValue={5000} min={200} required />
				  )}
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
			const subscription = subscriptionMap[target.id]
			const subscriptionConfig = (target.type === 'subscription' || target.type === 'node_group') ? readSubscriptionConfig(target.config_json) : null
			const cardExpireAt = subscription?.expire_at || subscriptionConfig?.manual_expire_at || ''
			const trackingStatus = target.type === 'tracking' ? getTrackingStatusInfo(target, tracking) : null
			const latest = rows[0]
			const lastRunAt = target.type === 'tracking'
				? tracking?.last_event_at
				: latest?.checked_at
			const nextRunInterval = getEffectiveCheckIntervalSec(target)
			const nextRunText = target.type === 'tracking' ? '--' : formatNextRun(lastRunAt, nextRunInterval, nowTick)
			const nextLatencyRunText = (target.type === 'subscription' || target.type === 'node_group')
				? formatNextRun(subscription?.last_latency_checked_at, subscriptionConfig?.latency_interval_sec ?? 0, nowTick)
				: '--'
			const state = getCardState(target, rows, tracking, subscription)
            const successRows = rows.filter((x) => x.success)
            const uptime = rows.length > 0 ? (successRows.length / rows.length) * 100 : 0
            const avgLatency = successRows.length > 0
              ? Math.round(successRows.reduce((sum, x) => sum + x.latency_ms, 0) / successRows.length)
              : 0
            const blocks = buildUptimeBlocks(rows)

            return (
              <article
                className={`panel monitor-card clickable state-${state}${selectedTargetSet.has(target.id) ? ' selected' : ''}`}
                key={target.id}
                onClick={(event) => {
                  const useRange = event.shiftKey
                  const useToggle = event.ctrlKey || event.metaKey
                  if (useRange || useToggle) {
                    event.preventDefault()
                    event.stopPropagation()
                    updateSelectionAfterModifierClick(target.id, useRange)
                    return
                  }
                  if (selectedTargetIds.length > 0) {
                    event.preventDefault()
                    event.stopPropagation()
                    updateSelectionAfterModifierClick(target.id, false)
                    return
                  }
                  navigate(`/targets/${target.id}`)
                }}
              >
				<div className="card-head">
				<div className="card-head-main">
					<div className="card-title-row">
						<h3>{target.name}</h3>
						{target.type === 'subscription' ? (
							<span className={`subscription-fee-badge ${isSubscriptionPaid(subscriptionConfig) ? 'paid' : 'free'}`}>
								{formatSubscriptionFee(subscriptionConfig)}
							</span>
						) : null}
					</div>
					{target.type !== 'tracking' && target.type !== 'node_group' ? (
					  <>
						<a
						className="endpoint-link"
						href={toVisitURL(target.endpoint)}
						target="_blank"
						rel="noreferrer"
						onClick={(event) => {
							event.preventDefault()
							event.stopPropagation()
							void copyTextToClipboard(target.endpoint).then((ok) => {
								if (ok) notify.success('地址已复制')
								else notify.error('复制失败')
							})
						}}
						onContextMenu={(event) => {
							event.preventDefault()
							event.stopPropagation()
							window.open(toVisitURL(target.endpoint), '_blank', 'noopener,noreferrer')
						  }}
						title="左键复制地址，右键打开"
						>
						  {target.endpoint}
						</a>
					  </>
					) : (
					  <p className="muted">{target.type === 'node_group' ? '手动节点列表' : '被动上报'}</p>
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
				) : (target.type === 'subscription' || target.type === 'node_group') ? (
				  <div className="metrics">
					<div>
					  <p className="muted">节点状态</p>
					  <strong>{subscription?.has_data ? `${subscription.available_total ?? 0}/${subscription.node_total ?? 0}` : '--'}</strong>
					</div>
					{target.type === 'subscription' ? (
					  <>
						<div>
						  <p className="muted">剩余流量</p>
						  <strong>{subscription?.has_data ? formatBytes(subscription.remaining_bytes) : '--'}</strong>
						</div>
						<div>
						  <p className="muted">到期时间</p>
						  <strong>{cardExpireAt ? formatDateTime(cardExpireAt) : '--'}</strong>
						</div>
					  </>
					) : (
					  <>
						<div>
						  <p className="muted">平均延迟</p>
						  <strong>{subscription?.latency_ms ? `${subscription.latency_ms}ms` : '--'}</strong>
						</div>
						<div>
						  <p className="muted">测速状态</p>
						  <strong className="subscription-status-text">{getSubscriptionStatusText(subscription)}</strong>
						</div>
					  </>
					)}
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

				{target.type !== 'tracking' && target.type !== 'subscription' && target.type !== 'node_group' ? (
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
				) : target.type === 'tracking' ? (
				  <p className="muted">最近事件：{tracking?.last_event_name || '-'}</p>
				) : (
					<p className="muted subscription-status-text">订阅状态：{getSubscriptionStatusText(subscription)}</p>
				)}

				<div className="card-actions">
				  <span className="card-type-badge">{getTypeLabel(target.type)}</span>
				  <div className="card-meta-right">
					<span className="muted">
					  {target.type === 'tracking'
						? `最后上报：${tracking?.last_event_at ? formatAgo(tracking.last_event_at) : '暂无'}`
						: ((target.type === 'subscription' || target.type === 'node_group')
							? `${target.type === 'node_group' ? '最近测速' : '最近拉取'}：${subscription?.last_checked_at ? formatAgo(subscription.last_checked_at) : '暂无'}`
							: `最后检测：${latest ? formatAgo(latest.checked_at) : '暂无'}`)}
					</span>
					{target.type === 'tracking' ? null : (
						<span className="muted">
							{(target.type === 'subscription' || target.type === 'node_group')
								? `下次测速：${(subscriptionConfig?.latency_interval_sec ?? 0) > 0 ? nextLatencyRunText : '不定时'}`
								: `下次检测：${nextRunText}`}
						</span>
					)}
				  </div>
				</div>
              </article>
            )
          })}
        </div>
      </section>

    </div>
    <ConfirmDialog
      open={confirmBulkDelete}
      title="确认批量删除？"
      description={`已选择 ${selectedTargetIds.length} 个目标，删除后不可恢复，相关检测结果也会一并删除。`}
      confirmText="确认删除"
      confirmVariant="danger"
      confirming={bulkDeleting}
      onCancel={() => setConfirmBulkDelete(false)}
      onConfirm={() => void handleBulkDelete()}
    />
    </>
  )
}

function TargetDetailPage({ token, notify }: { token: string; notify: ToastNotifier }) {
  useWorkspaceScrollbar()
  const navigate = useNavigate()
  const params = useParams()
  const id = Number(params.id)

  function exitDetail() {
	if (window.history.length > 1) {
		navigate(-1)
		return
	}
	navigate('/')
  }

  const [target, setTarget] = useState<Target | null>(null)
  const [results, setResults] = useState<CheckResult[]>([])
  const [finance, setFinance] = useState<FinanceSummary | null>(null)
  const [trackingSummary, setTrackingSummary] = useState<TrackingSummary | null>(null)
  const [trackingEvents, setTrackingEvents] = useState<TrackingEvent[]>([])
  const [trackingSeries, setTrackingSeries] = useState<TrackingSeriesPoint[]>([])
  const [subscriptionSummary, setSubscriptionSummary] = useState<SubscriptionSummary | null>(null)
  const [subscriptionNodes, setSubscriptionNodes] = useState<SubscriptionNode[]>([])
  const [subscriptionSeries, setSubscriptionSeries] = useState<SubscriptionSeriesPoint[]>([])
  const [subscriptionSort, setSubscriptionSort] = useState<'source' | 'latency' | 'name'>('source')
  const [subscriptionAvailabilityFilter, setSubscriptionAvailabilityFilter] = useState<'all' | 'available' | 'unavailable'>('all')
  const [subscriptionSearch, setSubscriptionSearch] = useState('')
  const [refreshingLatency, setRefreshingLatency] = useState(false)
  const [refreshingNodeMap, setRefreshingNodeMap] = useState<Record<string, boolean>>({})
  const [latencyJobProgress, setLatencyJobProgress] = useState<SubscriptionLatencyJobStatus | null>(null)
  const [subscriptionPaginationEnabled, setSubscriptionPaginationEnabled] = useState(false)
  const [subscriptionPaginationTouched, setSubscriptionPaginationTouched] = useState(false)
  const [subscriptionPageSize, setSubscriptionPageSize] = useState(NODE_DEFAULT_PAGE_SIZE)
  const [subscriptionPage, setSubscriptionPage] = useState(1)
  const [subscriptionRenderCount, setSubscriptionRenderCount] = useState(400)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [onlyAbnormal, setOnlyAbnormal] = useState(false)
  const [logSearch, setLogSearch] = useState('')
  const [visibleLogs, setVisibleLogs] = useState(10)
  const [showAddNodeModal, setShowAddNodeModal] = useState(false)
  const [nodeImportText, setNodeImportText] = useState('')
  const [importingNodes, setImportingNodes] = useState(false)
  const [pendingDeleteNode, setPendingDeleteNode] = useState<SubscriptionNode | null>(null)
  const [deletingNodeFromCard, setDeletingNodeFromCard] = useState(false)
  const [rangePreset, setRangePreset] = useState<'1h' | '6h' | '12h' | '24h' | 'custom'>('24h')
  const [customStart, setCustomStart] = useState<Date | null>(new Date(Date.now() - 24 * 60 * 60 * 1000))
  const [customEnd, setCustomEnd] = useState<Date | null>(new Date())
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [copyDone, setCopyDone] = useState(false)
  const [testingIngest, setTestingIngest] = useState(false)
  const [guideMode, setGuideMode] = useState<'script' | 'inline' | 'manual' | 'vue'>('script')
  const [userRankSort, setUserRankSort] = useState<'pv' | 'uv' | 'events' | 'recent'>('pv')
  const [deviceRankSort, setDeviceRankSort] = useState<'pv' | 'uv' | 'events' | 'recent'>('pv')
  const [userRankSearch, setUserRankSearch] = useState('')
  const [deviceRankSearch, setDeviceRankSearch] = useState('')
  const startPickerRef = useRef<any>(null)
  const endPickerRef = useRef<any>(null)
  const lastSavedEditFormRef = useRef('')
  const drawerMaskPressRef = useRef(false)

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
    type: 'site',
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
	protocol: 'tcp' as PortProtocol,
	udp_mode: 'send_only' as UDPMode,
	udp_payload: 'ping',
	udp_expect: '',
	latency_concurrency: 20,
	latency_timeout_ms: 1200,
	e2e_timeout_ms: 6000,
	fetch_timeout_ms: 20000,
	fetch_retries: 2,
	fetch_proxy_url: '',
	fetch_user_agent: DEFAULT_SUB_FETCH_UA,
	fetch_cookie: '',
	latency_probe_count: 3,
	latency_interval_sec: 300,
	weight_domestic: 0.3,
	weight_overseas: 0.7,
	probe_urls_domestic_text: 'https://connectivitycheck.platform.hicloud.com/generate_204\nhttps://www.qq.com/favicon.ico',
	probe_urls_overseas_text: 'https://www.google.com/generate_204\nhttps://cp.cloudflare.com/generate_204',
	singbox_path: 'sing-box',
	manual_expire_at: '',
	price_input: '0',
	currency: 'CNY',
	billing_cycle: 'monthly',
	node_uris_text: '',
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
	  const subCfg = readSubscriptionConfig(targetData.config_json)
	  const nextEditForm = {
        name: targetData.name,
		type: normalizeType(targetData.type),
        endpoint: targetData.endpoint,
        interval_sec: targetData.interval_sec,
        timeout_ms: targetData.timeout_ms,
        enabled: targetData.enabled,
        api_key: readAPIKey(targetData.config_json),
		...readTrackingConfig(targetData.config_json),
		...readPortConfig(targetData.config_json),
		...subCfg,
		probe_urls_domestic_text: subCfg.probe_urls_domestic.join('\n'),
		probe_urls_overseas_text: subCfg.probe_urls_overseas.join('\n'),
		singbox_path: subCfg.singbox_path,
		manual_expire_at: subCfg.manual_expire_at,
		price_input: formatPriceInput(subCfg.price),
		node_uris_text: subCfg.node_uris.join('\n'),
	  }
	  setEditForm(nextEditForm)
	  lastSavedEditFormRef.current = JSON.stringify(nextEditForm)
      setResults(rows)
	  if (targetData.type === 'ai' || targetData.type === 'api') {
		const financeSummary = await api<FinanceSummary>(`/api/targets/${id}/finance`, undefined, token)
		setFinance(financeSummary)
		setTrackingSummary(null)
		setTrackingEvents([])
		setTrackingSeries([])
		setSubscriptionSummary(null)
		setSubscriptionNodes([])
		setSubscriptionSeries([])
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
		setSubscriptionSummary(null)
		setSubscriptionNodes([])
		setSubscriptionSeries([])
	  } else if (targetData.type === 'subscription' || targetData.type === 'node_group') {
		const [summary, nodes] = await Promise.all([
			api<SubscriptionSummary>(`/api/targets/${id}/subscription/summary`, undefined, token),
			api<SubscriptionNode[]>(`/api/targets/${id}/subscription/nodes?sort=${subscriptionSort}&search=${encodeURIComponent(subscriptionSearch)}`, undefined, token),
		])
		setSubscriptionSummary(summary)
		setSubscriptionNodes(nodes)
		setFinance(null)
		setTrackingSummary(null)
		setTrackingEvents([])
		setTrackingSeries([])
		setSubscriptionSeries([])
	  } else {
		setFinance(null)
		setTrackingSummary(null)
		setTrackingEvents([])
		setTrackingSeries([])
		setSubscriptionSummary(null)
		setSubscriptionNodes([])
		setSubscriptionSeries([])
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
	const key = getTargetDetailScrollKey(id)
	const raw = sessionStorage.getItem(key)
	if (!raw) return
	sessionStorage.removeItem(key)
	const top = Number(raw)
	if (!Number.isFinite(top) || top < 0) return
	window.requestAnimationFrame(() => {
		window.scrollTo({ top, behavior: 'auto' })
	})
  }, [id])

  useEffect(() => {
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return
		if (confirmDelete) {
			setConfirmDelete(false)
			return
		}
		if (editing) {
			event.preventDefault()
			setEditing(false)
			return
		}
		event.preventDefault()
		exitDetail()
	}
	window.addEventListener('keydown', onKeyDown)
	return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmDelete, editing, navigate])

  useEffect(() => {
	setSubscriptionPaginationTouched(false)
	setSubscriptionPaginationEnabled(false)
	setSubscriptionPage(1)
  }, [id])

  useEffect(() => {
	if (editing || saving || deleting) return
	const timer = window.setInterval(() => {
		void loadDetail()
	}, 30_000)
	return () => window.clearInterval(timer)
  }, [id, token, rangePreset, subscriptionSort, subscriptionSearch, editing, saving, deleting])

  useEffect(() => {
	const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
	return () => window.clearInterval(timer)
  }, [])

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

  useEffect(() => {
	if (!Number.isFinite(id) || id <= 0) return
	if (target?.type !== 'subscription' && target?.type !== 'node_group') return
	setRefreshingLatency(false)
	setRefreshingNodeMap({})
	setLatencyJobProgress(null)
	void loadSubscriptionNodes().catch((err) => setError((err as Error).message))
  }, [id, target?.type, subscriptionSort, subscriptionSearch, token])

  useEffect(() => {
	if (!Number.isFinite(id) || id <= 0) return
	if (target?.type !== 'subscription' && target?.type !== 'node_group') return
	void loadSubscriptionSeries().catch((err) => setError((err as Error).message))
  }, [id, target?.type, token, rangePreset, customStart, customEnd])

  const filteredSubscriptionNodes = useMemo(() => {
	if (subscriptionAvailabilityFilter === 'all') return subscriptionNodes
	const wantAvailable = subscriptionAvailabilityFilter === 'available'
	return subscriptionNodes.filter((node) => isSubscriptionNodeAvailable(node) === wantAvailable)
  }, [subscriptionNodes, subscriptionAvailabilityFilter])

  useEffect(() => {
	if (target?.type !== 'subscription' && target?.type !== 'node_group') return
	if (subscriptionPaginationTouched) return
	setSubscriptionPaginationEnabled(subscriptionNodes.length > NODE_VIRTUAL_THRESHOLD)
  }, [subscriptionNodes.length, subscriptionPaginationTouched, target?.type])

  useEffect(() => {
	setSubscriptionPage(1)
  }, [subscriptionSearch, subscriptionSort, subscriptionAvailabilityFilter, subscriptionPageSize])

  const subscriptionTotalPages = useMemo(() => {
	if (!subscriptionPaginationEnabled) return 1
	return Math.max(1, Math.ceil(filteredSubscriptionNodes.length / subscriptionPageSize))
  }, [filteredSubscriptionNodes.length, subscriptionPageSize, subscriptionPaginationEnabled])

  useEffect(() => {
	setSubscriptionPage((prev) => Math.min(Math.max(1, prev), subscriptionTotalPages))
  }, [subscriptionTotalPages])

  const pagedSubscriptionNodes = useMemo(() => {
	if (!subscriptionPaginationEnabled) return filteredSubscriptionNodes
	const start = (subscriptionPage - 1) * subscriptionPageSize
	return filteredSubscriptionNodes.slice(start, start + subscriptionPageSize)
  }, [filteredSubscriptionNodes, subscriptionPage, subscriptionPageSize, subscriptionPaginationEnabled])

  useEffect(() => {
	if (subscriptionPaginationEnabled) {
		setSubscriptionRenderCount(filteredSubscriptionNodes.length)
		return
	}
	if (filteredSubscriptionNodes.length <= NODE_VIRTUAL_THRESHOLD) {
		setSubscriptionRenderCount(filteredSubscriptionNodes.length)
		return
	}
	setSubscriptionRenderCount(400)
	let cancelled = false
	const step = () => {
		if (cancelled) return
		setSubscriptionRenderCount((prev) => {
			if (prev >= filteredSubscriptionNodes.length) return prev
			const next = Math.min(prev + 400, filteredSubscriptionNodes.length)
			if (next < filteredSubscriptionNodes.length) {
				setTimeout(step, 16)
			}
			return next
		})
	}
	setTimeout(step, 16)
	return () => {
		cancelled = true
	}
  }, [filteredSubscriptionNodes, subscriptionPaginationEnabled])

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

  async function saveEditConfig() {
    if (!Number.isFinite(id) || id <= 0) return
	if (editForm.type === 'ai' && !editForm.api_key.trim()) {
		setError('AI中转站类型必须填写 API Key')
		return
	}
	if (editForm.type === 'tracking' && !editForm.write_key.trim()) {
		setError('埋点类型必须填写 write key')
		return
	}
	if ((editForm.type === 'subscription' || editForm.type === 'node_group') && editForm.latency_concurrency <= 0) {
		setError('订阅测速并发必须大于 0')
		return
	}
	if ((editForm.type === 'subscription' || editForm.type === 'node_group') && editForm.latency_probe_count <= 0) {
		setError('单节点探测次数必须大于 0')
		return
	}
	if ((editForm.type === 'subscription' || editForm.type === 'node_group') && editForm.e2e_timeout_ms <= 0) {
		setError('E2E 超时必须大于 0')
		return
	}
	if ((editForm.type === 'subscription' || editForm.type === 'node_group') && editForm.fetch_timeout_ms <= 0) {
		setError('订阅拉取超时必须大于 0')
		return
	}
	if ((editForm.type === 'subscription' || editForm.type === 'node_group') && editForm.fetch_retries < 0) {
		setError('订阅拉取重试次数不能小于 0')
		return
	}
	if ((editForm.type === 'subscription' || editForm.type === 'node_group') && editForm.latency_interval_sec < 0) {
		setError('自动测速间隔不能小于 0（0 表示不定时测速）')
		return
	}
	if (editForm.type === 'subscription' && editForm.interval_sec < 0) {
		setError('订阅拉取间隔不能小于 0（0 表示不定时拉取）')
		return
	}
	const parsedPrice = parsePriceInput(editForm.price_input)
	if (editForm.type === 'subscription' && parsedPrice < 0) {
		setError('价格不能小于 0')
		return
	}
	if ((editForm.type === 'subscription' || editForm.type === 'node_group') && (editForm.weight_domestic < 0 || editForm.weight_overseas < 0 || (editForm.weight_domestic + editForm.weight_overseas) <= 0)) {
		setError('国内/海外权重需大于等于0且总和大于0')
		return
	}
	if (editForm.type === 'port' && editForm.protocol === 'udp' && editForm.udp_mode === 'request_response' && !editForm.udp_expect.trim()) {
		setError('UDP 校验回包模式下请填写期望回包')
		return
	}
	const normalizedType = normalizeType(editForm.type)
	const payload = {
		...editForm,
		type: normalizedType,
		endpoint: normalizedType === 'tracking' ? 'tracking://ingest' : (normalizedType === 'node_group' ? 'node-group://manual' : editForm.endpoint),
		interval_sec: normalizedType === 'tracking' ? 60 : (normalizedType === 'node_group' ? 0 : editForm.interval_sec),
		timeout_ms: normalizedType === 'tracking' ? 5000 : (normalizedType === 'node_group' ? 5000 : editForm.timeout_ms),
		config_json: normalizedType === 'ai'
		  ? JSON.stringify({ api_key: editForm.api_key.trim() })
		  : ((normalizedType === 'subscription' || normalizedType === 'node_group')
			  ? JSON.stringify({
				  latency_concurrency: editForm.latency_concurrency,
				  latency_timeout_ms: editForm.latency_timeout_ms,
				  e2e_timeout_ms: editForm.e2e_timeout_ms,
				  fetch_timeout_ms: editForm.fetch_timeout_ms,
				  fetch_retries: editForm.fetch_retries,
				  fetch_proxy_url: editForm.fetch_proxy_url.trim(),
				  fetch_user_agent: editForm.fetch_user_agent.trim() || DEFAULT_SUB_FETCH_UA,
				  fetch_cookie: editForm.fetch_cookie.trim(),
				  latency_probe_count: editForm.latency_probe_count,
				  latency_interval_sec: editForm.latency_interval_sec,
				  weight_domestic: editForm.weight_domestic,
				  weight_overseas: editForm.weight_overseas,
				  probe_urls_domestic: editForm.probe_urls_domestic_text.split('\n').map((x) => x.trim()).filter(Boolean),
				  probe_urls_overseas: editForm.probe_urls_overseas_text.split('\n').map((x) => x.trim()).filter(Boolean),
				  singbox_path: editForm.singbox_path.trim() || 'sing-box',
				  manual_expire_at: normalizedType === 'subscription' ? editForm.manual_expire_at.trim() : '',
				  price: normalizedType === 'subscription' ? Math.max(0, parsedPrice) : 0,
				  currency: normalizedType === 'subscription' ? (editForm.currency.trim().toUpperCase() || 'CNY') : 'CNY',
				  billing_cycle: normalizedType === 'subscription' ? editForm.billing_cycle : 'monthly',
				  node_uris: normalizedType === 'node_group' ? editForm.node_uris_text.split('\n').map((x) => x.trim()).filter(Boolean) : [],
				})
			  : (normalizedType === 'port'
			  ? JSON.stringify({
				  protocol: editForm.protocol,
				  udp_mode: editForm.udp_mode,
				  udp_payload: editForm.udp_payload.trim() || 'ping',
				  udp_expect: editForm.udp_expect.trim(),
			  })
			  : (normalizedType === 'tracking'
			  ? JSON.stringify({
				  write_key: editForm.write_key.trim(),
				  metric_mode: editForm.metric_mode,
				  uv_identity: editForm.uv_identity,
				  user_group_mode: editForm.user_group_mode,
				  inactive_threshold_min: editForm.inactive_threshold_min,
			  })
			  : '{}'))),
	}
    setSaving(true)
    try {
      await api(`/api/targets/${id}`, {
        method: 'PUT',
		body: JSON.stringify(payload),
      }, token)
	  lastSavedEditFormRef.current = JSON.stringify(editForm)
	  setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
	if (!editing || saving) return
	const signature = JSON.stringify(editForm)
	if (!lastSavedEditFormRef.current) {
		lastSavedEditFormRef.current = signature
		return
	}
	if (signature === lastSavedEditFormRef.current) return
	const timer = window.setTimeout(() => {
		void saveEditConfig()
	}, 700)
	return () => window.clearTimeout(timer)
  }, [editing, editForm, saving])

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
  const isSubscriptionTarget = target?.type === 'subscription' || target?.type === 'node_group'
  const trackingConfig = useMemo(() => readTrackingConfig(target?.config_json), [target?.config_json])
  const subscriptionConfig = useMemo(() => readSubscriptionConfig(target?.config_json), [target?.config_json])
  const detailLastRunAt = isTrackingTarget
	? trackingSummary?.last_event_at
	: latest?.checked_at
  const detailIntervalSec = target ? getEffectiveCheckIntervalSec(target) : 0
  const detailNextRun = target && target.type !== 'tracking'
	? formatNextRun(detailLastRunAt, detailIntervalSec, nowTick)
	: '--'
  const guidePublicOrigin = useMemo(() => {
	if (typeof window !== 'undefined' && window.location?.origin) {
	  return window.location.origin
	}
	return API_BASE
  }, [])
  const trackingSnippet = useMemo(() => buildTrackingSnippet(trackingConfig.write_key, guidePublicOrigin), [trackingConfig.write_key, guidePublicOrigin])
  const trackingScriptTagSnippet = useMemo(() => buildTrackingScriptTagSnippet(trackingConfig.write_key, guidePublicOrigin), [trackingConfig.write_key, guidePublicOrigin])
  const trackingManualSnippet = useMemo(() => buildTrackingManualSnippet(trackingConfig.write_key, guidePublicOrigin), [trackingConfig.write_key, guidePublicOrigin])
  const trackingVueSnippet = useMemo(() => buildTrackingVueSnippet(trackingConfig.write_key, guidePublicOrigin), [trackingConfig.write_key, guidePublicOrigin])
  const guideCode = useMemo(() => {
	if (guideMode === 'inline') return trackingSnippet
	if (guideMode === 'manual') return trackingManualSnippet
	if (guideMode === 'vue') return trackingVueSnippet
	return trackingScriptTagSnippet
  }, [guideMode, trackingManualSnippet, trackingScriptTagSnippet, trackingSnippet, trackingVueSnippet])
  const guideRows = guideMode === 'script' ? 3 : (guideMode === 'manual' ? 14 : 18)
  const latencyProgressPercent = useMemo(() => {
	if (!latencyJobProgress || latencyJobProgress.total <= 0) return 0
	return Math.min(100, Math.max(0, Math.round((latencyJobProgress.done / latencyJobProgress.total) * 100)))
  }, [latencyJobProgress])
  const visibleSubscriptionNodes = useMemo(() => {
	if (subscriptionPaginationEnabled) return pagedSubscriptionNodes
	if (filteredSubscriptionNodes.length <= NODE_VIRTUAL_THRESHOLD) return filteredSubscriptionNodes
	return filteredSubscriptionNodes.slice(0, subscriptionRenderCount)
  }, [filteredSubscriptionNodes, pagedSubscriptionNodes, subscriptionPaginationEnabled, subscriptionRenderCount])
  const availableSubscriptionCount = useMemo(() => {
	return subscriptionNodes.reduce((count, node) => {
		if (isSubscriptionNodeAvailable(node)) return count + 1
		return count
	}, 0)
  }, [subscriptionNodes])
  const isNodeGroupTarget = target?.type === 'node_group'
  const nodeGroupSeriesChart = useMemo(() => {
	const times = subscriptionSeries.map((item) => new Date(item.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
	return {
		times,
		availableNodes: subscriptionSeries.map((item) => item.available_nodes ?? 0),
		availability: subscriptionSeries.map((item) => item.availability ?? 0),
	}
  }, [subscriptionSeries])
  const nodeGroupTotal = subscriptionSummary?.node_total ?? subscriptionNodes.length
  const nodeGroupAvailability = nodeGroupTotal > 0 ? (availableSubscriptionCount / nodeGroupTotal) * 100 : 0

  async function loadSubscriptionNodes() {
	if (!Number.isFinite(id) || id <= 0) return
	const rows = await api<SubscriptionNode[]>(`/api/targets/${id}/subscription/nodes?sort=${subscriptionSort}&search=${encodeURIComponent(subscriptionSearch)}`, undefined, token)
	setSubscriptionNodes(rows)
  }

  async function loadSubscriptionSeries() {
	if (!Number.isFinite(id) || id <= 0) return
	if (rangeInvalid) {
		setSubscriptionSeries([])
		return
	}
	const startISO = new Date(rangeWindow.startTs).toISOString()
	const endISO = new Date(rangeWindow.endTs).toISOString()
	const rows = await api<SubscriptionSeriesPoint[]>(`/api/targets/${id}/subscription/series?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`, undefined, token)
	setSubscriptionSeries(rows)
  }

	function applySubscriptionNodeResult(node?: SubscriptionLatencyJobNode) {
		if (!node) return
		setSubscriptionNodes((prev) => {
			let hit = false
			const next = prev.map((row) => {
				if (row.node_uid !== node.node_uid) return row
				hit = true
				return {
					...row,
					last_latency_ms: typeof node.latency_ms === 'number' ? node.latency_ms : undefined,
					last_latency_checked_at: node.checked_at,
				}
			})
			return hit ? next : prev
		})
		setRefreshingNodeMap((prev) => {
			if (!prev[node.node_uid]) return prev
			const next = { ...prev }
			delete next[node.node_uid]
			return next
		})
	}

	async function streamSubscriptionLatencyJob(jobID: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const streamURL = `${API_BASE}/api/targets/${id}/subscription/latency/jobs/${encodeURIComponent(jobID)}/events?access_token=${encodeURIComponent(token)}`
			const es = new EventSource(streamURL)
			let closed = false

			const close = () => {
				if (!closed) {
					es.close()
					closed = true
				}
			}

			const onJobEvent = (raw: MessageEvent) => {
				try {
					const payload = JSON.parse(raw.data) as SubscriptionLatencyJobEvent
					if (payload.job) {
						setLatencyJobProgress(payload.job)
					}
					if (payload.node) {
						applySubscriptionNodeResult(payload.node)
					}
					if (payload.job?.status === 'done' || payload.type === 'done') {
						close()
						resolve()
						return
					}
					if (payload.job?.status === 'failed' || payload.type === 'failed') {
						close()
						reject(new Error(payload.job?.message || '订阅测速任务失败'))
					}
				} catch {
					close()
					reject(new Error('订阅测速流解析失败'))
				}
			}

			es.addEventListener('snapshot', onJobEvent)
			es.addEventListener('node_result', onJobEvent)
			es.addEventListener('progress', onJobEvent)
			es.addEventListener('done', onJobEvent)
			es.addEventListener('failed', onJobEvent)
			es.onerror = () => {
				close()
				reject(new Error('订阅测速流中断'))
			}
		})
	}

	async function pollSubscriptionLatencyJob(jobID: string) {
		for (let i = 0; i < 300; i += 1) {
			const status = await api<SubscriptionLatencyJobStatus>(`/api/targets/${id}/subscription/latency/jobs/${encodeURIComponent(jobID)}`, undefined, token)
			setLatencyJobProgress(status)
			await loadSubscriptionNodes()
			if (status.status === 'done') return
			if (status.status === 'failed') {
				throw new Error(status.message || '订阅测速任务失败')
			}
			await new Promise((resolve) => setTimeout(resolve, 1200))
		}
		throw new Error('订阅测速轮询超时')
	}

  async function handleRefreshSubscriptionLatency() {
	if (!Number.isFinite(id) || id <= 0) return
	setError('')
	setRefreshingLatency(true)
	setLatencyJobProgress(null)
	const pendingMap: Record<string, boolean> = {}
	for (const row of subscriptionNodes) {
		pendingMap[row.node_uid] = true
	}
	setRefreshingNodeMap(pendingMap)
	try {
	  const job = await api<SubscriptionLatencyJobStatus>(`/api/targets/${id}/subscription/latency/jobs`, { method: 'POST' }, token)
	  setLatencyJobProgress(job)
	  try {
		await streamSubscriptionLatencyJob(job.job_id)
	  } catch {
		await pollSubscriptionLatencyJob(job.job_id)
	  }
	  await Promise.all([
		loadSubscriptionNodes(),
		loadSubscriptionSeries(),
		api<SubscriptionSummary>(`/api/targets/${id}/subscription/summary`, undefined, token).then(setSubscriptionSummary),
	  ])
	} catch (err) {
	  setError((err as Error).message)
	} finally {
	  setRefreshingNodeMap({})
	  setLatencyJobProgress(null)
	  setRefreshingLatency(false)
	}
  }

	async function handleCopySubscriptionNode(node: SubscriptionNode) {
	const text = subscriptionNodeCopyText(node)
	try {
		await navigator.clipboard.writeText(text)
		notify.success('节点已复制')
	} catch {
		notify.error('复制失败，请检查剪贴板权限')
	}
  }

	async function handleDeleteNodeFromCard(node: SubscriptionNode, skipConfirm: boolean) {
		if (!isNodeGroupTarget) return
		setDeletingNodeFromCard(true)
		try {
			await api(`/api/targets/${id}/subscription/nodes/${encodeURIComponent(node.node_uid)}`, { method: 'DELETE' }, token)
			notify.success(skipConfirm ? '节点已删除（已跳过确认）' : '节点已删除')
			setPendingDeleteNode(null)
			await Promise.all([
				loadSubscriptionNodes(),
				loadSubscriptionSeries(),
				api<SubscriptionSummary>(`/api/targets/${id}/subscription/summary`, undefined, token).then(setSubscriptionSummary),
			])
		} catch (err) {
			notify.error((err as Error).message || '删除节点失败')
		} finally {
			setDeletingNodeFromCard(false)
		}
	}

  async function handleImportNodeGroupURIs() {
	if (!target || target.type !== 'node_group') return
	const existing = subscriptionConfig.node_uris ?? []
	const incoming = nodeImportText.split('\n').map((x) => x.trim()).filter(Boolean)
	const merged = Array.from(new Set([...existing, ...incoming]))
	setImportingNodes(true)
	setError('')
	try {
		const nextConfig = {
			...subscriptionConfig,
			node_uris: merged,
			manual_expire_at: '',
		}
		await api(`/api/targets/${id}`, {
			method: 'PUT',
			body: JSON.stringify({
				name: target.name,
				type: 'node_group',
				endpoint: target.endpoint || 'node-group://manual',
				interval_sec: 0,
				timeout_ms: 5000,
				enabled: target.enabled,
				config_json: JSON.stringify(nextConfig),
			}),
		}, token)
		setShowAddNodeModal(false)
		await loadDetail()
	} catch (err) {
		setError((err as Error).message)
	} finally {
		setImportingNodes(false)
	}
  }

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
		if (isNodeGroupTarget) {
			return `${first.axisValueLabel}<br/>可用节点数: ${first.data ?? 0}`
		}
        const row = chartSeries.rows[first.dataIndex]
        if (!row) return first.axisValueLabel
        const status = row.success ? '在线' : '异常'
		const latency = row.success ? `${Math.max(0, row.latency_ms)}ms` : '--'
		return `${formatDateTime(row.checked_at)}<br/>状态: ${status}<br/>延迟: ${latency}<br/>错误: ${row.error_msg || '无'}`
	  },
    },
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: {
      type: 'category',
		data: isTrackingTarget ? trackingChart.times : (isNodeGroupTarget ? nodeGroupSeriesChart.times : chartSeries.times),
      axisLabel: { color: '#94a3b8', fontSize: 11 },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    yAxis: {
      type: 'value',
		name: isTrackingTarget ? 'count' : (isNodeGroupTarget ? 'nodes' : 'ms'),
      nameTextStyle: { color: '#94a3b8' },
      axisLabel: { color: '#94a3b8' },
      splitLine: { lineStyle: { color: 'rgba(100,116,139,0.2)' } },
    },
    series: [
      {
		name: isTrackingTarget ? 'PV' : (isNodeGroupTarget ? '可用节点数' : '延迟'),
        type: 'line',
        smooth: true,
        showSymbol: false,
		data: isTrackingTarget ? trackingChart.pv : (isNodeGroupTarget ? nodeGroupSeriesChart.availableNodes : chartSeries.latency),
        lineStyle: { color: '#3b82f6', width: 2 },
        itemStyle: { color: '#3b82f6' },
        areaStyle: { color: 'rgba(59,130,246,0.15)' },
      },
    ],
	}), [chartSeries, isTrackingTarget, isNodeGroupTarget, nodeGroupSeriesChart, trackingChart])

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
		if (isNodeGroupTarget) {
			return `${first.axisValueLabel}<br/>可用性: ${Number(first.data ?? 0).toFixed(1)}%`
		}
        const row = chartSeries.rows[first.dataIndex]
        const status = row?.success ? '在线' : row ? '异常' : '未知'
        return `${first.axisValueLabel}<br/>可用率: ${first.data}%<br/>状态: ${status}`
      },
    },
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: {
      type: 'category',
		data: isTrackingTarget ? trackingChart.times : (isNodeGroupTarget ? nodeGroupSeriesChart.times : chartSeries.times),
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
		name: isTrackingTarget ? 'UV' : (isNodeGroupTarget ? '可用性' : '可用率'),
        type: 'line',
        smooth: true,
        showSymbol: false,
		data: isTrackingTarget ? trackingChart.uv : (isNodeGroupTarget ? nodeGroupSeriesChart.availability : chartSeries.availability),
        lineStyle: { color: '#22c55e', width: 2 },
        itemStyle: { color: '#22c55e' },
        areaStyle: { color: 'rgba(34,197,94,0.12)' },
      },
    ],
	}), [chartSeries, isTrackingTarget, isNodeGroupTarget, nodeGroupSeriesChart, trackingChart])

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
    <div className="workspace detail-workspace">
      <header className="workspace-header">
		<div className="header-main">
          <button type="button" className="back-button" onClick={exitDetail}>
            <ArrowLeft size={16} /> 返回
          </button>
          <h1 className="detail-title">{target?.name ?? '目标详情'}</h1>
		  {target && target.type !== 'tracking' && target.type !== 'node_group' ? (
            <a
              className="endpoint-link"
              href={toVisitURL(target.endpoint)}
              target="_blank"
              rel="noreferrer"
			  onClick={(event) => {
				event.preventDefault()
				void copyTextToClipboard(target.endpoint).then((ok) => {
					if (ok) notify.success('地址已复制')
					else notify.error('复制失败')
				})
			  }}
			  onContextMenu={(event) => {
				event.preventDefault()
				window.open(toVisitURL(target.endpoint), '_blank', 'noopener,noreferrer')
			  }}
			  title="左键复制地址，右键打开"
            >
              {target.endpoint}
            </a>
		  ) : target ? (
			<p className="muted">{target.type === 'node_group' ? '手动节点列表（可在节点列表中添加）' : '被动上报（通过 write key 接入）'}</p>
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
		  <p className="panel-title"><ShieldCheck size={15} /> {isTrackingTarget ? '窗口PV' : (isSubscriptionTarget ? '节点状态' : '窗口可用率')}</p>
		  <p className="panel-value">{loading ? '...' : (isTrackingTarget ? String(windowedTrackingEvents.reduce((sum, item) => sum + item.count, 0)) : (isSubscriptionTarget ? `${availableSubscriptionCount}/${subscriptionSummary?.node_total ?? subscriptionNodes.length}` : `${uptime.toFixed(1)}%`))}</p>
		</article>
        <article className="panel metric-card">
		  <p className="panel-title"><Gauge size={15} /> {isTrackingTarget ? '窗口UV' : (isSubscriptionTarget ? (isNodeGroupTarget ? '可用节点数' : '剩余流量') : '平均延迟')}</p>
		  <p className="panel-value">{loading ? '...' : (isTrackingTarget ? String(new Set(windowedTrackingEvents.map((item) => item.uv_key).filter(Boolean)).size) : (isSubscriptionTarget ? (isNodeGroupTarget ? `${availableSubscriptionCount}` : formatBytes(subscriptionSummary?.remaining_bytes)) : (avgLatency > 0 ? `${avgLatency}ms` : '--')))}</p>
        </article>
        <article className="panel metric-card">
		  <p className="panel-title"><AlertTriangle size={15} /> {isTrackingTarget ? '事件条数' : (isSubscriptionTarget ? (isNodeGroupTarget ? '节点组状态' : '订阅状态') : '失败次数')}</p>
		  <p className={`panel-value ${isSubscriptionTarget ? 'subscription-status-value' : ''}`}>{loading ? '...' : (isTrackingTarget ? String(windowedTrackingEvents.length) : (isSubscriptionTarget ? getSubscriptionStatusText(subscriptionSummary ?? undefined) : String(failureRows.length)))}</p>
        </article>
		<article className="panel metric-card">
		  <p className="panel-title"><Clock3 size={15} /> {isTrackingTarget ? '最后事件' : (isSubscriptionTarget ? (isNodeGroupTarget ? '最近测速' : '最近拉取') : '最后检测')}</p>
		  <p className="panel-value">{loading ? '...' : (isTrackingTarget ? (trackingSummary?.last_event_at ? formatAgo(trackingSummary.last_event_at) : '--') : (isSubscriptionTarget ? (subscriptionSummary?.last_checked_at ? formatAgo(subscriptionSummary.last_checked_at) : '--') : (latest ? formatAgo(latest.checked_at) : '--')))}</p>
		  {!isTrackingTarget ? <p className="muted">{isNodeGroupTarget ? `节点可用性：${nodeGroupAvailability.toFixed(1)}%` : `下次检测：${detailNextRun}`}</p> : null}
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

      <section className={`detail-grid ${isNodeGroupTarget ? 'detail-grid-node-group' : ''}`}>
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
				<h3>{isTrackingTarget ? 'PV趋势' : (isNodeGroupTarget ? '节点可用数趋势' : '延迟趋势')}</h3>
                <span>按悬浮位置查看时点</span>
              </div>
              <ReactECharts option={latencyOption} style={{ height: 220 }} notMerge lazyUpdate />
            </div>
            <div className="chart-panel">
              <div className="panel-head">
				<h3>{isTrackingTarget ? 'UV趋势' : (isNodeGroupTarget ? '可用性趋势' : '可用率趋势')}</h3>
				<span>{isTrackingTarget ? '按时段去重统计' : (isNodeGroupTarget ? '基于节点探测记录' : '累计统计')}</span>
              </div>
              <ReactECharts option={availabilityOption} style={{ height: 220 }} notMerge lazyUpdate />
            </div>
          </div>

        </article>

		{!isNodeGroupTarget ? (
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
					<span>延迟：{row.success ? `${Math.max(0, row.latency_ms)}ms` : '--'}</span>
					<span>错误：{row.error_msg || '无'}</span>
				  </div>
				</div>
			  ))}
            {logsToShow.length === 0 ? <p className="muted">暂无日志</p> : null}
          </div>
        </article>
		) : null}

		{isSubscriptionTarget ? (
		  <article className="panel subscription-panel-full">
			<div className="panel-head">
			  <h3>节点列表</h3>
			  <div className="panel-head-actions">
				<span>可用 {availableSubscriptionCount}/{subscriptionNodes.length}</span>
				{isNodeGroupTarget ? (
				  <button type="button" onClick={() => {
					setNodeImportText('')
					setShowAddNodeModal(true)
				  }}>
					<Plus size={14} /> 添加节点
				  </button>
				) : null}
			  </div>
			</div>
			<div className="log-filters subscription-log-filters">
			  <input value={subscriptionSearch} onChange={(e) => setSubscriptionSearch(e.target.value)} placeholder="搜索节点名称或地址" />
			  <div className="type-chips">
				<button type="button" className={`chip ${subscriptionSort === 'source' ? 'active' : ''}`} onClick={() => setSubscriptionSort('source')}>源顺序</button>
				<button type="button" className={`chip ${subscriptionSort === 'latency' ? 'active' : ''}`} onClick={() => setSubscriptionSort('latency')}>延迟</button>
				<button type="button" className={`chip ${subscriptionSort === 'name' ? 'active' : ''}`} onClick={() => setSubscriptionSort('name')}>名称</button>
				<button type="button" className={`chip ${subscriptionAvailabilityFilter === 'all' ? 'active' : ''}`} onClick={() => setSubscriptionAvailabilityFilter('all')}>全部</button>
				<button type="button" className={`chip ${subscriptionAvailabilityFilter === 'available' ? 'active' : ''}`} onClick={() => setSubscriptionAvailabilityFilter('available')}>仅可用</button>
				<button type="button" className={`chip ${subscriptionAvailabilityFilter === 'unavailable' ? 'active' : ''}`} onClick={() => setSubscriptionAvailabilityFilter('unavailable')}>仅不可用</button>
			  </div>
			  <button type="button" onClick={() => void handleRefreshSubscriptionLatency()} disabled={refreshingLatency}>
				{refreshingLatency ? '测速中...' : '刷新测速'}
			  </button>
			</div>
			<div className="subscription-node-controls">
			  <button
				type="button"
				className={`chip ${subscriptionPaginationEnabled ? 'active' : ''}`}
				onClick={() => {
					setSubscriptionPaginationEnabled((prev) => !prev)
					setSubscriptionPaginationTouched(true)
					setSubscriptionPage(1)
				}}
			  >
				分页 {subscriptionPaginationEnabled ? '开' : '关'}
			  </button>
			</div>
			<p className="muted subscription-config-note">{isNodeGroupTarget
				? `测速配置：并发 ${subscriptionConfig.latency_concurrency}，基线超时 ${subscriptionConfig.latency_timeout_ms}ms，E2E超时 ${subscriptionConfig.e2e_timeout_ms}ms，探测 ${subscriptionConfig.latency_probe_count} 次，间隔 ${subscriptionConfig.latency_interval_sec > 0 ? `${subscriptionConfig.latency_interval_sec}s` : '不定时'}，国内权重 ${subscriptionConfig.weight_domestic.toFixed(2)}，海外权重 ${subscriptionConfig.weight_overseas.toFixed(2)}`
				: `测速配置：并发 ${subscriptionConfig.latency_concurrency}，基线超时 ${subscriptionConfig.latency_timeout_ms}ms，E2E超时 ${subscriptionConfig.e2e_timeout_ms}ms，拉取超时 ${subscriptionConfig.fetch_timeout_ms}ms（重试 ${subscriptionConfig.fetch_retries}），探测 ${subscriptionConfig.latency_probe_count} 次，间隔 ${subscriptionConfig.latency_interval_sec > 0 ? `${subscriptionConfig.latency_interval_sec}s` : '不定时'}，国内权重 ${subscriptionConfig.weight_domestic.toFixed(2)}，海外权重 ${subscriptionConfig.weight_overseas.toFixed(2)}`}</p>
			{refreshingLatency && latencyJobProgress ? (
			  <div className="subscription-progress">
				<p className="muted">测速进度：{latencyJobProgress.done}/{latencyJobProgress.total}（{latencyProgressPercent}%），成功 {latencyJobProgress.success}，失败 {latencyJobProgress.failed}</p>
				<div className="subscription-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={latencyProgressPercent} aria-label="订阅测速进度">
				  <span className="subscription-progress-fill" style={{ width: `${latencyProgressPercent}%` }} />
				</div>
			  </div>
			) : null}
			  {!subscriptionPaginationEnabled && filteredSubscriptionNodes.length > NODE_VIRTUAL_THRESHOLD ? (
			  <p className="muted">节点较多（{subscriptionNodes.length}），已启用增量渲染模式。</p>
			) : null}
			<div className={`subscription-node-grid ${subscriptionNodes.length > NODE_VIRTUAL_THRESHOLD ? 'compact' : ''}`}>
			  {visibleSubscriptionNodes.map((row) => {
				const pending = Boolean(refreshingNodeMap[row.node_uid])
				const state = pending ? 'pending' : nodeLatencyState(row)
				const isDeleteShortcut = isNodeGroupTarget
				const availabilityRaw = typeof row.availability_24h === 'number' ? row.availability_24h : 100
				const availabilityText = `${availabilityRaw.toFixed(1)}%`
				const latencyText = pending
					? '测速中'
					: (typeof row.last_latency_ms === 'number' && row.last_latency_ms >= 0 ? `${row.last_latency_ms}ms` : '--')
				return (
				<article
				  className={`subscription-node-card latency-${state}`}
				  key={row.id}
				  onClick={() => {
					sessionStorage.setItem(getTargetDetailScrollKey(id), String(window.scrollY))
					navigate(`/targets/${id}/subscription/nodes/${encodeURIComponent(row.node_uid)}`)
				  }}
				  onContextMenu={(event) => {
					event.preventDefault()
					if (isDeleteShortcut && event.altKey) {
						if (event.ctrlKey) {
							void handleDeleteNodeFromCard(row, true)
						} else {
							setPendingDeleteNode(row)
						}
						return
					}
					void handleCopySubscriptionNode(row)
				  }}
				>
				  <div className="subscription-node-head">
					<strong>{row.name}</strong>
					<span className="muted">{row.protocol || '-'}</span>
				  </div>
				  <div className="subscription-node-meta">
					<span className={`latency-text ${state === 'error' ? 'latency-error' : state === 'pending' ? 'latency-pending' : ''}`}>延迟 {latencyText}</span>
					<span className="availability-text">可用率 {availabilityText}</span>
				  </div>
				</article>
			  )})}
			</div>
			{subscriptionPaginationEnabled && filteredSubscriptionNodes.length > 0 ? (
			  <div className="subscription-node-pagination">
				<span className="subscription-page-size">每页</span>
				<div className="type-chips subscription-page-size-chips">
				  {[50, 100, 200].map((size) => (
					<button
					  key={size}
					  type="button"
					  className={`chip ${subscriptionPageSize === size ? 'active' : ''}`}
					  onClick={() => setSubscriptionPageSize(size)}
					>
					  {size}
					</button>
				  ))}
				</div>
				<button type="button" onClick={() => setSubscriptionPage((prev) => Math.max(1, prev - 1))} disabled={subscriptionPage <= 1}>上一页</button>
				<span className="muted">第 {subscriptionPage}/{subscriptionTotalPages} 页</span>
				<button type="button" onClick={() => setSubscriptionPage((prev) => Math.min(subscriptionTotalPages, prev + 1))} disabled={subscriptionPage >= subscriptionTotalPages}>下一页</button>
			  </div>
			) : null}
			{subscriptionNodes.length === 0 ? <p className="muted">暂无节点数据</p> : null}
		  </article>
		) : null}

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
		  <p className="muted">当前 API 基址：{API_BASE}</p>
		  <p className="muted">1) 选择接入方式并复制；2) 打开页面触发事件；3) 回到本页刷新查看数据。</p>
		  <p className="muted">跨域时请确保后端 CORS_ALLOW 包含业务站点域名，埋点请求默认不带凭据。</p>
		  <div className="type-chips guide-mode-chips">
			<button type="button" className={`chip ${guideMode === 'script' ? 'active' : ''}`} onClick={() => setGuideMode('script')}>一行引用</button>
			<button type="button" className={`chip ${guideMode === 'inline' ? 'active' : ''}`} onClick={() => setGuideMode('inline')}>内联脚本</button>
			<button type="button" className={`chip ${guideMode === 'manual' ? 'active' : ''}`} onClick={() => setGuideMode('manual')}>手动上报</button>
			<button type="button" className={`chip ${guideMode === 'vue' ? 'active' : ''}`} onClick={() => setGuideMode('vue')}>Vue3接入</button>
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
		<div
		  className="drawer-mask"
		  role="dialog"
		  aria-modal="true"
		  onMouseDown={(e) => {
			drawerMaskPressRef.current = e.target === e.currentTarget
		  }}
		  onClick={() => {
			if (!drawerMaskPressRef.current) return
			setEditing(false)
		  }}
		>
		  <aside
			className="drawer panel"
			onMouseDown={() => {
				drawerMaskPressRef.current = false
			}}
			onClick={(e) => e.stopPropagation()}
		  >
            <div className="panel-head">
              <h3>编辑监控配置</h3>
              <button type="button" className="icon-button" onClick={() => setEditing(false)}>
                <X size={16} />
              </button>
            </div>

            <form
			  className="target-form"
			  onSubmit={(e) => {
				e.preventDefault()
			  }}
			>
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
			  {editForm.type !== 'tracking' && editForm.type !== 'node_group' ? (
				<label>
				  地址
				  <input
					value={editForm.endpoint}
					onChange={(e) => setEditForm((prev) => ({ ...prev, endpoint: e.target.value }))}
					required
				  />
				</label>
			  ) : null}
			  {editForm.type === 'ai' ? (
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
			  {editForm.type === 'subscription' ? (
				<>
				  <details className="config-group">
					<summary>订阅配置</summary>
					<div className="config-group-body">
					  <div className="form-row">
						<label>
						  订阅拉取间隔(秒，0=不定时)
						  <NumberStepperInput
							min={0}
							value={editForm.interval_sec}
							onChange={(e) => {
								const next = Number(e.target.value)
								if (!Number.isFinite(next)) return
								setEditForm((prev) => ({ ...prev, interval_sec: Math.max(0, Math.round(next)) }))
							}}
							required
						  />
						</label>
						<label>
						  订阅拉取超时(ms)
						  <NumberStepperInput
							min={1000}
							value={editForm.fetch_timeout_ms}
							onChange={(e) => setEditForm((prev) => ({ ...prev, fetch_timeout_ms: Number(e.target.value) || 20000 }))}
							required
						  />
						</label>
						<label>
						  超时(ms)
						  <NumberStepperInput
							min={200}
							value={editForm.timeout_ms}
							onChange={(e) => setEditForm((prev) => ({ ...prev, timeout_ms: Number(e.target.value) || 5000 }))}
							required
						  />
						</label>
						<label>
						  拉取重试次数
						  <NumberStepperInput
							min={0}
							max={5}
							value={editForm.fetch_retries}
							onChange={(e) => setEditForm((prev) => ({ ...prev, fetch_retries: Math.max(0, Math.min(5, Number(e.target.value) || 0)) }))}
							required
						  />
						</label>
					  </div>
					  <label>
						订阅拉取代理（可选）
						<input value={editForm.fetch_proxy_url} onChange={(e) => setEditForm((prev) => ({ ...prev, fetch_proxy_url: e.target.value }))} placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7890" />
					  </label>
					  <label>
						订阅拉取 UA
						<input value={editForm.fetch_user_agent} onChange={(e) => setEditForm((prev) => ({ ...prev, fetch_user_agent: e.target.value }))} placeholder={DEFAULT_SUB_FETCH_UA} />
					  </label>
					  <label>
						订阅拉取 Cookie（可选）
						<AutoGrowTextarea value={editForm.fetch_cookie} onChange={(e) => setEditForm((prev) => ({ ...prev, fetch_cookie: e.target.value }))} rows={2} />
					  </label>
					</div>
				  </details>

				  <details className="config-group">
					<summary>节点列表配置</summary>
					<div className="config-group-body">
					  <div className="form-row">
						<label>
						  测速并发（大于等于1）
						  <NumberStepperInput
							min={1}
							value={editForm.latency_concurrency}
							onChange={(e) => setEditForm((prev) => ({ ...prev, latency_concurrency: Number(e.target.value) || 1 }))}
							required
						  />
						</label>
						<label>
						  测速超时(ms)
						  <NumberStepperInput
							min={100}
							value={editForm.latency_timeout_ms}
							onChange={(e) => setEditForm((prev) => ({ ...prev, latency_timeout_ms: Number(e.target.value) || 1200 }))}
							required
						  />
						</label>
						<label>
						  E2E超时(ms)
						  <NumberStepperInput
							min={500}
							value={editForm.e2e_timeout_ms}
							onChange={(e) => setEditForm((prev) => ({ ...prev, e2e_timeout_ms: Number(e.target.value) || 6000 }))}
							required
						  />
						</label>
						<label>
						  单节点探测次数
						  <NumberStepperInput
							min={1}
							value={editForm.latency_probe_count}
							onChange={(e) => setEditForm((prev) => ({ ...prev, latency_probe_count: Number(e.target.value) || 3 }))}
							required
						  />
						</label>
						<label>
						  自动测速间隔(秒，0=不定时)
						  <NumberStepperInput
							min={0}
							value={editForm.latency_interval_sec}
							onChange={(e) => {
								const next = Number(e.target.value)
								setEditForm((prev) => ({ ...prev, latency_interval_sec: Number.isFinite(next) ? Math.max(0, Math.round(next)) : 0 }))
							}}
							required
						  />
						</label>
						<label>
						  国内权重
						  <NumberStepperInput
							min={0}
							step={0.1}
							value={editForm.weight_domestic}
							onChange={(e) => setEditForm((prev) => ({ ...prev, weight_domestic: Math.max(0, Number(e.target.value) || 0) }))}
							required
						  />
						</label>
						<label>
						  海外权重
						  <NumberStepperInput
							min={0}
							step={0.1}
							value={editForm.weight_overseas}
							onChange={(e) => setEditForm((prev) => ({ ...prev, weight_overseas: Math.max(0, Number(e.target.value) || 0) }))}
							required
						  />
						</label>
					  </div>
					  <label>
						国内测速URL（每行一个）
						<AutoGrowTextarea value={editForm.probe_urls_domestic_text} onChange={(e) => setEditForm((prev) => ({ ...prev, probe_urls_domestic_text: e.target.value }))} rows={3} />
					  </label>
					  <label>
						海外测速URL（每行一个）
						<AutoGrowTextarea value={editForm.probe_urls_overseas_text} onChange={(e) => setEditForm((prev) => ({ ...prev, probe_urls_overseas_text: e.target.value }))} rows={3} />
					  </label>
					  <label>
						sing-box 路径
						<input value={editForm.singbox_path} onChange={(e) => setEditForm((prev) => ({ ...prev, singbox_path: e.target.value }))} placeholder="sing-box" />
					  </label>
					</div>
				  </details>

				  <details className="config-group">
					<summary>价格和期限配置</summary>
					<div className="config-group-body">
					  <div className="form-row">
						<label>
						  价格
						  <NumberStepperInput
							min={0}
							step={0.01}
							value={editForm.price_input}
							onChange={(e) => {
								const raw = e.target.value
								if (raw === '' || /^\d+(?:\.\d{0,2})?$/.test(raw)) {
									setEditForm((prev) => ({ ...prev, price_input: raw }))
								}
							}}
						  />
						</label>
						<label>
						  货币
						  <FormDropdown
							value={editForm.currency}
							options={SUBSCRIPTION_CURRENCY_OPTIONS}
							onChange={(next) => setEditForm((prev) => ({ ...prev, currency: next.toUpperCase() }))}
							ariaLabel="选择货币"
						  />
						</label>
						<label>
						  计费周期
						  <FormDropdown
							value={editForm.billing_cycle}
							options={SUBSCRIPTION_BILLING_CYCLE_OPTIONS}
							onChange={(next) => setEditForm((prev) => ({ ...prev, billing_cycle: next }))}
							ariaLabel="选择计费周期"
						  />
						</label>
					  </div>
					  <label>
						手动到期时间（可选）
						<input
							type="datetime-local"
							value={editForm.manual_expire_at}
							onChange={(e) => setEditForm((prev) => ({ ...prev, manual_expire_at: e.target.value }))}
							onClick={(e) => openDateTimePicker(e.currentTarget)}
							onFocus={(e) => openDateTimePicker(e.currentTarget)}
						/>
					  </label>
					</div>
				  </details>
				</>
			  ) : editForm.type === 'node_group' ? (
				<>
				  <label>
					节点 URI 列表（每行一个，可选）
					<AutoGrowTextarea value={editForm.node_uris_text} onChange={(e) => setEditForm((prev) => ({ ...prev, node_uris_text: e.target.value }))} rows={5} />
				  </label>
				  <div className="form-row">
					<label>
					  测速并发（大于等于1）
					  <NumberStepperInput
						min={1}
						value={editForm.latency_concurrency}
						onChange={(e) => setEditForm((prev) => ({ ...prev, latency_concurrency: Number(e.target.value) || 1 }))}
						required
					  />
					</label>
					<label>
					  测速超时(ms)
					  <NumberStepperInput
						min={100}
						value={editForm.latency_timeout_ms}
						onChange={(e) => setEditForm((prev) => ({ ...prev, latency_timeout_ms: Number(e.target.value) || 1200 }))}
						required
					  />
					</label>
					<label>
					  E2E超时(ms)
					  <NumberStepperInput
						min={500}
						value={editForm.e2e_timeout_ms}
						onChange={(e) => setEditForm((prev) => ({ ...prev, e2e_timeout_ms: Number(e.target.value) || 6000 }))}
						required
					  />
					</label>
					<label>
					  单节点探测次数
					  <NumberStepperInput
						min={1}
						value={editForm.latency_probe_count}
						onChange={(e) => setEditForm((prev) => ({ ...prev, latency_probe_count: Number(e.target.value) || 3 }))}
						required
					  />
					</label>
					<label>
					  自动测速间隔(秒，0=不定时)
					  <NumberStepperInput
						min={0}
						value={editForm.latency_interval_sec}
						onChange={(e) => {
							const next = Number(e.target.value)
							setEditForm((prev) => ({ ...prev, latency_interval_sec: Number.isFinite(next) ? Math.max(0, Math.round(next)) : 0 }))
						}}
						required
					  />
					</label>
					<label>
					  国内权重
					  <NumberStepperInput
						min={0}
						step={0.1}
						value={editForm.weight_domestic}
						onChange={(e) => setEditForm((prev) => ({ ...prev, weight_domestic: Math.max(0, Number(e.target.value) || 0) }))}
						required
					  />
					</label>
					<label>
					  海外权重
					  <NumberStepperInput
						min={0}
						step={0.1}
						value={editForm.weight_overseas}
						onChange={(e) => setEditForm((prev) => ({ ...prev, weight_overseas: Math.max(0, Number(e.target.value) || 0) }))}
						required
					  />
					</label>
				  </div>
				  <label>
					国内测速URL（每行一个）
					<AutoGrowTextarea value={editForm.probe_urls_domestic_text} onChange={(e) => setEditForm((prev) => ({ ...prev, probe_urls_domestic_text: e.target.value }))} rows={3} />
				  </label>
				  <label>
					海外测速URL（每行一个）
					<AutoGrowTextarea value={editForm.probe_urls_overseas_text} onChange={(e) => setEditForm((prev) => ({ ...prev, probe_urls_overseas_text: e.target.value }))} rows={3} />
				  </label>
				  <label>
					sing-box 路径
					<input value={editForm.singbox_path} onChange={(e) => setEditForm((prev) => ({ ...prev, singbox_path: e.target.value }))} placeholder="sing-box" />
				  </label>
				</>
			  ) : null}
			  {editForm.type === 'port' ? (
				<>
				  <label>
					协议
					<div className="type-chips">
					  <button type="button" className={`chip ${editForm.protocol === 'tcp' ? 'active' : ''}`} onClick={() => setEditForm((prev) => ({ ...prev, protocol: 'tcp' }))}>TCP</button>
					  <button type="button" className={`chip ${editForm.protocol === 'udp' ? 'active' : ''}`} onClick={() => setEditForm((prev) => ({ ...prev, protocol: 'udp' }))}>UDP</button>
					</div>
				  </label>
				  {editForm.protocol === 'udp' ? (
					<>
					  <label>
						UDP 模式
						<div className="type-chips">
						  <button type="button" className={`chip ${editForm.udp_mode === 'send_only' ? 'active' : ''}`} onClick={() => setEditForm((prev) => ({ ...prev, udp_mode: 'send_only' }))}>仅发送</button>
						  <button type="button" className={`chip ${editForm.udp_mode === 'request_response' ? 'active' : ''}`} onClick={() => setEditForm((prev) => ({ ...prev, udp_mode: 'request_response' }))}>发送并校验回包</button>
						</div>
					  </label>
					  <label>
						UDP 发送内容
						<input value={editForm.udp_payload} onChange={(e) => setEditForm((prev) => ({ ...prev, udp_payload: e.target.value }))} placeholder="ping" />
					  </label>
					  {editForm.udp_mode === 'request_response' ? (
						<label>
						  期望回包（包含）
						  <input value={editForm.udp_expect} onChange={(e) => setEditForm((prev) => ({ ...prev, udp_expect: e.target.value }))} placeholder="pong" required />
						</label>
					  ) : null}
					</>
				  ) : null}
				</>
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
					<NumberStepperInput
					  min={0}
					  value={editForm.inactive_threshold_min}
					  onChange={(e) => setEditForm((prev) => ({ ...prev, inactive_threshold_min: Math.max(0, Number(e.target.value) || 0) }))}
					  required
					/>
				  </label>
				</>
			  ) : null}
			  {editForm.type !== 'tracking' && editForm.type !== 'node_group' && editForm.type !== 'subscription' ? (
				<div className="form-row">
				  <label>
					{editForm.type === 'subscription' ? '订阅拉取间隔(秒，0=不定时)' : '间隔(秒)'}
					<NumberStepperInput
					  min={editForm.type === 'subscription' ? 0 : 10}
					  value={editForm.interval_sec}
					  onChange={(e) => {
						const next = Number(e.target.value)
						if (!Number.isFinite(next)) return
						setEditForm((prev) => ({
							...prev,
							interval_sec: prev.type === 'subscription' ? Math.max(0, Math.round(next)) : Math.max(10, Math.round(next)),
						}))
					  }}
					  required
					/>
				  </label>
				  <label>
					超时(ms)
					<NumberStepperInput
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

            </form>
          </aside>
        </div>
		) : null}

	  {showAddNodeModal && isNodeGroupTarget ? (
		<div className="overlay" role="dialog" aria-modal="true">
		  <div className="confirm-card panel">
			<div className="panel-head">
			  <h3>添加节点</h3>
			  <button type="button" className="icon-button" onClick={() => setShowAddNodeModal(false)}>
				<X size={16} />
			  </button>
			</div>
			<p className="muted">每行粘贴一个节点 URI，保存后会自动识别并加入节点列表。</p>
			<AutoGrowTextarea
			  value={nodeImportText}
			  onChange={(e) => setNodeImportText(e.target.value)}
			  rows={8}
			  placeholder="vmess://...\nvless://...\nss://..."
			/>
			<div className="confirm-actions">
			  <button type="button" onClick={() => setShowAddNodeModal(false)} disabled={importingNodes}>取消</button>
			  <button type="button" className="primary" onClick={() => void handleImportNodeGroupURIs()} disabled={importingNodes}>
				{importingNodes ? '保存中...' : '识别并添加'}
			  </button>
			</div>
		  </div>
		</div>
	  ) : null}

	  <ConfirmDialog
		open={Boolean(pendingDeleteNode)}
		title="确认删除该节点？"
		description={`节点「${pendingDeleteNode?.name || pendingDeleteNode?.node_uid || ''}」将从当前节点组移除，删除后不可恢复。`}
		confirmText="确认删除"
		confirmVariant="danger"
		confirming={deletingNodeFromCard}
		onCancel={() => setPendingDeleteNode(null)}
		onConfirm={() => {
			if (!pendingDeleteNode) return
			void handleDeleteNodeFromCard(pendingDeleteNode, false)
		}}
	  />

	  <ConfirmDialog
		open={confirmDelete}
		title="确认删除该目标？"
		description="删除后不可恢复，相关检测结果也会一并删除。"
		confirmText="确认删除"
		confirmVariant="danger"
		confirming={deleting}
		onCancel={() => setConfirmDelete(false)}
		onConfirm={() => void handleDeleteTarget()}
	  />
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
  const { toasts, notify, removeToast } = useToastManager()

  function handleToggleTheme(nextTheme: ThemeMode, origin: { x: number; y: number }) {
    const maxX = Math.max(origin.x, window.innerWidth - origin.x)
    const maxY = Math.max(origin.y, window.innerHeight - origin.y)
    const radius = Math.hypot(maxX, maxY)
    const root = document.documentElement
    root.style.setProperty('--theme-reveal-x', `${origin.x}px`)
    root.style.setProperty('--theme-reveal-y', `${origin.y}px`)
    root.style.setProperty('--theme-reveal-r', `${radius}px`)

    const docWithTransition = document as Document & {
      startViewTransition?: (callback: () => void) => { ready: Promise<void> }
    }
    if (typeof docWithTransition.startViewTransition === 'function') {
      void docWithTransition.startViewTransition(() => {
        setTheme(nextTheme)
      }).ready.catch(() => {})
      return
    }
    setTheme(nextTheme)
  }

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('all_monitor_theme', theme)
  }, [theme])

  useEffect(() => {
    void api<{ initialized: boolean }>('/api/init/status')
      .then((d) => setInitialized(d.initialized))
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
	const onAuthExpired = () => {
		setToken('')
		setError('登录已失效，请重新登录')
	}
	window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired)
	return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired)
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
		  {error ? <p className={isAuthExpiredMessage(error) ? 'auth-expired-tip' : 'error'}>{error}</p> : null}
		</form>
	  </div>
	)
  }

  if (!token) {
    return (
      <div className="center-wrap">
        <form className="center-card form-card" onSubmit={handleLogin}>
          <h2>登录全能监控</h2>
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
		  {error ? <p className={isAuthExpiredMessage(error) ? 'auth-expired-tip' : 'error'}>{error}</p> : null}
		</form>
	  </div>
	)
  }

  return (
    <BrowserRouter>
	  <ToastViewport toasts={toasts} onClose={removeToast} />
      <Routes>
        <Route
          path="/"
          element={(
            <DashboardPage
              token={token}
              theme={theme}
              onToggleTheme={handleToggleTheme}
              notify={notify}
              onLogout={() => {
                localStorage.removeItem('all_monitor_token')
                setToken('')
              }}
            />
          )}
        />
		<Route path="/targets/:id" element={<TargetDetailPage token={token} notify={notify} />} />
		<Route path="/targets/:id/subscription/nodes/:uid" element={<SubscriptionNodeDetailPage token={token} notify={notify} theme={theme} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
