import { exec } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execP = promisify(exec)

// Generates an ed25519 SSH key pair using ssh-keygen (already in the docker image).
// Returns the OpenSSH public key (one-liner) and the private key (PEM-ish).
export async function generateDeployKey(): Promise<{ pub: string; priv: string }> {
	const dir = await mkdtemp(join(tmpdir(), 'powder-key-'))
	const keyPath = join(dir, 'key')
	try {
		await execP(`ssh-keygen -t ed25519 -N '' -C 'powder-deploy' -f '${keyPath}'`)
		const [pub, priv] = await Promise.all([
			readFile(`${keyPath}.pub`, 'utf8'),
			readFile(keyPath, 'utf8'),
		])
		return { pub: pub.trim(), priv }
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}
