import 'server-only'

/** GitHub OAuth is usable: both env vars are set (read at call time). */
export function githubOAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
}
