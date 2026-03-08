import { useEffect, useMemo, useState } from 'react'
import { Activity, ArrowLeft, RefreshCcw, Trash2 } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { useNavigate, useParams } from 'react-router-dom'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { useWorkspaceScrollbar } from '../hooks/useWorkspaceScrollbar'
import { api } from '../lib/api'
import type { ThemeMode, ToastNotifier } from '../types/ui'

type Target = {
	type: string
}

type SubscriptionNode = {
	name: string
}

type SubscriptionNodeSummary = {
	node: SubscriptionNode
	availability_24h: number
	avg_latency_24h_ms: number
	check_count_24h: number
	latest_latency_ms?: number
}

type SubscriptionNodeSeriesPoint = {
	checked_at: string
	latency_ms: number
	availability: number
}

type SubscriptionNodeCheck = {
	id: number
	success: boolean
	checked_at: string
	latency_ms: number
	score_ms: number
	e2e_domestic_ms: number
	e2e_overseas_ms: number
	tcp_ms: number
	tls_ms: number
	jitter_ms: number
	probe_mode: string
	fail_stage: string
	fail_reason: string
	error_msg: string
}

function formatDateTime(timeString: string): string {
	const dt = new Date(timeString)
	return `${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}`
}

function SubscriptionNodeDetailPage({ token, notify, theme }: { token: string; notify: ToastNotifier; theme: ThemeMode }) {
	useWorkspaceScrollbar()
	const navigate = useNavigate()
	const params = useParams()
	const id = Number(params.id)
	const uid = decodeURIComponent(params.uid ?? '')
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState('')
	const [summary, setSummary] = useState<SubscriptionNodeSummary | null>(null)
	const [series, setSeries] = useState<SubscriptionNodeSeriesPoint[]>([])
	const [logs, setLogs] = useState<SubscriptionNodeCheck[]>([])
	const [isNodeGroupTarget, setIsNodeGroupTarget] = useState(false)
	const [confirmDeleteNode, setConfirmDeleteNode] = useState(false)
	const [deletingNode, setDeletingNode] = useState(false)

	function exitDetail() {
		if (window.history.length > 1) {
			navigate(-1)
			return
		}
		navigate(`/targets/${id}`)
	}

	async function load() {
		if (!Number.isFinite(id) || id <= 0 || !uid) return
		setLoading(true)
		setError('')
		try {
			const [targetData, s, se, lg] = await Promise.all([
				api<Target>(`/api/targets/${id}`, undefined, token),
				api<SubscriptionNodeSummary>(`/api/targets/${id}/subscription/nodes/${encodeURIComponent(uid)}/summary`, undefined, token),
				api<SubscriptionNodeSeriesPoint[]>(`/api/targets/${id}/subscription/nodes/${encodeURIComponent(uid)}/series?hours=24`, undefined, token),
				api<SubscriptionNodeCheck[]>(`/api/targets/${id}/subscription/nodes/${encodeURIComponent(uid)}/logs?limit=100`, undefined, token),
			])
			setIsNodeGroupTarget(targetData.type === 'node_group')
			setSummary(s)
			setSeries(se)
			setLogs(lg)
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setLoading(false)
		}
	}

	async function handleDeleteNode() {
		if (!isNodeGroupTarget) return
		setDeletingNode(true)
		setError('')
		try {
			await api(`/api/targets/${id}/subscription/nodes/${encodeURIComponent(uid)}`, { method: 'DELETE' }, token)
			notify.success('节点已删除')
			navigate(`/targets/${id}`)
		} catch (err) {
			const msg = (err as Error).message
			setError(msg)
			notify.error(msg || '删除节点失败')
		} finally {
			setDeletingNode(false)
			setConfirmDeleteNode(false)
		}
	}

	useEffect(() => {
		void load()
	}, [id, uid, token])

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			if (confirmDeleteNode) {
				setConfirmDeleteNode(false)
				return
			}
			event.preventDefault()
			exitDetail()
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [confirmDeleteNode, id, navigate])

	async function handleCheckNow() {
		try {
			await api(`/api/targets/${id}/subscription/nodes/${encodeURIComponent(uid)}/check-now`, { method: 'POST' }, token)
			await load()
		} catch (err) {
			setError((err as Error).message)
		}
	}

	const nodeChartColors = useMemo(() => {
		if (theme === 'dark') {
			return {
				axisLabel: '#94a3b8',
				axisLine: '#334155',
				splitLine: 'rgba(148, 163, 184, 0.18)',
				latencyLine: '#60a5fa',
				availabilityLine: '#34d399',
			}
		}
		return {
			axisLabel: '#475569',
			axisLine: '#cbd5e1',
			splitLine: 'rgba(148, 163, 184, 0.35)',
			latencyLine: '#2563eb',
			availabilityLine: '#059669',
		}
	}, [theme])

	const latencyOption = useMemo(() => ({
		backgroundColor: 'transparent',
		grid: { left: 26, right: 20, top: 26, bottom: 26, containLabel: true },
		tooltip: {
			trigger: 'axis',
			backgroundColor: theme === 'dark' ? 'rgba(15, 23, 42, 0.92)' : 'rgba(255, 255, 255, 0.94)',
			textStyle: { color: nodeChartColors.axisLabel },
			borderColor: nodeChartColors.axisLine,
			borderWidth: 1,
		},
		xAxis: {
			type: 'category',
			data: series.map((x) => new Date(x.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
			axisLabel: { color: nodeChartColors.axisLabel },
			axisLine: { lineStyle: { color: nodeChartColors.axisLine } },
		},
		yAxis: {
			type: 'value',
			axisLabel: { color: nodeChartColors.axisLabel },
			splitLine: { lineStyle: { color: nodeChartColors.splitLine } },
		},
		series: [{ type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 2, color: nodeChartColors.latencyLine }, data: series.map((x) => x.latency_ms) }],
	}), [series, nodeChartColors, theme])

	const availabilityOption = useMemo(() => ({
		backgroundColor: 'transparent',
		grid: { left: 26, right: 20, top: 26, bottom: 26, containLabel: true },
		tooltip: {
			trigger: 'axis',
			backgroundColor: theme === 'dark' ? 'rgba(15, 23, 42, 0.92)' : 'rgba(255, 255, 255, 0.94)',
			textStyle: { color: nodeChartColors.axisLabel },
			borderColor: nodeChartColors.axisLine,
			borderWidth: 1,
		},
		xAxis: {
			type: 'category',
			data: series.map((x) => new Date(x.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
			axisLabel: { color: nodeChartColors.axisLabel },
			axisLine: { lineStyle: { color: nodeChartColors.axisLine } },
		},
		yAxis: {
			type: 'value', min: 0, max: 100,
			axisLabel: { color: nodeChartColors.axisLabel },
			splitLine: { lineStyle: { color: nodeChartColors.splitLine } },
		},
		series: [{ type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 2, color: nodeChartColors.availabilityLine }, data: series.map((x) => x.availability) }],
	}), [series, nodeChartColors, theme])

	return (
		<div className="workspace detail-workspace">
			<header className="workspace-header">
				<div className="header-main">
					<button type="button" className="back-button" onClick={exitDetail}>
						<ArrowLeft size={16} /> 返回
					</button>
					<h1 className="detail-title">节点详情</h1>
					<p className="muted">{summary?.node?.name ?? uid}</p>
				</div>
				<div className="header-actions">
					<button type="button" onClick={() => void load()}><RefreshCcw size={16} /> 刷新</button>
					<button type="button" className="primary" onClick={() => void handleCheckNow()}><Activity size={16} /> 手动检测</button>
					{isNodeGroupTarget ? (
						<button type="button" className="danger-btn" onClick={() => setConfirmDeleteNode(true)}>
							<Trash2 size={16} /> 删除节点
						</button>
					) : null}
				</div>
			</header>
			{error ? <p className="error panel">{error}</p> : null}
			<section className="kpi-grid">
				<article className="panel metric-card"><p className="panel-title">24h可用率</p><p className="panel-value">{loading ? '...' : `${summary?.availability_24h?.toFixed(1) ?? '0'}%`}</p></article>
				<article className="panel metric-card"><p className="panel-title">24h平均延迟</p><p className="panel-value">{loading ? '...' : `${Math.round(summary?.avg_latency_24h_ms ?? 0)}ms`}</p></article>
				<article className="panel metric-card"><p className="panel-title">检查次数</p><p className="panel-value">{loading ? '...' : String(summary?.check_count_24h ?? 0)}</p></article>
				<article className="panel metric-card"><p className="panel-title">最近延迟</p><p className="panel-value">{loading ? '...' : (typeof summary?.latest_latency_ms === 'number' ? `${summary.latest_latency_ms}ms` : '--')}</p></article>
			</section>
			<section className="detail-grid">
				<article className="panel"><div className="panel-head"><h3>延迟趋势</h3></div><ReactECharts option={latencyOption} style={{ height: 220 }} /></article>
				<article className="panel"><div className="panel-head"><h3>可用率趋势</h3></div><ReactECharts option={availabilityOption} style={{ height: 220 }} /></article>
				<article className="panel subscription-panel-full">
					<div className="panel-head"><h3>查询日志</h3><span>最近 100 条</span></div>
					<div className="logs-list">
						{logs.map((row) => (
							<div className="log-row" key={row.id}>
								<div className="log-row-head"><span className={`status ${row.success ? 'ok' : 'down'}`}>{row.success ? '成功' : '失败'}</span><span className="muted">{formatDateTime(row.checked_at)}</span></div>
							<div className="log-row-body">
								<span>业务延迟(海外E2E)：{row.success ? `${Math.max(0, row.latency_ms)}ms` : '--'}</span>
								<span>综合评分：{row.score_ms > 0 ? `${row.score_ms}ms` : '--'}</span>
								<span>E2E-国内：{row.e2e_domestic_ms > 0 ? `${row.e2e_domestic_ms}ms` : '--'}</span>
								<span>E2E-海外：{row.e2e_overseas_ms > 0 ? `${row.e2e_overseas_ms}ms` : '--'}</span>
								<span>TCP：{row.tcp_ms > 0 ? `${row.tcp_ms}ms` : '--'}</span>
								<span>TLS：{row.tls_ms > 0 ? `${row.tls_ms}ms` : '--'}</span>
								<span>抖动：{row.jitter_ms > 0 ? `${row.jitter_ms}ms` : '--'}</span>
								<span>模式：{row.probe_mode || '--'}</span>
								<span>失败阶段：{row.fail_stage || '--'}</span>
								<span>失败原因：{row.fail_reason || '--'}</span>
								<span>错误：{row.error_msg || '无'}</span>
							</div>
						  </div>
						))}
						{logs.length === 0 ? <p className="muted">暂无日志</p> : null}
					</div>
				</article>
			</section>
			<ConfirmDialog
				open={confirmDeleteNode}
				title="确认删除该节点？"
				description="仅会从当前节点组移除该节点，删除后不可恢复。"
				confirmText="确认删除"
				confirmVariant="danger"
				confirming={deletingNode}
				onCancel={() => setConfirmDeleteNode(false)}
				onConfirm={() => void handleDeleteNode()}
			/>
		</div>
	)
}

export { SubscriptionNodeDetailPage }
