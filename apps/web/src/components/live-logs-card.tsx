'use client'

// Live container logs (docker logs --follow over SSE). One component for the
// container page (/servers/[id]/[name]) and the app logs tab: both read
// GET /api/servers/[id]/containers/[name]/logs/stream, which runs the same
// requireContainerAccess check and masks every line (lib/log-line-redact.ts).

import { Circle, Eraser, Pause, Play } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CopyButton } from '@/components/ui/copy-button'
import { REVOKED_MESSAGE, STREAM_EXPIRED, STREAM_REVOKED, dedupeResumedLines } from '@/lib/stream-events'

export function LiveLogsCard({
	serverId,
	containerName,
	title = 'logs',
	autoStart = false,
	idleHint = 'click start to stream logs as the container talks.',
}: {
	serverId: string
	containerName: string
	title?: string
	/** start streaming on mount (the app logs tab); the container page waits for a click */
	autoStart?: boolean
	/** the line shown before the stream starts */
	idleHint?: string
}) {
	const [logLines, setLogLines] = useState<string[]>([])
	const [streaming, setStreaming] = useState(false)
	const logsId = useId()
	const [logError, setLogError] = useState<string | null>(null)
	const [paused, setPaused] = useState(false)
	const eventSourceRef = useRef<EventSource | null>(null)
	const preRef = useRef<HTMLPreElement>(null)
	const stickRef = useRef(true)
	const pausedRef = useRef(false)
	// Last log line shown, so a resumed log stream (tail=1) does not repeat it.
	const lastLogLineRef = useRef<string | undefined>(undefined)

	// biome-ignore lint/correctness/useExhaustiveDependencies: logLines.length is the trigger: scroll to the bottom after each new line (the effect reads refs only)
	useEffect(() => {
		const el = preRef.current
		if (el && stickRef.current) el.scrollTop = el.scrollHeight
	}, [logLines.length])

	function stopLogStream() {
		eventSourceRef.current?.close()
		eventSourceRef.current = null
		setStreaming(false)
	}

	function startLogStream(resume = false) {
		if (eventSourceRef.current) return
		setLogError(null)
		// A resumed stream (after `expired`) asks for 1 line of history and drops it
		// when it repeats the last line shown.
		const es = new EventSource(
			`/api/servers/${encodeURIComponent(serverId)}/containers/${encodeURIComponent(containerName)}/logs/stream?tail=${resume ? 1 : 200}`,
		)
		let firstChunk = resume
		es.addEventListener('log', (e) => {
			if (pausedRef.current) return
			try {
				const chunk = JSON.parse((e as MessageEvent).data) as string
				let newLines = chunk.split('\n').filter((l) => l.length > 0)
				if (firstChunk) newLines = dedupeResumedLines(lastLogLineRef.current, newLines)
				firstChunk = false
				if (newLines.length > 0) lastLogLineRef.current = newLines[newLines.length - 1]
				setLogLines((prev) => {
					const merged = [...prev, ...newLines]
					return merged.length > 5000 ? merged.slice(-5000) : merged
				})
			} catch {
				// ignore
			}
		})
		es.addEventListener('error', (e) => {
			try {
				const msg = JSON.parse((e as MessageEvent).data) as string
				setLogError(msg)
			} catch {
				setLogError('connection lost')
			}
			stopLogStream()
		})
		es.addEventListener('end', () => stopLogStream())
		// The stream hit its lifetime cap: reconnect without losing the tail.
		es.addEventListener(STREAM_EXPIRED, () => {
			stopLogStream()
			startLogStream(true)
		})
		es.addEventListener(STREAM_REVOKED, () => {
			setLogError(REVOKED_MESSAGE)
			stopLogStream()
		})
		es.onerror = () => {
			if (es.readyState === EventSource.CLOSED) {
				setStreaming(false)
				eventSourceRef.current = null
			}
		}
		eventSourceRef.current = es
		setStreaming(true)
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: start once per container; the stream functions read refs
	useEffect(() => {
		if (autoStart) startLogStream()
		return () => {
			eventSourceRef.current?.close()
			eventSourceRef.current = null
		}
	}, [serverId, containerName, autoStart])

	function toggleStream() {
		if (streaming) stopLogStream()
		else startLogStream()
	}

	function togglePause() {
		const next = !pausedRef.current
		pausedRef.current = next
		setPaused(next)
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2.5">
						<CardTitle>{title}</CardTitle>
						{streaming && (
							<span className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
								<Circle
									className={
										paused
											? 'h-1.5 w-1.5 fill-muted-foreground text-muted-foreground'
											: 'h-1.5 w-1.5 animate-pulse fill-powder text-powder'
									}
								/>
								{paused ? 'paused' : 'streaming'}
							</span>
						)}
					</div>
					<div className="flex items-center gap-2">
						{streaming && (
							<Button
								variant="ghost"
								size="sm"
								onClick={togglePause}
								title={paused ? 'resume' : 'pause'}
								aria-label={paused ? 'resume' : 'pause'}
							>
								{paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
							</Button>
						)}
						{logLines.length > 0 && (
							<CopyButton
								value={() => logLines.join('\n')}
								label="copy the log lines shown"
								targetId={logsId}
								size="sm"
							/>
						)}
						{logLines.length > 0 && (
							<Button variant="ghost" size="sm" onClick={() => setLogLines([])} title="clear" aria-label="clear">
								<Eraser className="h-3 w-3" />
							</Button>
						)}
						<Button variant="outline" size="sm" onClick={toggleStream}>
							{streaming ? 'stop' : logLines.length > 0 ? 'resume stream' : 'start streaming'}
						</Button>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				{logError && <p className="mb-2 text-xs text-destructive">stream error: {logError}</p>}
				{logLines.length === 0 && !streaming ? (
					<p className="text-sm text-muted-foreground">{idleHint}</p>
				) : logLines.length === 0 && streaming ? (
					<p className="text-sm text-muted-foreground">connecting…</p>
				) : (
					<pre
						ref={preRef}
						id={logsId}
						onScroll={(e) => {
							const el = e.currentTarget
							stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
						}}
						className="ph-no-capture max-h-[60vh] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-2xs leading-relaxed"
					>
						{logLines.join('\n')}
					</pre>
				)}
			</CardContent>
		</Card>
	)
}
