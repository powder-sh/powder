import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { addSourceRefusal, dockerfileRewriteFunctions, runNamespaceArgName } from '../build-cache'
import { writeFakeDocker } from './fixtures/fake-docker'

// ADD URL / git / variable sources, the per-app namespace ARG after every FROM, and
// RUN --network / --security / --device in flag position. Server-side awk, run with
// the awk on PATH. Invented names only.

const NS = 'b2c3d4e5f60718293a4b5c6d7e8f90a1'
const NS2 = 'c3d4e5f60718293a4b5c6d7e8f90a1b2'
const root = mkdtempSync(join(tmpdir(), 'df-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const bin = join(root, 'bin')
mkdirSync(bin)
writeFakeDocker(bin, '#!/bin/bash\nexit 1\n')

let n = 0
function rewrite(dockerfile: string, ns = NS, app = 'demoapp') {
	const dir = join(root, `c${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), dockerfile)
	const script = `DFR_NS=${ns}; DFR_APP=${app}; DFR_DIR=$(mktemp -d); DFR_MODE=enforce; DFR_PULL=1; DFR_OWN=''; ${dockerfileRewriteFunctions(app)}dfr_one ${JSON.stringify(join(dir, 'Dockerfile'))} ${JSON.stringify(join(dir, 'out'))}`
	const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
	const out = existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : ''
	return { code: r.status, log: r.stdout + r.stderr, out }
}
const refusals = (df: string) => rewrite(df).log.split('\n').filter((l) => l.includes('refusing'))

describe('ADD sources fetched outside the build context', () => {
	it('refuses URL, git, scp-form and variable sources, also under ONBUILD, over a continuation and in JSON form', () => {
		for (const line of [
			'ADD https://example.invalid/tool.tar.gz /opt/',
			'ADD http://127.0.0.1:2375/version /v',
			'ADD git@github.com:example-org/private.git /src',
			'ADD deploy@git.example.invalid:repo.git /src',
			'ADD https://github.com/example-org/repo.git#main /src',
			'ADD example.invalid/example-org/repo.git /src',
			'ADD ${TOOL_URL} /opt/',
			'ADD $SRC /opt/',
			'ADD ./a https://example.invalid/b /dst/',
			'ONBUILD ADD https://example.invalid/x /x',
			'ADD \\\n  https://example.invalid/split /split',
			'ADD ["https://example.invalid/j", "/j"]',
			'ADD ["https://example.invalid/k","/k"]',
			'ADD --checksum=sha256:0123 https://example.invalid/c /c',
			'ADD --keep-git-dir=true https://example.invalid/r.git /r',
		]) {
			const r = rewrite(`FROM node:22-alpine\n${line}\n`)
			expect(r.code, line).not.toBe(0)
			expect(r.log, line).toMatch(/refusing .*ADD/)
		}
	})
	it('refuses --checksum / --keep-git-dir even with a local source', () => {
		expect(rewrite('FROM x\nADD --keep-git-dir=true ./a /a\n').code).not.toBe(0)
		expect(rewrite('FROM x\nADD --checksum=sha256:00 ./a /a\n').code).not.toBe(0)
	})
	it('passes local sources, heredocs, a variable destination and COPY', () => {
		for (const line of [
			'ADD ./vendor.tar.gz /opt/',
			'ADD --chown=node:node package.json yarn.lock /app/',
			'ADD . /app',
			'ADD ["package.json", "/app/"]',
			'ADD <<EOT /etc/motd\nhello\nEOT',
			'ADD config.json $APP_HOME/',
			'COPY https-notes.txt /app/',
		]) {
			const r = rewrite(`FROM node:22-alpine\n${line}\n`)
			expect(r.code, `${line}\n${r.log}`).toBe(0)
		}
	})
	it('the TS rule and the awk agree on every source', () => {
		for (const src of [
			'https://example.invalid/a',
			'HTTP://EXAMPLE.INVALID/A',
			'git@example.invalid:o/r',
			'u@h:p',
			'./local@2x.png',
			'$X',
			'${X:-a}',
			'github.com/o/r',
			'o/r.git',
			'r.git#v1',
			'./src',
			'package.json',
			'["https://example.invalid/q",',
			'"/dst"]',
			'<<EOT',
		]) {
			const ts = addSourceRefusal(src)
			const r = rewrite(`FROM x\nADD ${src} /dst/\n`)
			expect(r.log.includes('ADD source'), src).toBe(ts !== null)
		}
	})
})

describe('RUN flags in flag position', () => {
	it('refuses --network other than default / none, any --security, any --device', () => {
		for (const f of ['--network=host', '--network=bridge', '--NETWORK=host', '--security=insecure', '--security=sandbox', '--device=/dev/fuse', '--device=name=x'])
			expect(rewrite(`FROM x\nRUN ${f} true\n`).code, f).not.toBe(0)
		expect(rewrite('FROM x\nONBUILD RUN --network=host true\n').code).not.toBe(0)
		expect(rewrite('FROM x\nRUN --mount=type=cache,target=/root/.npm \\\n  --network=host npm ci\n').code).not.toBe(0)
	})
	it('passes default / none and the common shape: --network-timeout after the command', () => {
		for (const df of [
			'FROM x\nRUN --network=none true\n',
			'FROM x\nRUN --network=default true\n',
			'FROM node:22-alpine AS deps\nRUN yarn install --frozen-lockfile --network-timeout 300000 --ignore-scripts\n',
			'FROM node:22-alpine\nRUN --mount=type=cache,target=/usr/local/share/.cache/yarn yarn install --frozen-lockfile --network-timeout 300000\n',
			'FROM node:22-alpine\nRUN yarn install \\\n  --network-timeout 300000 \\\n  --frozen-lockfile\n',
			'FROM x\nRUN echo --security=insecure --device=/dev/x --network=host\n',
		]) {
			const r = rewrite(df)
			expect(r.code, `${df}\n${r.log}`).toBe(0)
		}
	})
})

describe('per-app namespace ARG after every FROM', () => {
	const arg = `ARG ${runNamespaceArgName(NS)}=1`
	it('inserts the ARG after every FROM (AS, continuation, multi-stage, comments in between)', () => {
		const r = rewrite(
			'# syntax=docker/dockerfile:1\nFROM node:22-alpine AS deps\nRUN --mount=type=secret,id=envfile,target=/app/.env.local yarn build\nFROM node:22-alpine \\\n  # a comment\n  AS runner\nCOPY --from=deps /app /app\nfrom deps\nRUN true\n',
		)
		expect(r.code, r.log).toBe(0)
		expect(r.out).toBe(
			// a FROM that reads an image is written back as one line with its pin
			// token (dfr_bases replaces it); a comment inside it comes first
			`# syntax=docker/dockerfile:1\nFROM __POWDER_BASE_1__ AS deps\n${arg}\nRUN --mount=type=secret,id=envfile,target=/app/.env.local yarn build\n  # a comment\nFROM __POWDER_BASE_2__ AS runner\n${arg}\nCOPY --from=deps /app /app\nfrom deps\n${arg}\nRUN true\n`,
		)
	})
	it('is an ARG (never ENV) with a per-app name; one app keeps its name', () => {
		const a = rewrite('FROM x\nRUN true\n', NS).out
		const b = rewrite('FROM x\nRUN true\n', NS2).out
		expect(a).toContain(arg)
		expect(b).toContain(`ARG ${runNamespaceArgName(NS2)}=1`)
		expect(runNamespaceArgName(NS)).not.toBe(runNamespaceArgName(NS2))
		expect(rewrite('FROM x\nRUN true\n', NS).out).toBe(a)
		expect(a).not.toMatch(/^ENV /m)
	})
	it('leaves heredoc bodies alone and refuses a FROM inside one', () => {
		const df = 'FROM x\nCOPY <<EOF /app/notes.txt\nnot an instruction\nEOF\nRUN <<-SCRIPT\n\techo hi\n\tSCRIPT\nRUN true\n'
		const r = rewrite(df)
		expect(r.code, r.log).toBe(0)
		expect(r.out).toBe(df.replace('FROM x\n', `FROM __POWDER_BASE_1__\n${arg}\n`))
		const bad = rewrite('FROM x\nCOPY <<EOF /app/Dockerfile.inner\nFROM scratch\nEOF\n')
		expect(bad.code).not.toBe(0)
		expect(bad.log).toContain('FROM line inside a heredoc body')
	})
	it('refuses the reserved name in the Dockerfile (an ENV could set another app\'s name)', () => {
		expect(rewrite(`FROM x\nENV ${runNamespaceArgName(NS2)}=1\nRUN true\n`).code).not.toBe(0)
		expect(rewrite('FROM x\nARG powder_ns_x\n').code).not.toBe(0)
		expect(rewrite('# POWDER_NS in a comment is fine\nFROM x\n').code).toBe(0)
	})
})

describe('refusals are lines the operator can read', () => {
	it('names the offending word', () => {
		expect(refusals('FROM x\nADD https://example.invalid/a /a\n').join('\n')).toContain('https://example.invalid/a')
		expect(refusals('FROM x\nRUN --network=host true\n').join('\n')).toContain('--network=host')
	})
})
