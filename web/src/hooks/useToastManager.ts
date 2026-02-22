import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ToastMessage, ToastNotifier, ToastType } from '../types/ui'

function useToastManager() {
	const [toasts, setToasts] = useState<ToastMessage[]>([])
	const toastTimersRef = useRef<Record<number, number>>({})

	const removeToast = useCallback((id: number) => {
		setToasts((prev) => prev.filter((item) => item.id !== id))
		const timer = toastTimersRef.current[id]
		if (typeof timer === 'number') {
			window.clearTimeout(timer)
			delete toastTimersRef.current[id]
		}
	}, [])

	const pushToast = useCallback((type: ToastType, text: string, durationMS = 2200) => {
		const id = Date.now() + Math.floor(Math.random() * 100000)
		setToasts((prev) => [{ id, type, text }, ...prev].slice(0, 5))
		toastTimersRef.current[id] = window.setTimeout(() => {
			setToasts((prev) => prev.filter((item) => item.id !== id))
			delete toastTimersRef.current[id]
		}, Math.max(1000, durationMS))
	}, [])

	useEffect(() => {
		return () => {
			Object.values(toastTimersRef.current).forEach((timer) => window.clearTimeout(timer))
			toastTimersRef.current = {}
		}
	}, [])

	const notify: ToastNotifier = useMemo(() => ({
		success: (text, durationMS) => pushToast('success', text, durationMS),
		error: (text, durationMS) => pushToast('error', text, durationMS),
		info: (text, durationMS) => pushToast('info', text, durationMS),
		warning: (text, durationMS) => pushToast('warning', text, durationMS),
	}), [pushToast])

	return { toasts, notify, removeToast }
}

export { useToastManager }
