// Tiny Anthropic Messages API client. We don't pull the SDK to keep deps lean —
// one fetch + one prompt template covers what we need (CI failure diagnosis).
// Every call is capped per day (llm-quota.ts), times out after 30s and retries
// 429/5xx twice with backoff.

import { reserveLlmCall } from './llm-quota'

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'
const TIMEOUT_MS = 30_000
const MAX_RETRIES = 2

export interface MessageOpts {
	model?: string
	maxTokens?: number
	system?: string
	user: string
}

export async function complete(opts: MessageOpts): Promise<string> {
	const apiKey = process.env.ANTHROPIC_API_KEY
	if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

	const body = {
		model: opts.model ?? 'claude-haiku-4-5',
		max_tokens: opts.maxTokens ?? 400,
		system: opts.system,
		messages: [{ role: 'user', content: opts.user }],
	}
	await reserveLlmCall()
	let res: Response | undefined
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		res = await fetch(API_URL, {
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': API_VERSION,
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		})
		const retryable = res.status === 429 || res.status >= 500
		if (!retryable || attempt === MAX_RETRIES) break
		await res.text().catch(() => '')
		await new Promise((r) => setTimeout(r, backoffMs(attempt)))
	}
	if (!res) throw new Error('anthropic: no response')
	if (!res.ok) {
		const errBody = await res.text().catch(() => '')
		throw new Error(`anthropic ${res.status}: ${errBody.slice(0, 300)}`)
	}
	const data = (await res.json()) as {
		content?: { type: string; text?: string }[]
	}
	const text = (data.content ?? []).find((c) => c.type === 'text')?.text ?? ''
	return text.trim()
}

// 1s, 2s
function backoffMs(attempt: number): number {
	return 1000 * 2 ** attempt
}
