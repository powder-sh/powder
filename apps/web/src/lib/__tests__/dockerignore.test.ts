import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	DOCKERIGNORE_LINES,
	PROTECTED_DOCKERIGNORE_LINES,
	dockerignoreContent,
	writeDockerignoreShell,
} from '../app-runtime-files'
import { builderDockerignoreShell } from '../builder'
import { dockerfileFor } from '../framework-detect'

const bash = (script: string) =>
	spawnSync('bash', ['-c', `set -e; ${script}`], { encoding: 'utf8' })
const tmp = () => mkdtempSync(join(tmpdir(), 'powder-di-'))

describe('dockerignore content', () => {
	it('excludes every powder runtime secret', () => {
		expect(dockerignoreContent()).toMatchInlineSnapshot(`
			"# Written by powder: keeps deploy keys, compose secrets and DB data out of image layers.
			.deploy-key
			docker-compose.yml
			pgdata/
			kvdata/
			*.env
			.env*
			.git
			.powder-*
			"
		`)
		expect(DOCKERIGNORE_LINES).not.toContain('powder.json')
	})
})

describe('writeDockerignoreShell (apps/route.ts + preview-deploys.ts)', () => {
	it('creates the file when missing', () => {
		const d = tmp()
		expect(bash(writeDockerignoreShell(d)).status).toBe(0)
		expect(readFileSync(join(d, '.dockerignore'), 'utf8')).toBe(dockerignoreContent())
	})
	it('keeps a repo-supplied file and appends the missing entries once', () => {
		const d = tmp()
		writeFileSync(join(d, '.dockerignore'), 'node_modules\n.deploy-key\n')
		bash(writeDockerignoreShell(d))
		bash(writeDockerignoreShell(d))
		const lines = readFileSync(join(d, '.dockerignore'), 'utf8').split('\n')
		expect(lines).toContain('node_modules')
		for (const l of PROTECTED_DOCKERIGNORE_LINES)
			expect(lines.filter((x) => x === l)).toHaveLength(1)
		// never .git in a repo's own file (some builds COPY .git)
		expect(lines).not.toContain('.git')
	})
})

describe('builderDockerignoreShell (builder path)', () => {
	it('writes a default .dockerignore before docker build', () => {
		const d = tmp()
		const r = bash(`${builderDockerignoreShell(d)} echo OK`)
		expect(r.stdout).toContain('OK')
		expect(existsSync(join(d, '.dockerignore'))).toBe(true)
	})
	// a repo ignore file that does not list .deploy-key / *.env now
	// gets powder's entries appended (last) instead of failing the build.
	it('adds .deploy-key and *.env to a repo ignore file that does not list them', () => {
		const d = tmp()
		writeFileSync(join(d, '.deploy-key'), 'k')
		writeFileSync(join(d, 'prod.env'), 'A=1')
		writeFileSync(join(d, '.dockerignore'), 'node_modules\n')
		const r = bash(`${builderDockerignoreShell(d)} echo OK`)
		expect(r.stdout).toContain('OK')
		const lines = readFileSync(join(d, '.dockerignore'), 'utf8').trim().split('\n')
		expect(lines).toContain('node_modules')
		expect(lines.slice(-PROTECTED_DOCKERIGNORE_LINES.length)).toEqual([
			...PROTECTED_DOCKERIGNORE_LINES,
		])
	})
	it('passes when the secrets are present but ignored', () => {
		const d = tmp()
		mkdirSync(join(d, 'x'))
		writeFileSync(join(d, '.deploy-key'), 'k')
		writeFileSync(join(d, 'prod.env'), 'A=1')
		writeFileSync(join(d, '.dockerignore'), dockerignoreContent())
		expect(bash(`${builderDockerignoreShell(d)} echo OK`).stdout).toContain('OK')
	})
})

describe('generated Dockerfiles', () => {
	const fw = (id: string) => ({ id, displayName: id, defaultContainerPort: 3000 })
	it('are all multi-stage on node:22 and never copy the whole workdir into the runtime stage unscrubbed', () => {
		for (const id of ['next', 'vite', 'remix', 'bun-server', 'node', 'unknown']) {
			const df = dockerfileFor(fw(id), 'npm', 'myapp')
			expect(df.match(/^FROM /gm)?.length, id).toBe(2)
			expect(df, id).not.toContain('node:20')
			const runtime = df.slice(df.lastIndexOf('\nFROM '))
			expect(runtime, id).not.toMatch(/COPY \. /)
		}
	})
	it('node/bun/default scrub powder files in the build stage', () => {
		for (const id of ['bun-server', 'node', 'unknown']) {
			const df = dockerfileFor(fw(id), 'npm', 'myapp')
			const build = df.slice(0, df.lastIndexOf('\nFROM '))
			expect(build).toContain(
				'RUN rm -rf .deploy-key docker-compose.yml pgdata kvdata .git .powder-* .env* *.env',
			)
		}
	})
	it('node snapshot', () => {
		expect(dockerfileFor(fw('node'), 'npm', 'myapp')).toMatchInlineSnapshot(`
			"# syntax=docker/dockerfile:1.4@sha256:9ba7531bd80fb0a858632727cf7a112fbfd19b17e94c4e84ced81e24ef1a0dbc
			# Powder-generated Dockerfile (Node server)
			FROM node:22.23.3-alpine AS build
			WORKDIR /app
			COPY package*.json ./
			RUN --mount=type=cache,id=myapp-npm-cache,target=/root/.npm npm ci
			COPY . .
			RUN rm -rf .deploy-key docker-compose.yml pgdata kvdata .git .powder-* .env* *.env

			FROM node:22.23.3-alpine
			WORKDIR /app
			ENV PORT=3000
			COPY --from=build /app ./
			EXPOSE 3000
			CMD ["npm", "start"]
			"
		`)
	})
})
