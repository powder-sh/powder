'use client'

import { ExternalLink } from 'lucide-react'
import { useId, useState } from 'react'

/** The first `limit` URLs are always shown, the rest sit behind a "+N more" toggle. */
export function splitUrls(urls: string[], limit: number): { shown: string[]; rest: string[] } {
	const n = Math.max(1, limit)
	return { shown: urls.slice(0, n), rest: urls.slice(n) }
}

/** A wildcard host (`https://*.example.com`) is informational: it cannot be opened. */
export function isWildcardUrl(url: string): boolean {
	return url.includes('*')
}

/** Every URL of a container on the servers list. The rest stay in the DOM behind a
 *  toggle (`hidden` until expanded), so none is ever unreachable. The links and the
 *  toggle sit above the row's stretched link (`relative z-10`) and are siblings of
 *  it, never nested inside it. With `notInProxy` a quiet note says the URLs come from
 *  powder's domain record, not from the proxy config (server-url-gaps.ts). */
export function ContainerUrls({
	urls,
	limit,
	notInProxy = false,
}: {
	urls: string[]
	limit: number
	/** the URLs are powder's own record of the app's live domains, shown because
	 *  discovery found no route to this container in the proxy config */
	notInProxy?: boolean
}) {
	const [open, setOpen] = useState(false)
	const id = useId()
	if (urls.length === 0) return <span className="text-xs text-muted-foreground">-</span>
	const { shown, rest } = splitUrls(urls, limit)
	const last = shown.length - 1
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			{shown.map((u, i) =>
				i === last && rest.length > 0 ? (
					<div key={u} className="flex min-w-0 items-center gap-1.5">
						<UrlItem url={u} />
						<button
							type="button"
							aria-expanded={open}
							aria-controls={id}
							aria-label={open ? 'show fewer URLs' : `show ${rest.length} more ${rest.length === 1 ? 'URL' : 'URLs'}`}
							onClick={() => setOpen((v) => !v)}
							className="relative z-10 inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded border border-border px-1.5 text-2xs leading-none text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{open ? 'less' : `+${rest.length}`}
						</button>
					</div>
				) : (
					<UrlItem key={u} url={u} />
				),
			)}
			{rest.length > 0 && (
				<div id={id} hidden={!open} className="flex min-w-0 flex-col gap-0.5">
					{rest.map((u) => (
						<UrlItem key={u} url={u} />
					))}
				</div>
			)}
			{notInProxy && (
				<span
					className="text-2xs text-muted-foreground"
					title="powder lists these as the app's live domains, but no route to this container was found in the server's nginx or Traefik config"
				>
					not found in the proxy config
				</span>
			)}
		</div>
	)
}

function UrlItem({ url }: { url: string }) {
	const label = url.replace(/^https?:\/\//, '')
	if (isWildcardUrl(url)) {
		return (
			<span className="truncate text-xs text-muted-foreground" title={url}>
				{label}
			</span>
		)
	}
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className="relative z-10 inline-flex min-w-0 max-w-full items-center gap-1 self-start rounded-sm text-xs text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<span className="truncate">{label}</span>
			<ExternalLink className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
		</a>
	)
}
