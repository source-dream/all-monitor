type SubscriptionNodeLike = {
	raw_json?: string
	name: string
	node_uid: string
	protocol: string
	server: string
	port: number
	last_latency_ms?: number
	last_fail_stage?: string
	last_fail_reason?: string
	last_error_msg?: string
	last_latency_checked_at?: string
	last_tcp_ms?: number
}

function latencyLevel(ms?: number): 'none' | 'fast' | 'good' | 'slow' | 'bad' {
	if (typeof ms !== 'number' || ms < 0) return 'none'
	if (ms < 80) return 'fast'
	if (ms < 180) return 'good'
	if (ms < 350) return 'slow'
	return 'bad'
}

function nodeLatencyState(node: SubscriptionNodeLike): 'pending' | 'degraded' | 'error' | 'fast' | 'good' | 'slow' | 'bad' {
	if (typeof node.last_latency_ms === 'number' && node.last_latency_ms >= 0) {
		return latencyLevel(node.last_latency_ms) as 'fast' | 'good' | 'slow' | 'bad'
	}
	const failStage = (node.last_fail_stage || '').toLowerCase()
	const hasFailureSignal = Boolean((node.last_error_msg || '').trim() || (node.last_fail_reason || '').trim() || failStage)
	if (hasFailureSignal) {
		if (typeof node.last_tcp_ms === 'number' && node.last_tcp_ms > 0 && (failStage.includes('e2e') || failStage.includes('proxy') || failStage.includes('dns'))) {
			return 'degraded'
		}
		return 'error'
	}
	if (node.last_latency_checked_at) {
		if (typeof node.last_tcp_ms === 'number' && node.last_tcp_ms > 0) {
			return 'degraded'
		}
		return 'error'
	}
	return 'pending'
}

function isSubscriptionNodeAvailable(node: SubscriptionNodeLike): boolean {
	const state = nodeLatencyState(node)
	return state === 'fast' || state === 'good' || state === 'slow' || state === 'bad'
}

function subscriptionNodeCopyText(node: SubscriptionNodeLike): string {
	if (node.raw_json) {
		try {
			const parsed = JSON.parse(node.raw_json) as Record<string, unknown>
			const uri = typeof parsed.uri === 'string' ? parsed.uri.trim() : ''
			if (uri) return uri
		} catch {
			// ignore invalid raw_json
		}
	}
	const endpoint = node.port > 0 ? `${node.server}:${node.port}` : node.server
	const title = node.name?.trim() || node.node_uid
	return `${title}\n${node.protocol || '-'}://${endpoint}`
}

export { nodeLatencyState, isSubscriptionNodeAvailable, subscriptionNodeCopyText }
