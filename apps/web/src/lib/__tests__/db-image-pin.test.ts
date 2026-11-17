import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderComposeYaml } from '../compose-render'
import { POSTGRES_IMAGE, REDIS_IMAGE } from '../db-images'

const REPO = resolve(__dirname, '../../../../..')

// A db image tag must carry a full version (major.minor at least): no bare
// pg16, 16, latest, 16-alpine. Floating tags restart databases on pull.
function assertPinned(image: string) {
	const tag = (image.split('@')[0] ?? '').split(/:(.+)/)[1]
	expect(tag, `${image} has no tag`).toBeTruthy()
	expect(tag, `${image} tag is floating`).toMatch(/^\d+\.\d+(\.\d+)?(-[a-z0-9.]+)*$/)
	expect(image, `${image} is not digest-pinned`).toMatch(/@sha256:[0-9a-f]{64}$/)
}

// Compose files: powder's own db may keep a moving tag name (pg16) as long as
// the digest pins it, so only the digest is required there.
function assertDigest(image: string) {
	expect(image, `${image} is not digest-pinned`).toMatch(/@sha256:[0-9a-f]{64}$/)
}

const DB_IMAGE_RE = /^\s*image:\s*['"]?((?:[\w.-]+\/)*(?:postgres|pgvector|redis)[\w./-]*:[^\s'"]+|(?:[\w.-]+\/)*(?:postgres|pgvector|redis)[\w./-]*)['"]?\s*$/gm

describe('db image pinning', () => {
	it('constants are exact versions', () => {
		assertPinned(POSTGRES_IMAGE)
		assertPinned(REDIS_IMAGE)
	})

	it('renderComposeYaml emits the pinned constant for the bundled db', () => {
		const yaml = renderComposeYaml({
			name: 'myapp',
			dockerfilePath: './Dockerfile',
			hostPort: null,
			containerPort: 3000,
			envFilePath: '/opt/apps/myapp.env',
			publicHost: 'myapp.apps.example.com',
			postgres: { password: 'pw', dataDir: '/opt/apps/myapp/pgdata' },
			kv: null,
		})
		const imgs = [...yaml.matchAll(DB_IMAGE_RE)].map((m) => m[1] ?? '')
		expect(imgs).toEqual([POSTGRES_IMAGE])
		const kv = renderComposeYaml({ name: 'myapp', dockerfilePath: './Dockerfile', hostPort: null, containerPort: 3000, envFilePath: '/e', publicHost: 'h', postgres: null, kv: { dataDir: '/k' } })
		expect([...kv.matchAll(DB_IMAGE_RE)].map((m) => m[1])).toEqual([REDIS_IMAGE])
	})

	it.each(['docker-compose.yml', 'docker-compose.dev.yml'])('%s db images are pinned', (f) => {
		const imgs = [...readFileSync(join(REPO, f), 'utf8').matchAll(DB_IMAGE_RE)].map((m) => m[1] ?? '')
		expect(imgs.length).toBeGreaterThan(0)
		for (const i of imgs) assertDigest(i)
	})

	it('docs describe the pgvector image docker-compose.yml actually runs', () => {
		const compose = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8')
		const m = compose.match(/image:\s*(pgvector\/pgvector:[\w.-]+)@sha256:/)
		expect(m, 'docker-compose.yml pgvector image must be tag@sha256').toBeTruthy()
		for (const f of ['docs/SELF-HOSTING.md', 'apps/web/content/docs/self-hosting.md'])
			expect(readFileSync(join(REPO, f), 'utf8')).toContain('`' + m?.[1] + '`')
	})

	it('guard rejects floating tags', () => {
		for (const bad of ['pgvector/pgvector:pg16', 'postgres:16', 'postgres:latest', 'postgres:16-alpine', 'postgres', 'postgres:16.10-alpine', 'postgres:16@sha256:' + 'a'.repeat(64), 'postgres:latest@sha256:' + 'a'.repeat(64)])
			expect(() => assertPinned(bad)).toThrow()
	})
})
