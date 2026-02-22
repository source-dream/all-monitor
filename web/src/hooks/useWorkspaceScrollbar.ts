import { useEffect } from 'react'

function useWorkspaceScrollbar() {
	useEffect(() => {
		document.documentElement.classList.add('dashboard-scroll')
		document.body.classList.add('dashboard-scroll')
		return () => {
			document.documentElement.classList.remove('dashboard-scroll')
			document.body.classList.remove('dashboard-scroll')
		}
	}, [])
}

export { useWorkspaceScrollbar }
