const AUTH_EXPIRED_EVENT = 'all_monitor_auth_expired'

type RuntimeWindow = Window & {
	__APP_BASE_PATH__?: string
}

type ApiBody<T> = {
	code: number
	message: string
	data: T
}

function normalizeBasePath(raw: string | undefined): string {
	const trimmed = (raw ?? '').trim()
	if (!trimmed || trimmed === '/') return '/'
	const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
	const withoutTrailing = withLeading.replace(/\/+$/, '')
	return withoutTrailing || '/'
}

function resolveAppBasePath(): string {
	if (typeof window === 'undefined') return '/'
	return normalizeBasePath((window as RuntimeWindow).__APP_BASE_PATH__)
}

const APP_BASE_PATH = resolveAppBasePath()

function resolveAPIBase(): string {
	const fromEnv = (import.meta.env.VITE_API_BASE as string | undefined)?.trim()
	if (fromEnv) return fromEnv.replace(/\/+$/, '')
	if (typeof window === 'undefined') return ''
	const { hostname, port } = window.location
	if (hostname === 'localhost' && /^51\d\d$/.test(port)) {
		return 'http://localhost:8080'
	}
	if (APP_BASE_PATH === '/') return ''
	return APP_BASE_PATH
}

const API_BASE = resolveAPIBase()

async function api<T>(path: string, options?: RequestInit, token?: string): Promise<T> {
	return request<T>(path, options, token, true)
}

async function publicApi<T>(path: string, options?: RequestInit): Promise<T> {
	return request<T>(path, options, undefined, false)
}

async function request<T>(path: string, options: RequestInit | undefined, token: string | undefined, triggerAuthExpired: boolean): Promise<T> {
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

	if (triggerAuthExpired && (res.status === 401 || body.code === 40101 || body.code === 40102)) {
		localStorage.removeItem('all_monitor_token')
		window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
	}

	if (!res.ok || body.code !== 0) {
		throw new Error(body.message || `请求失败（HTTP ${res.status}）`)
	}
	return body.data
}

export type { ApiBody }
export { api, publicApi, API_BASE, APP_BASE_PATH, AUTH_EXPIRED_EVENT }
