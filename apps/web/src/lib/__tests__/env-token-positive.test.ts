import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	envKeyDeleteDenied,
	envKeyWriteDenied,
	isCredentialShapedEnvKey,
	tokenEnvOperatorAllows,
	tokenEnvWriteRefusal,
} from '../env-key-policy'

// the token env rule is positive now. A token may write (create or update) or
// delete a key only when it is credential-shaped and passes the deny rules, or when the
// operator allows it (POWDER_TOKEN_ENV_ALLOW). Admin browser sessions are unchanged.
// Invented app names.

afterEach(() => {
	vi.unstubAllEnvs()
})

// Credential shapes a token writes in practice (names and app suffixes invented).
const LIVE_SHAPES = [
	'SUPPORT_INTERNAL_SECRET',
	'WEBHOOK_SECRET_DEMOAPP',
	'WEBHOOK_SECRET_SHOP_EXAMPLE',
	'MAILER_TOKEN',
	'MAILER_TOKEN_DEMOAPP',
	'MAILER_TOKEN_BLOG_EXAMPLE_COM',
]

// Keys the earlier denylist rule still let a token write.
const AUDIT_REFUSED = [
	'NEXT_PUBLIC_ANALYTICS_SRC',
	'POSTAPP_BASE',
	'CORS_ORIGIN',
	'WEBHOOKS_ALLOW_PRIVATE',
	'DEBUG',
	'NODE_DEBUG',
	'NODE_ENV',
	'ENABLE_SIGNUPS',
	'ALLOWED_ORIGINS',
	'TRUSTED_HOPS',
	'LOG_LEVEL',
	'PORT',
	'TZ',
	'ADMIN_EMAILS',
	'FEATURE_FLAGS',
]

describe('positive token rule', () => {
	it('keeps every live token shape allowed, create and update, and their deletes', () => {
		for (const k of LIVE_SHAPES) {
			expect(tokenEnvWriteRefusal(k, 'v-1'), k).toBeNull()
			expect(envKeyWriteDenied(k, 'v-2', false), k).toBeNull()
			expect(envKeyDeleteDenied(k, false), k).toBeNull()
		}
	})

	it('allows the credential suffixes and segments', () => {
		for (const k of ['APP_SECRET', 'CRON_TOKEN', 'MAIL_API_KEY', 'STRIPE_SECRET_KEY', 'JWT_SECRET_V2', 'X_TOKEN_OLD', 'app_secret'])
			expect(isCredentialShapedEnvKey(k), k).toBe(true)
		for (const k of ['SECRET', 'TOKEN', 'KEY', 'MONKEY', 'KEY_ROTATION_DAYS', 'TOKENS_PER_MIN', 'SECRETS_ENABLED', 'API_KEY_ID'])
			expect(isCredentialShapedEnvKey(k), k).toBe(false)
	})

	it('never treats NEXT_PUBLIC_* or *_PUBLIC_KEY as credentials', () => {
		for (const k of ['NEXT_PUBLIC_STRIPE_KEY', 'NEXT_PUBLIC_API_TOKEN', 'JWT_PUBLIC_KEY', 'PUBLIC_KEY', 'VAPID_PUBLIC_KEY', 'next_public_x_secret']) {
			expect(isCredentialShapedEnvKey(k), k).toBe(false)
			expect(tokenEnvWriteRefusal(k, 'v'), k).toMatch(/not a credential key/)
		}
	})

	it('refuses the known bypass keys for tokens (write and delete) and keeps them for admin sessions', () => {
		for (const k of AUDIT_REFUSED) {
			expect(tokenEnvWriteRefusal(k, 'on'), k).toMatch(/not a credential key a token may set/)
			expect(envKeyDeleteDenied(k, false), k).toMatch(/not a credential key a token may delete/)
			expect(envKeyWriteDenied(k, 'on', true), k).toBeNull()
			expect(envKeyDeleteDenied(k, true), k).toBeNull()
		}
	})

	it('the deny rules still win over a credential shape', () => {
		for (const k of ['GIT_TOKEN', 'NPM_TOKEN', 'SSH_KEY', 'DOCKER_AUTH_TOKEN', 'REDIS_TOKEN', 'JWT_SECRET_FILE', 'API_KEY_PATH', 'PGSECRET', 'SENTRY_AUTH_TOKEN', 'COREPACK_NPM_TOKEN', 'TOKEN_URL_SECRET'])
			expect(tokenEnvWriteRefusal(k, 'v'), k).not.toBeNull()
		expect(tokenEnvWriteRefusal('APP_SECRET', 'a\nb')).toMatch(/line break/)
	})

	it('POWDER_TOKEN_ENV_ALLOW adds whole-key matches; the deny rules still apply; a bad pattern allows nothing', () => {
		vi.stubEnv('POWDER_TOKEN_ENV_ALLOW', 'NODE_ENV|FEATURE_[A-Z]+|LD_PRELOAD|.*_URL')
		expect(tokenEnvWriteRefusal('NODE_ENV', 'production')).toBeNull()
		expect(tokenEnvWriteRefusal('FEATURE_SIGNUPS', 'on')).toBeNull()
		expect(envKeyDeleteDenied('FEATURE_SIGNUPS', false)).toBeNull()
		// whole-key match only
		expect(tokenEnvWriteRefusal('XNODE_ENV', 'production')).toMatch(/not a credential key/)
		expect(tokenEnvWriteRefusal('NODE_ENV_X', 'production')).toMatch(/not a credential key/)
		// deny rules
		expect(tokenEnvWriteRefusal('LD_PRELOAD', '/tmp/x.so')).toMatch(/changes how/)
		expect(tokenEnvWriteRefusal('MAIL_API_URL', 'https://example.invalid')).toMatch(/decides where/)
		expect(tokenEnvWriteRefusal('NODE_ENV', 'a\nb')).toMatch(/line break/)
		expect(tokenEnvOperatorAllows('NODE_ENV', '(')).toBe(false)
		expect(tokenEnvOperatorAllows('NODE_ENV', '')).toBe(false)
		expect(tokenEnvOperatorAllows('NODE_ENV', '   ')).toBe(false)
	})

	it('ordinary app keys are refused unless credential-shaped', () => {
		// a few representative app env names.
		for (const k of ['SITE_NAME', 'DEFAULT_LOCALE', 'MAX_UPLOAD_MB', 'RATE_LIMIT_PER_MIN', 'MAIL_SES_ACCESS_KEY_ID'])
			expect(tokenEnvWriteRefusal(k, 'x'), k).toMatch(/not a credential key/)
		for (const k of ['UNSUBSCRIBE_SECRET', 'METRICS_INGEST_TOKEN', 'SHOP_SES_SECRET_ACCESS_KEY'])
			expect(tokenEnvWriteRefusal(k, 'x'), k).toBeNull()
	})

	it('every delete path runs the rule: DELETE route, deleteForProject, the env-file PUT', () => {
		const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')
		expect(src('lib/env-vars-db.ts')).toMatch(/export async function deleteForProject[\s\S]{0,300}envKeyDeleteDenied\(key, ctx\.adminSession === true, refusalCaller\(ctx\)\)/)
		expect(src('app/api/projects/[id]/env/[key]/route.ts')).toContain('err instanceof EnvKeyDeniedError')
		expect(src('app/api/servers/[id]/containers/[name]/env-file/route.ts')).toContain('envKeyDeleteDenied(k, false)')
	})
})
