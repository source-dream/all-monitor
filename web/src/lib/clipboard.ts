async function copyTextToClipboard(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text)
			return true
		}
	} catch {
		// fallback below
	}

	try {
		const textarea = document.createElement('textarea')
		textarea.value = text
		textarea.setAttribute('readonly', 'true')
		textarea.style.position = 'fixed'
		textarea.style.opacity = '0'
		textarea.style.pointerEvents = 'none'
		document.body.appendChild(textarea)
		textarea.select()
		const copied = document.execCommand('copy')
		document.body.removeChild(textarea)
		return copied
	} catch {
		return false
	}
}

export { copyTextToClipboard }
