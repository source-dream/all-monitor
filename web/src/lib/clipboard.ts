async function copyTextToClipboard(text: string, context = 'clipboard copy'): Promise<boolean> {
	let clipboardError: unknown = null
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text)
			return true
		}
	} catch (err) {
		clipboardError = err
		console.error(`[${context}] navigator.clipboard.writeText failed`, err)
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
		if (!copied) {
			const fallbackError = new Error('document.execCommand("copy") returned false')
			console.error(`[${context}] fallback copy failed`, fallbackError)
			if (clipboardError) {
				console.error(`[${context}] original clipboard error`, clipboardError)
			}
		}
		return copied
	} catch (err) {
		console.error(`[${context}] fallback copy threw`, err)
		if (clipboardError) {
			console.error(`[${context}] original clipboard error`, clipboardError)
		}
		return false
	}
}

export { copyTextToClipboard }
