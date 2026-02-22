import { AlertTriangle, Clock3, ShieldCheck, X } from 'lucide-react'
import type { ToastMessage, ToastType } from '../../types/ui'

function renderToastIcon(type: ToastType) {
	if (type === 'success') return <ShieldCheck size={16} />
	if (type === 'error') return <X size={16} />
	if (type === 'warning') return <AlertTriangle size={16} />
	return <Clock3 size={16} />
}

function ToastViewport({ toasts, onClose }: { toasts: ToastMessage[]; onClose: (id: number) => void }) {
	if (toasts.length === 0) return null
	return (
		<div className="toast-stack" aria-live="polite" aria-atomic="false">
			{toasts.map((toast) => (
				<div key={toast.id} className={`toast ${toast.type}`} role="status">
					<span className="toast-icon" aria-hidden="true">{renderToastIcon(toast.type)}</span>
					<p>{toast.text}</p>
					<button type="button" className="toast-close" onClick={() => onClose(toast.id)} aria-label="关闭通知">
						<X size={14} />
					</button>
				</div>
			))}
		</div>
	)
}

export { ToastViewport }
