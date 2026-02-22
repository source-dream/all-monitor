export type ThemeMode = 'light' | 'dark'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export type ToastMessage = {
	id: number
	type: ToastType
	text: string
}

export type ToastNotifier = {
	success: (text: string, durationMS?: number) => void
	error: (text: string, durationMS?: number) => void
	info: (text: string, durationMS?: number) => void
	warning: (text: string, durationMS?: number) => void
}
