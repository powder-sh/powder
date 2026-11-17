// The per-server helpers this powder ships (PER_SERVER_HELPERS with `installed`),
// read from powder's own files only: /app/helpers in the image (docker/web.Dockerfile
// copies infra/ there), else the checkout's infra/ dir (dev, tests). No env var
// can point it elsewhere: the bootstrap installs these as root on app servers.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type HelperKey, PER_SERVER_HELPERS, type ShippedHelperShas } from './server-bootstrap'

const IMAGE_HELPERS_DIR = '/app/helpers'

function helpersDir(): string | null {
	const candidates = [IMAGE_HELPERS_DIR, resolve(process.cwd(), 'infra'), resolve(process.cwd(), '../../infra')]
	return candidates.find((d) => existsSync(join(d, 'powder-migrate'))) ?? null
}

/** Content and sha256 of a shipped helper, or null when this powder has no copy. */
export function shippedHelper(key: HelperKey): { content: string; sha256: string } | null {
	const h = PER_SERVER_HELPERS.find((x) => x.key === key)
	const dir = helpersDir()
	if (!h?.installed || !dir) return null
	try {
		const content = readFileSync(join(dir, h.src), 'utf8')
		return { content, sha256: createHash('sha256').update(content).digest('hex') }
	} catch {
		return null
	}
}

export function shippedHelperShas(): ShippedHelperShas {
	const out: ShippedHelperShas = {}
	for (const h of PER_SERVER_HELPERS) {
		const s = shippedHelper(h.key)
		if (s) out[h.key] = s.sha256
	}
	return out
}
