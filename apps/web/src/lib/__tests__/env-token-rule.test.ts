import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deniedNote, envKeyWriteDenied, tokenEnvWriteRefusal } from '../env-key-policy'

// one rule for every env write that is not an admin browser session.

const LOADER_KEYS = [
	'COREPACK_NPM_REGISTRY', 'COREPACK_HOME', 'COREPACK_ENABLE_STRICT', 'PNPM_HOME', 'NPM_TOKEN', 'NPM_CONFIG_REGISTRY',
	'YARN_REGISTRY', 'BUN_INSTALL', 'UV_INDEX_URL', 'POETRY_REPOSITORIES_X', 'PIPENV_PYPI_MIRROR', 'PIP_INDEX_URL',
	'PRISMA_QUERY_ENGINE_LIBRARY', 'DENO_DIR', 'GOPROXY', 'GOFLAGS', 'GOTOOLCHAIN', 'GOPATH', 'GOROOT', 'GONOSUMDB', 'CGO_LDFLAGS',
	'PHPRC', 'PHP_INI_SCAN_DIR', 'PYTHONWARNINGS', 'RUBYOPT', 'GEM_HOME', 'BUNDLE_GEMFILE', 'PERLLIB', 'PERL5OPT',
	'JAVA_HOME', 'SPRING_CONFIG_LOCATION', 'MANAGEMENT_ENDPOINTS_WEB_EXPOSURE_INCLUDE', 'LOGGING_CONFIG',
	'SHELLOPTS', 'BASHOPTS', 'PS4', 'HOSTALIASES', 'GCONV_PATH', 'LOCPATH', 'RES_OPTIONS', 'LOCALDOMAIN', 'CLASSPATH',
	'NODE_ICU_DATA', 'SPRING_APPLICATION_JSON',
]
const DEST_KEYS = [
	'MAIL_API_URL', 'METRICS_INGEST_URL', 'DATABASE_URL', 'NEXT_PUBLIC_SITE_URL', 'AUTH_REDIRECT_URI', 'SMTP_HOST', 'API_HOSTNAME',
	'S3_ENDPOINT', 'SENTRY_DSN', 'MAIL_SERVER', 'BIND_ADDR', 'RELAY_ADDRESS', 'IMAGE_REGISTRY', 'PKG_MIRROR', 'APP_HOME',
	'UPLOAD_PATH', 'DATA_DIR', 'KEY_FILE', 'APP_CONFIG', 'OUTBOUND_PROXY', 'OTEL_EXPORTER_OTLP_HEADERS', 'SENTRY_ORG',
	'PGHOST', 'PGPASSWORD', 'MYSQL_PWD', 'MONGODB_URI', 'MONGO_OPTS', 'REDIS_TLS', 'REDISCLOUD',
	'mail_api_url',
	// the marker in the middle
	'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING', 'NEXTAUTH_URL_INTERNAL', 'API_URI_V2', 'SMTP_HOST_PRIMARY', 'SENTRY_DSN_PUBLIC',
	'S3_ENDPOINT_EU', 'BIND_ADDR_V6', 'MAIL_SERVER_BACKUP',
]
// tokens write credential-shaped keys only; ordinary keys (NOT_CREDENTIAL) are refused.
const CREDENTIAL = ['BETTER_AUTH_SECRET', 'MAIL_API_KEY', 'GOOGLE_CLIENT_SECRET', 'STRIPE_WEBHOOK_SECRET', 'CRON_TOKEN']
const NOT_CREDENTIAL = ['URLSCAN_LIMIT', 'HOSTED_MODE', 'FEATURE_FLAG_X', 'STRIPE_PRICE_ID', 'NEXT_PUBLIC_SITE_NAME', 'NODE_ENV', 'GOOGLE_CLIENT_ID', 'PORT']

describe('tokenEnvWriteRefusal (every token env write path)', () => {
	it('every listed loader / toolchain key is refused for a token and allowed for an admin session', () => {
		for (const k of LOADER_KEYS) {
			expect(envKeyWriteDenied(k, 'x', false), k).toMatch(/set it from the dashboard/)
			expect(envKeyWriteDenied(k, 'x', true), k).toBeNull()
		}
	})
	it('every destination / config-shaped key is refused for a token, create and update alike', () => {
		for (const k of DEST_KEYS) {
			expect(tokenEnvWriteRefusal(k, 'https://example.invalid'), k).toMatch(/decides where the app connects|changes how/)
			expect(envKeyWriteDenied(k, 'https://example.invalid', true), k).toBeNull()
		}
	})
	it('credential keys stay allowed for tokens; NODE_ENV, other keys and NODE_OPTIONS are refused', () => {
		for (const k of CREDENTIAL) expect(tokenEnvWriteRefusal(k, 'value-1'), k).toBeNull()
		for (const k of NOT_CREDENTIAL) {
			expect(tokenEnvWriteRefusal(k, 'value-1'), k).toMatch(/not a credential key/)
			expect(envKeyWriteDenied(k, 'value-1', true), k).toBeNull()
		}
		expect(tokenEnvWriteRefusal('NODE_OPTIONS', '--max-old-space-size=4096')).not.toBeNull()
		expect(tokenEnvWriteRefusal('NODE_OPTIONS', '--require /tmp/x.js')).not.toBeNull()
	})
	it('a value with a line break is refused for a token, for every key; an admin may', () => {
		for (const v of ['a\nb', 'a\rb', 'x\r\n']) {
			expect(tokenEnvWriteRefusal('APP_SECRET', v), JSON.stringify(v)).toMatch(/line break/)
			expect(envKeyWriteDenied('APP_SECRET', v, true)).toBeNull()
		}
	})
	it('an import / backfill names the keys it skipped', () => {
		expect(deniedNote([])).toEqual({})
		expect(deniedNote(['DATABASE_URL', 'COREPACK_HOME']).deniedNote).toContain('DATABASE_URL, COREPACK_HOME')
		const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')
		expect(src('app/api/projects/[id]/env/route.ts')).toContain('...deniedNote(result.deniedKeys)')
		expect(src('app/api/projects/[id]/env/backfill/route.ts')).toContain('...deniedNote(result.deniedKeys)')
		expect(src('app/api/servers/[id]/containers/[name]/repo/import/route.ts')).toContain("r.deniedKeys.join(', ')")
	})
	it('every env write path goes through the one rule', () => {
		const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')
		expect(src('lib/env-vars-db.ts')).toMatch(/export async function setForProject[\s\S]{0,300}envKeyWriteDenied\(key, value, ctx\.adminSession === true, refusalCaller\(ctx\)\)/)
		expect(src('lib/env-vars-db.ts')).toMatch(/if \(envKeyWriteDenied\(key, value, ctx\.adminSession === true\)\) \{\s*deniedKeys\.push/)
		expect(src('lib/env-vars-db.ts')).toMatch(/export async function rollbackToVersion[\s\S]{0,1500}setForProject\(/)
		expect(src('app/api/servers/[id]/containers/[name]/env-file/route.ts')).toContain('envKeyWriteDenied(e.key, e.value, false)')
		expect(src('app/api/apps/route.ts')).toContain("envKeyWriteDenied(e.key, e.value, isAdminSession(user), user.viaToken === true ? 'token' : 'session')")
	})
})
