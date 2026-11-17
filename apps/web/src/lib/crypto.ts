import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// AES-256-GCM at-rest encryption for secrets stored in postgres (deploy keys, webhook secrets).
// KEK is a 32-byte hex string in POWDER_ENCRYPTION_KEY. Generate with: openssl rand -hex 32
//
// Formats:
//   v1:<iv>:<tag>:<ct>   written by encryptSecret (hex parts; 12-byte IV, 16-byte tag)
//   <iv>:<tag>:<ct>      no version prefix: decrypted with the same key. Rewritten as v1 the next time the value is saved.
// The "v1" prefix is a format/key version marker: it is what a later key
// rotation (POWDER_ENCRYPTION_KEYS with old keys, "v2:" for the new one) hangs
// off. Rotation tooling is a documented follow-up, not implemented here.
const IV_BYTES = 12
const TAG_BYTES = 16
const CURRENT_VERSION = 'v1'
const HEX_RE = /^[0-9a-f]*$/i

function getKey(): Buffer {
	const hex = process.env.POWDER_ENCRYPTION_KEY
	if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
		throw new Error(
			'POWDER_ENCRYPTION_KEY must be set to a 64-char hex string (generate with: openssl rand -hex 32)',
		)
	}
	return Buffer.from(hex, 'hex')
}

/** True when POWDER_ENCRYPTION_KEY is a usable 64-char hex key. Does not throw. */
export function encryptionKeyIsValid(): boolean {
	try {
		getKey()
		return true
	} catch {
		return false
	}
}

export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(IV_BYTES)
	const cipher = createCipheriv('aes-256-gcm', getKey(), iv, { authTagLength: TAG_BYTES })
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	const tag = cipher.getAuthTag()
	return `${CURRENT_VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`
}

export function decryptSecret(payload: string): string {
	let parts = payload.split(':')
	if (parts[0] === CURRENT_VERSION) parts = parts.slice(1)
	else if (parts.length === 4) throw new Error(`unsupported encrypted payload version "${parts[0]}"`)
	if (parts.length !== 3) throw new Error('malformed encrypted payload')
	const [ivHex, tagHex, ctHex] = parts as [string, string, string]
	// Buffer.from(hex) silently truncates at the first bad character, and GCM
	// accepts short tags (a 4-byte tag is a 2^-32 forgery), so check strictly.
	if (![ivHex, tagHex, ctHex].every((p) => HEX_RE.test(p) && p.length % 2 === 0)) {
		throw new Error('malformed encrypted payload')
	}
	const iv = Buffer.from(ivHex, 'hex')
	const tag = Buffer.from(tagHex, 'hex')
	if (iv.length !== IV_BYTES) throw new Error('malformed encrypted payload: bad IV length')
	if (tag.length !== TAG_BYTES) throw new Error('malformed encrypted payload: bad auth tag length')
	const decipher = createDecipheriv('aes-256-gcm', getKey(), iv, { authTagLength: TAG_BYTES })
	decipher.setAuthTag(tag)
	const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()])
	return pt.toString('utf8')
}
