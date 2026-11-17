// lib/secret-text.ts: the one rule set. Every fixture shape is masked, the
// mask is idempotent, readable log text survives, and the stream redactor
// catches tokens and PEM blocks split across chunks.
import { describe, expect, it } from 'vitest'
import { maskSecrets } from '../crons'
import { redactSecrets as llmRedact } from '../llm-redact'
import { MASK, SecretStreamRedactor, redactSecrets } from '../secret-text'
import { FX, SECRET_FIXTURES, corpusLog, leakedIn } from './fixtures/secret-corpus'

describe('redactSecrets covers the corpus', () => {
	for (const f of SECRET_FIXTURES) {
		it(`${f.id}: ${f.line.slice(0, 40)}`, () => {
			const out = redactSecrets(f.line)
			expect(out).not.toContain(f.secret)
			expect(out).toContain(MASK)
		})
	}
	it('the whole corpus at once', () => {
		expect(leakedIn(redactSecrets(corpusLog()))).toEqual([])
	})
	it('is idempotent', () => {
		const once = redactSecrets(corpusLog())
		expect(redactSecrets(once)).toBe(once)
	})
	it('keeps ordinary log lines readable', () => {
		for (const line of [
			'#12 [builder 4/9] RUN pnpm install --frozen-lockfile',
			`image sha256:${'ab12'.repeat(16)} tagged web:deploy-dep_1`,
			'commit 0123456789abcdef0123456789abcdef01234567 on main',
			'── docker compose up ──',
			'Error: connect ECONNREFUSED 127.0.0.1:5432',
		]) {
			expect(redactSecrets(line)).toBe(line)
		}
	})
	it('query parameters and curl -u', () => {
		expect(redactSecrets('GET https://x.example/a?sig_token=abc123&page=2')).not.toContain('abc123')
		expect(
			redactSecrets(`GET https://x.example/a?X-Amz-Signature=${'ab'.repeat(20)}`),
		).not.toContain('ab'.repeat(20))
		expect(redactSecrets('curl -u admin:hunter2pw https://x')).not.toContain('hunter2pw')
		expect(redactSecrets('Authorization: token abcdef0123456789')).not.toContain('abcdef0123456789')
	})
	it('crons.maskSecrets and llm-redact delegate to the authority', () => {
		const s = 'PGPASSWORD=pw1234 pg_dump; curl -H "Authorization: Bearer abcdefghijkl"'
		expect(maskSecrets(s)).toBe(redactSecrets(s))
		expect(llmRedact(s)).toBe(redactSecrets(s))
		expect(maskSecrets(s)).not.toContain('pw1234')
	})
})

describe('no over-masking of ordinary log text', () => {
	it('English words around a colon stay readable', () => {
		for (const line of [
			'unauthorized: authentication required',
			'Tests passed: 128',
			'Using cache key: node-modules-abc123',
			'auth check: /api/auth/ok returned 200',
			'key: value pairs are parsed',
			'token: expired, refreshing',
			'bypass=1 monkey=2',
		]) {
			expect(redactSecrets(line)).toBe(line)
		}
	})
	it('an @ in a URL path is not userinfo', () => {
		for (const line of [
			'GET https://registry.npmjs.org/@types/node/-/node-20.1.0.tgz',
			'fetch https://cdn.example.com/pkg/@scope/name@1.2.3/index.js',
			'ssh://git@github.com/acme/web.git',
		]) {
			expect(redactSecrets(line)).toBe(line)
		}
	})
	it('identifier-shaped names are still masked', () => {
		for (const [line, secret] of [
			['password=hunter2x', 'hunter2x'],
			['db_token: abc123def', 'abc123def'],
			['x-api-key: kkk999', 'kkk999'],
			['client_secret=sss888', 'sss888'],
			['apiKey: aaa777', 'aaa777'],
			['accessToken=ttt666', 'ttt666'],
			["{'db_token': 'q1w2e3'}", 'q1w2e3'],
			['password: letmein1', 'letmein1'],
			['https://u:p%40ss@host.example/x', 'p%40ss'],
		] as const) {
			expect(redactSecrets(line)).not.toContain(secret)
		}
	})
})

describe('PEM without END never swallows the rest of the log', () => {
	it('a BEGIN marker inside a command masks the marker only', () => {
		const log =
			'grep -q "-----BEGIN OPENSSH PRIVATE KEY-----" /root/.ssh/id\nok\n__POWDER_FAIL__ step=build code=1\n'
		const out = redactSecrets(log)
		expect(out).toContain('" /root/.ssh/id\nok\n__POWDER_FAIL__ step=build code=1\n')
		expect(out).not.toContain('-----BEGIN')
	})
	it('a truncated key masks its body lines and stops at the first log line', () => {
		const log = `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n${FX.PEM_BODY}\nMIIE${FX.PEM_BODY}\n── docker compose up ──\n__POWDER_FAIL__ step=docker compose up code=1`
		const out = redactSecrets(log)
		expect(out).not.toContain(FX.PEM_BODY.slice(0, 20))
		expect(out).toContain('── docker compose up ──\n__POWDER_FAIL__ step=docker compose up code=1')
	})
	it('stream: the same, split per line', () => {
		const log = `x\n-----BEGIN RSA PRIVATE KEY-----\n${FX.PEM_BODY}\nTAIL${FX.PEM_BODY}\n── build ──\n__POWDER_FAIL__ step=build code=1\n`
		const r = new SecretStreamRedactor()
		const out =
			log
				.split(/(?<=\n)/)
				.map((c) => r.push(c))
				.join('') + r.flush()
		expect(out).not.toContain(FX.PEM_BODY.slice(0, 20))
		expect(out).toContain('── build ──\n__POWDER_FAIL__ step=build code=1\n')
		const g = new SecretStreamRedactor()
		const grep = 'grep -q "-----BEGIN OPENSSH PRIVATE KEY-----" f\nnext line\n'
		expect(g.push(grep) + g.flush()).toContain('next line\n')
	})
})

describe('long lines are cut before the rules run', () => {
	it('at whitespace, never mid-token; a whitespace-free giant line is masked whole', () => {
		const tok = `ghp_${'Zz9'.repeat(30)}`
		const line = `${'word '.repeat(795)}${tok} ${'tail '.repeat(200)}\n`
		const out = redactSecrets(line)
		expect(out).toContain('[line cut]')
		expect(out).not.toMatch(/ghp_/)
		expect((out.split('\n')[0] ?? '').length).toBeLessThan(4096)
		expect(redactSecrets(`${'a'.repeat(5000)}\nnext`)).toBe('[redacted]\nnext')
		expect(redactSecrets(out)).toBe(out)
	})
})

describe('bare-token userinfo, PEM tails, stream == batch', () => {
	it('short bare usernames stay', () => {
		for (const line of [
			'ssh://git@github.com/acme/web.git',
			'https://oauth2@gitlab.example/acme/web.git',
			'https://x-access-token@github.com/acme/web.git',
		]) {
			expect(redactSecrets(line)).toBe(line)
		}
	})
	const tails: [string, string][] = [
		[
			`-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00FF\n\n${FX.PEM_BODY}\nshortTAIL==\nnext line of log here\n`,
			'next line of log here\n',
		],
		[
			`-----BEGIN RSA PRIVATE KEY-----\n${FX.PEM_BODY}\nabcd==\nnext line of log here\n`,
			'next line of log here\n',
		],
		[
			`-----BEGIN RSA PRIVATE KEY-----\n${FX.PEM_BODY}\nError: build failed\n`,
			'Error: build failed\n',
		],
		[
			`x\n-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00FF\n${FX.PEM_BODY}\n-----END RSA PRIVATE KEY-----\nafter\n`,
			'after\n',
		],
	]
	for (const [log, kept] of tails) {
		it(`batch keeps the line after the key whole: ${JSON.stringify(kept)}`, () => {
			const out = redactSecrets(log)
			expect(out.endsWith(kept)).toBe(true)
			expect(out).not.toContain(FX.PEM_BODY.slice(0, 20))
		})
		it(`stream output equals batch output: ${JSON.stringify(kept)}`, () => {
			for (const chunks of [log.split(/(?<=\n)/), [log], log.match(/[\s\S]{1,7}/g) ?? []]) {
				const r = new SecretStreamRedactor()
				const out = chunks.map((c) => r.push(c)).join('') + r.flush()
				expect(out).toBe(redactSecrets(log))
			}
		})
	}
})

describe('SecretStreamRedactor', () => {
	function stream(chunks: string[]): string {
		const r = new SecretStreamRedactor()
		return chunks.map((c) => r.push(c)).join('') + r.flush()
	}
	it('a token split across chunks', () => {
		const line = `using token ${FX.GHP} now\n`
		const cut = line.indexOf(FX.GHP) + 9
		const out = stream([line.slice(0, cut), line.slice(cut)])
		expect(out).not.toContain(FX.GHP.slice(4, 12))
		expect(out).toContain(MASK)
	})
	it('a PEM block split across chunks, one chunk per line', () => {
		const pem = `start\n-----BEGIN RSA PRIVATE KEY-----\n${FX.PEM_BODY}\nMORELINE${FX.PEM_BODY}\n-----END RSA PRIVATE KEY-----\nafter\n`
		const chunks = pem.split(/(?<=\n)/)
		const out = stream(chunks)
		expect(out).not.toContain(FX.PEM_BODY.slice(0, 20))
		expect(out).toContain('start\n')
		expect(out).toContain('after\n')
	})
	it('the corpus in 7-char chunks', () => {
		const log = `${corpusLog()}\n`
		const chunks: string[] = []
		for (let i = 0; i < log.length; i += 7) chunks.push(log.slice(i, i + 7))
		expect(leakedIn(stream(chunks))).toEqual([])
	})
	it('holds back a partial line until the newline or flush', () => {
		const r = new SecretStreamRedactor()
		expect(r.push('partial')).toBe('')
		expect(r.push(' line\nnext')).toBe('partial line\n')
		expect(r.flush()).toBe('next')
	})
})
