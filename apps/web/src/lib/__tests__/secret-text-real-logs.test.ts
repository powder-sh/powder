// Representative deploy log text: what must stay readable, and that a secret straddling the
// long-line cut is still masked, in batch and stream alike.
import { describe, expect, it } from 'vitest'
import { SecretStreamRedactor, redactSecrets } from '../secret-text'

const READABLE = [
	'{"authorId":"cl9x2k3j40000qz8a1b2c3d4e","authMode":"jwt","credits":504}',
	'"author": "sam", "keyboard": "en", "cache_key": "users/123"',
	'Error response from daemon: Conflict. The container name "/web" is already in use by container "4f1c2a9be0d34c7a8b6e5f4d3c2b1a09f8e7d6c5b4a3928170f6e5d4c3b2a190". You have to remove it.',
	'Error: removal of container 4f1c2a9be0d34c7a8b6e5f4d3c2b1a09f8e7d6c5b4a3928170f6e5d4c3b2a190 is already in progress',
	'failed to copy: write /var/lib/containerd/io.containerd.content.v1.content/ingest/0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9/data: no space left on device',
	'RUN if [ -n "$NPM_TOKEN" ]; then echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc; fi',
	'ARG NEXT_PUBLIC_POSTHOG_KEY="${NEXT_PUBLIC_POSTHOG_KEY:-}"',
	'image sha256:0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9 tagged',
	'commit 0123456789abcdef0123456789abcdef01234567',
	'CACHE_KEY=node-modules',
	'GET /api/posts?authorId=12&page=2',
]

describe('representative deploy log lines stay readable', () => {
	for (const line of READABLE) {
		it(line.slice(0, 60), () => {
			expect(redactSecrets(line)).toBe(line)
		})
	}
})

describe('a quoted secret straddling the 4 KB line cut is masked', () => {
	const cases: [string, string][] = [
		['"db_password": "my long secret phrase here and more words to go"', 'secret phrase'],
		["DATABASE_PASSWORD='hunter two three four five six seven'", 'two three'],
	]
	for (const [tail, secret] of cases) {
		it(`${tail.slice(0, 30)}: every offset 3900..4100`, () => {
			for (let at = 3900; at <= 4100; at += 7) {
				const pad = `${'w '.repeat(Math.ceil(at / 2)).slice(0, at - 1)} `
				const line = `${pad}${tail} end\n`
				const batch = redactSecrets(line)
				expect(batch).not.toContain(secret)
				const r = new SecretStreamRedactor()
				const stream =
					line
						.match(/[\s\S]{1,500}/g)
						?.map((c) => r.push(c))
						.join('') + r.flush()
				expect(stream).toBe(batch)
			}
		})
	}
})

// Shapes main masked (or should have) that the narrowed
// name rules let through. Each must be masked.
const H = 'a3f9c2e1b4d5a6f7e8c9b0a1d2e3f4a5b6c7d8e9'
const LEAKS: [string, string][] = [
	[`X-API-KEY: ${H}`, H],
	[`X-Api-Key: ${H}`, H],
	[`Api-Key: ${H}`, H],
	[`API-KEY: ${H}`, H],
	[`X-Vault-Token: ${H}`, H],
	[`X-Gitlab-Token: ${H}`, H],
	[`PRIVATE-TOKEN: ${H}`, H],
	[`X-Auth-Token: ${H}`, H],
	['Server=x;User Id=sa;Password=hunter2;', 'hunter2'],
	['Pwd=hunter2', 'hunter2'],
	[`Secret=${H}`, H],
	[`Token=${H}`, H],
	[`ApiKey=${H}`, H],
	[`Api_Key=${H}`, H],
	[`--token=${H}`, H],
	['--password=hunter2', 'hunter2'],
	[`--api-key=${H}`, H],
	[`--secret=${H}`, H],
	[`--auth-token=${H}`, H],
	[`--registry-password=${H}`, H],
	[`--token ${H}`, H],
	['--password hunter2', 'hunter2'],
	[`docker login -u me -p ${H} ghcr.io`, H],
	['mysql -uroot -phunter2pass app', 'hunter2pass'],
	[`cloudflared tunnel run --token ${H}`, H],
	[`token: ${H}`, H],
	[`apikey: ${H}`, H],
	[`"License-Key": "${H}"`, H],
	[`"key": "${H}"`, H],
	[`key=${H}`, H],
	[`'auth_token' => '${H}'`, H],
	[`DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${H}==;EndpointSuffix=core`, H],
	[`Endpoint=sb://x/;SharedAccessKeyName=root;SharedAccessKey=${H}`, H],
	[`Cookie: sid=${H}`, H],
	[`//npm.pkg.github.com/:_authToken=${H}`, H],
]

describe('leak corpus: case, kebab, CLI flags, login, YAML, Azure, cookies, npmrc', () => {
	for (const [line, secret] of LEAKS) {
		it(line.slice(0, 50), () => {
			expect(redactSecrets(line)).not.toContain(secret)
		})
	}
})

describe('ordinary text next to the leak corpus stays readable', () => {
	for (const line of [
		'docker run -p 3000:3000 -p 5432:5432 web',
		'psql -h db -p 5432 -U app',
		'"better-auth":"^1.7.7"',
		'"next-auth": "4.24.11"',
		'docker login --password-stdin ghcr.io',
		'Pass: 12 Fail: 0',
		'token: expired, refreshing',
		'Using cache key: node-modules-abc123',
		'GH_TOKEN=$GH_TOKEN',
		'{"authorId":"u_1","authMode":"jwt","credits":5}',
	]) {
		it(line, () => {
			expect(redactSecrets(line)).toBe(line)
		})
	}
})
