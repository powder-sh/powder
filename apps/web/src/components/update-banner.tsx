import { PUBLIC_REPO_URL } from '@/lib/site'
import { getUpdateStatus, UPGRADE_DOCS_PATH } from '@/lib/update-check'

// Quiet notice shown only when the daily update check found a newer release.
export async function UpdateBanner() {
	const status = await getUpdateStatus()
	if (!status) return null
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-powder/5 px-4 py-2 text-xs text-muted-foreground sm:px-6 lg:px-10">
			<span className="inline-flex items-center gap-2">
				<span className="h-1.5 w-1.5 rounded-full bg-powder" aria-hidden="true" />
				<span>
					powder <span className="font-mono text-foreground">v{status.latest}</span> is available
				</span>
			</span>
			<a
				href={status.url || `${PUBLIC_REPO_URL}/releases`}
				className="underline underline-offset-2 hover:text-foreground"
			>
				release notes
			</a>
			<a href={UPGRADE_DOCS_PATH} className="underline underline-offset-2 hover:text-foreground">
				how to upgrade
			</a>
		</div>
	)
}
