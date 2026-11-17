import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { requireUser } from '@/lib/access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const KEY_PATH = process.env.SSH_KEY_PATH ?? join(homedir(), '.ssh', 'id_ed25519')

export async function GET() {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	try {
		const pub = await readFile(`${KEY_PATH}.pub`, 'utf8')
		return Response.json({ pubkey: pub.trim() })
	} catch (err) {
		// Log the detail (it contains the key path); return a generic message.
		console.error('[ssh-key] read failed:', err)
		return Response.json({ error: 'pubkey not found' }, { status: 500 })
	}
}
