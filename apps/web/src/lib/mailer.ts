// Generic SMTP for email notification targets. POWDER_SMTP_URL is
// smtp://user:pass@host:port (STARTTLS when offered) or smtps://... (TLS on
// connect); POWDER_MAIL_FROM is the From header. Both unset = email targets
// cannot be created and none are sent. Short timeouts; never throws.

import nodemailer, { type Transporter } from 'nodemailer'

const TIMEOUT_MS = 10_000

function smtpUrl(env: Record<string, string | undefined> = process.env): string | null {
	const raw = env.POWDER_SMTP_URL?.trim()
	if (!raw) return null
	try {
		const u = new URL(raw)
		return u.protocol === 'smtp:' || u.protocol === 'smtps:' ? raw : null
	} catch {
		return null
	}
}

function mailFrom(env: Record<string, string | undefined> = process.env): string | null {
	return env.POWDER_MAIL_FROM?.trim() || null
}

/** True when both POWDER_SMTP_URL (smtp/smtps) and POWDER_MAIL_FROM are set. */
export function smtpConfigured(env: Record<string, string | undefined> = process.env): boolean {
	return smtpUrl(env) !== null && mailFrom(env) !== null
}

// Deliberately loose: one @, no spaces or angle brackets, a dot in the domain.
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/
export function isValidEmail(v: string): boolean {
	return v.length <= 254 && EMAIL_RE.test(v)
}

let transport: Transporter | null = null
let transportUrl: string | null = null

export function getTransport(url: string): Transporter {
	if (!transport || transportUrl !== url) {
		// nodemailer 10: transport options go next to `url` in ONE object (the second
		// argument is message defaults; timeouts passed there are ignored).
		transport = nodemailer.createTransport({
			url,
			connectionTimeout: TIMEOUT_MS,
			greetingTimeout: TIMEOUT_MS,
			socketTimeout: TIMEOUT_MS,
		})
		transportUrl = url
	}
	return transport
}

export async function sendMail(msg: {
	to: string
	subject: string
	text: string
}): Promise<boolean> {
	const url = smtpUrl()
	const from = mailFrom()
	if (!url || !from) {
		console.warn('[notify] email skipped: SMTP not configured')
		return false
	}
	try {
		await getTransport(url).sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text })
		return true
	} catch (err) {
		console.warn(
			'[notify] email send failed:',
			err instanceof Error ? err.message.slice(0, 300) : err,
		)
		return false
	}
}
