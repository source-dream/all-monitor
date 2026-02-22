type ConfirmDialogProps = {
	open: boolean
	title: string
	description: string
	confirmText?: string
	cancelText?: string
	confirmVariant?: 'primary' | 'danger'
	confirming?: boolean
	onConfirm: () => void
	onCancel: () => void
}

function ConfirmDialog({
	open,
	title,
	description,
	confirmText = '确认',
	cancelText = '取消',
	confirmVariant = 'primary',
	confirming = false,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	if (!open) return null
	return (
		<div className="overlay" role="dialog" aria-modal="true">
			<div className="confirm-card panel">
				<h3>{title}</h3>
				<p className="muted">{description}</p>
				<div className="confirm-actions">
					<button type="button" onClick={onCancel} disabled={confirming}>{cancelText}</button>
					<button type="button" className={confirmVariant === 'danger' ? 'danger-btn' : 'primary'} onClick={onConfirm} disabled={confirming}>
						{confirming ? '处理中...' : confirmText}
					</button>
				</div>
			</div>
		</div>
	)
}

export { ConfirmDialog }
