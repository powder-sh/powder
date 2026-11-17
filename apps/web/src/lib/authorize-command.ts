// The one command that authorizes powder's SSH key on a server. The add-server
// card shows it; the "can't reach <server>" card copies it. Pure, browser-safe.

export function authorizeCommand(pubkey: string): string {
	return `mkdir -p ~/.ssh && echo "${pubkey.trim()}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
}

// powder's public key, as the authorize command needs it. null when the key
// file is missing on the powder host.
export async function fetchPowderPubkey(): Promise<string | null> {
	try {
		const r = await fetch('/api/servers/ssh-key')
		const d = (await r.json()) as { pubkey?: string }
		return d.pubkey ?? null
	} catch {
		return null
	}
}
