export type ReleaseInfo = {
	tagName: string
	prerelease: boolean
	htmlURL: string
}

export type VersionUpdateNotice = {
	kind: 'stable' | 'prerelease'
	latestTag: string
	url: string
}

const RELEASES_API = 'https://api.github.com/repos/source-dream/all-monitor/releases?per_page=20'

type ParsedVersion = {
	major: number
	minor: number
	patch: number
	prerelease: string[]
}

function parseVersion(tag: string): ParsedVersion | null {
	const trimmed = tag.trim().replace(/^v/i, '')
	const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
	if (!match) return null
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ? match[4].split('.') : [],
	}
}

function compareIdentifier(a: string, b: string): number {
	const aNum = /^\d+$/.test(a)
	const bNum = /^\d+$/.test(b)
	if (aNum && bNum) {
		const aVal = Number(a)
		const bVal = Number(b)
		if (aVal < bVal) return -1
		if (aVal > bVal) return 1
		return 0
	}
	if (aNum && !bNum) return -1
	if (!aNum && bNum) return 1
	return a.localeCompare(b)
}

export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a)
	const pb = parseVersion(b)
	if (!pa || !pb) return a.localeCompare(b)

	if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
	if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
	if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1

	const aPre = pa.prerelease
	const bPre = pb.prerelease
	if (aPre.length === 0 && bPre.length === 0) return 0
	if (aPre.length === 0) return 1
	if (bPre.length === 0) return -1

	const max = Math.max(aPre.length, bPre.length)
	for (let i = 0; i < max; i += 1) {
		const ai = aPre[i]
		const bi = bPre[i]
		if (ai === undefined) return -1
		if (bi === undefined) return 1
		const cmp = compareIdentifier(ai, bi)
		if (cmp !== 0) return cmp
	}
	return 0
}

export async function fetchGithubReleases(): Promise<ReleaseInfo[]> {
	const res = await fetch(RELEASES_API)
	if (!res.ok) return []
	const rows = (await res.json()) as Array<{
		tag_name?: string
		prerelease?: boolean
		draft?: boolean
		html_url?: string
	}>
	return rows
		.filter((row) => !row.draft && Boolean(row.tag_name) && Boolean(row.html_url))
		.map((row) => ({
			tagName: String(row.tag_name),
			prerelease: Boolean(row.prerelease),
			htmlURL: String(row.html_url),
		}))
}

function pickLatest(releases: ReleaseInfo[], prerelease: boolean): ReleaseInfo | null {
	const candidates = releases.filter((item) => item.prerelease === prerelease)
	if (candidates.length === 0) return null
	return candidates.reduce((latest, item) => (compareVersions(item.tagName, latest.tagName) > 0 ? item : latest))
}

export function resolveVersionUpdateNotice(
	currentVersion: string,
	releases: ReleaseInfo[],
): VersionUpdateNotice | null {
	const latestStable = pickLatest(releases, false)
	if (latestStable && compareVersions(currentVersion, latestStable.tagName) < 0) {
		return {
			kind: 'stable',
			latestTag: latestStable.tagName,
			url: latestStable.htmlURL,
		}
	}

	const latestPrerelease = pickLatest(releases, true)
	if (latestPrerelease && compareVersions(currentVersion, latestPrerelease.tagName) < 0) {
		return {
			kind: 'prerelease',
			latestTag: latestPrerelease.tagName,
			url: latestPrerelease.htmlURL,
		}
	}

	return null
}
