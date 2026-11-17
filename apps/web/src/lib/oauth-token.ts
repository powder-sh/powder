import { symmetricDecrypt } from 'better-auth/crypto'
import { auth } from './auth'

// Reads a better-auth `account.accessToken`. With `encryptOAuthTokens` on, new
// logins store ciphertext; rows written before that are plaintext `gho_…`.
// Mirrors better-auth's own decryptOAuthToken heuristic so both shapes work.
export async function readOAuthAccessToken(token: string | null | undefined): Promise<string | null> {
	if (!token) return null
	const looksEncrypted = token.startsWith('$ba$') || (token.length % 2 === 0 && /^[0-9a-f]+$/i.test(token))
	if (!looksEncrypted) return token
	const ctx = await auth.$context
	return symmetricDecrypt({ key: ctx.secretConfig, data: token })
}
