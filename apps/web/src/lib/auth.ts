import { randomBytes } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from '@powder/db'
import { AUTH_DISABLED_PATHS } from './auth-paths'
import { allowUserCreate, onFirstUserCreated } from './first-run'
import { betterAuthIpOptions, betterAuthRateLimitRules } from './client-ip'
import { dashboardTrustedOrigins } from './hosts'
import { GITHUB_OAUTH_SCOPES } from './github-oauth-scopes'
import { signinLockoutHooks } from './signin-lockout'

const ghClientId = process.env.GITHUB_CLIENT_ID
const ghClientSecret = process.env.GITHUB_CLIENT_SECRET

export const githubOAuthConfigured = !!(ghClientId && ghClientSecret)

/** `next build` loads this module to collect page data. Without BETTER_AUTH_SECRET,
 *  better-auth then throws "default secret" once per build worker. This random
 *  secret exists only inside the build process (nothing is signed at build); a
 *  running powder never takes this path, and the boot check (startup-checks.ts)
 *  refuses to start without a real BETTER_AUTH_SECRET. Exported for tests. */
export function buildOnlySecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.NEXT_PHASE !== 'phase-production-build' || env.BETTER_AUTH_SECRET) return undefined
	return randomBytes(32).toString('hex')
}
const buildSecret = buildOnlySecret()

export const auth = betterAuth({
	...(buildSecret ? { secret: buildSecret } : {}),
	database: drizzleAdapter(db, { provider: 'pg' }),
	// Endpoints the UI does not call answer 404 (lib/auth-paths.ts).
	disabledPaths: [...AUTH_DISABLED_PATHS],
	emailAndPassword: {
		enabled: true,
		autoSignIn: true,
		minPasswordLength: 8,
		// Signup is gone: email accounts only come from POST /api/admin/users.
		disableSignUp: true,
	},
	databaseHooks: {
		user: {
			// Hard guard for every creation path (incl. GitHub OAuth first login):
			// only the first-run user (empty table, no admin ids configured, and
			// the setup-token cookie from /setup on the request, see first-run.ts).
			create: {
				before: async (_u, ctx) =>
					(await allowUserCreate(
						ctx?.headers?.get('cookie') ?? ctx?.request?.headers.get('cookie'),
					))
						? undefined
						: false,
				after: async (u) => onFirstUserCreated(u.id, u.email),
			},
		},
	},
	session: {
		expiresIn: 60 * 60 * 24 * 30,
		updateAge: 60 * 60 * 24,
	},
	account: {
		// No trustedProviders: a trusted provider skips the email-verified check,
		// so a GitHub account with an unverified primary email matching an
		// existing user would be linked into that user (incl. the admin).
		accountLinking: {
			enabled: true,
		},
		// GitHub tokens carry repo + admin:repo_hook: encrypt at rest. A
		// plaintext row still reads fine (see lib/oauth-token.ts).
		encryptOAuthTokens: true,
	},
	advanced: {
		// Which header carries the client IP for the login rate limiter:
		// POWDER_TRUSTED_IP_HEADER (lib/client-ip.ts). Default x-real-ip (Traefik);
		// cf-connecting-ip is right only when the origin is locked to Cloudflare.
		ipAddress: betterAuthIpOptions(),
	},
	// a request with no trusted client IP skips the per-IP limiter instead of
	// sharing one bucket with every other such request (lib/client-ip.ts).
	rateLimit: { customRules: betterAuthRateLimitRules() },
	// Per-email failure lockout (lib/signin-lockout.ts) on top of the per-IP
	// limiter, which a client controlling the IP header could sidestep.
	hooks: signinLockoutHooks(),
	socialProviders: ghClientId && ghClientSecret
		? {
				github: {
					clientId: ghClientId,
					clientSecret: ghClientSecret,
					// scopes powder needs to install deploy keys + webhooks
					scope: [...GITHUB_OAUTH_SCOPES],
				},
			}
		: undefined,
	// The dashboard origin (BETTER_AUTH_URL) plus its Traefik router hosts, never
	// a public-site host when split (lib/hosts.ts).
	trustedOrigins: [
		...dashboardTrustedOrigins(),
		...(process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3050', 'http://localhost:3000']),
	],
})
