const AUTH_EXPIRED_EVENT = 'all_monitor_auth_expired'

type ApiBody<T> = {
	code: number
	message: string
	data: T
}

function resolveAPIBase(): string {
	const fromEnv = (import.meta.env.VITE_API_BASE as string | undefined)?.trim()
	if (fromEnv) return fromEnv.replace(/\/+$/, '')
	if (typeof window === 'undefined') return ''
	const { hostname, port } = window.location
	if (hostname === 'localhost' && /^51\d\d$/.test(port)) {
		return 'http://localhost:8080'
	}
	return ''
}

const API_BASE = resolveAPIBase()

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

	if (res.status === 401 || body.code === 40101 || body.code === 40102) {
		localStorage.removeItem('all_monitor_token')
		window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
	}

	if (!res.ok || body.code !== 0) {
		throw new Error(body.message || `请求失败（HTTP ${res.status}）`)
	}
	return body.data
}

export type { ApiBody }
export { api, API_BASE, AUTH_EXPIRED_EVENT }
