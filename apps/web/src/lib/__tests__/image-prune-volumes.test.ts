import { spawnSync } from 'node:child_process'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { pathWithout } from './hermetic'

// infra/powder-image-prune.sh reclaims dangling ANONYMOUS volumes only once they are older
// than ANON_VOLUME_MAX_AGE_DAYS (default 7), and never a named one. A container removed
// without -v (`docker rm`, `compose down`, an app deleted in the dashboard) leaves its
// anonymous volume behind; the grace keeps that data around for a while.
// The whole script runs here against a docker stub that emulates the volume commands.

const HOURLY = join(__dirname, '../../../../../infra/powder-image-prune.sh')
const SYS_PATH = pathWithout([])
const REAL_DATE = SYS_PATH.split(':')
	.map((d) => join(d, 'date'))
	.find((p) => existsSync(p)) as string
const root = mkdtempSync(join(tmpdir(), 'prune-vol-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ANON = 'com.docker.volume.anonymous'
// CreatedAt values the `date` stub understands (GNU `date -d` is not on every test host).
const OLD = '2020-01-01T00:00:00Z'
const DAYS_AGO_3 = 'three-days-ago'
const NOW = 'just-now'
// name|labels|CreatedAt: anonymous data dirs of different ages, two dangling named volumes
const VOLUMES = [
	`3f1c0a9e7b|${ANON}=|${OLD}`,
	`9b2d44e0c1|${ANON}=|${OLD}`,
	`5e6f7a8b9c|${ANON}=|${DAYS_AGO_3}`,
	`7c8d9e0f1a|${ANON}=|${NOW}`,
	`4a5b6c7d8e|${ANON}=|not a date`,
	`blog_blog-pgdata|com.docker.compose.volume=blog-pgdata|${OLD}`,
	`acme-shop-dev_shop-pgdata|com.docker.compose.volume=shop-pgdata|${OLD}`,
]
const names = (vs: string[]) => vs.map((v) => v.split('|')[0])
const YOUNG_AND_NAMED = ['5e6f7a8b9c', '7c8d9e0f1a', '4a5b6c7d8e', 'blog_blog-pgdata', 'acme-shop-dev_shop-pgdata']

function stub(dir: string, name: string, body: string) {
	writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`)
	chmodSync(join(dir, name), 0o755)
}

/** Runs the hourly script with stubbed docker/ps/flock/sleep/date; returns output, calls and the volumes left. */
function run(psOut = '', volumes = VOLUMES, env: Record<string, string> = {}, images: string[] = []) {
	const dir = mkdtempSync(join(root, 'case-'))
	const bin = join(dir, 'bin')
	mkdirSync(bin)
	const log = join(dir, 'calls.log')
	const vols = join(dir, 'volumes')
	writeFileSync(log, '')
	writeFileSync(vols, `${volumes.join('\n')}\n`)
	const imgs = join(dir, 'images')
	writeFileSync(imgs, images.length ? `${images.join('\n')}\n` : '')
	// Every fixture volume is dangling. `volume ls` honours a label filter, `volume rm`
	// removes one volume by name.
	stub(
		bin,
		'docker',
		`echo "docker $*" >> ${JSON.stringify(log)}
case "$1 $2" in
  "volume ls")
    want=''
    for a in "$@"; do case "$a" in label=*) want="\${a#label=}" ;; esac; done
    while IFS='|' read -r n l c; do
      [ -z "$n" ] && continue
      if [ -z "$want" ] || [[ ",$l," == *",$want="* ]]; then echo "$n"; fi
    done < ${JSON.stringify(vols)} ;;
  "volume inspect")
    v="\${@: -1}"
    while IFS='|' read -r n l c; do [ "$n" = "$v" ] && { echo "$c"; exit 0; }; done < ${JSON.stringify(vols)}
    exit 1 ;;
  "volume rm")
    v="\${@: -1}" keep=''
    while IFS='|' read -r n l c; do [ -z "$n" ] || [ "$n" = "$v" ] || keep="$keep$n|$l|$c"$'\\n'; done < ${JSON.stringify(vols)}
    printf '%s' "$keep" > ${JSON.stringify(vols)} ;;
  "system df") echo "Build Cache 43MB" ;;
  "images --format") cat ${JSON.stringify(imgs)} ;;
esac
exit 0`,
	)
	stub(
		bin,
		'date',
		`if [ "$1" = -d ]; then
  case "$2" in
    ${OLD}) echo 1577836800 ;;
    ${DAYS_AGO_3}) echo $(( $(${REAL_DATE} +%s) - 3*86400 )) ;;
    ${NOW}) ${REAL_DATE} +%s ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exec ${REAL_DATE} "$@"`,
	)
	stub(bin, 'ps', `printf '%s' ${JSON.stringify(psOut)}`)
	stub(bin, 'flock', 'exit 0')
	stub(bin, 'sleep', 'exit 0')
	const r = spawnSync('bash', [HOURLY], {
		env: { ...process.env, ...env, PATH: `${bin}:${SYS_PATH}` },
		encoding: 'utf8',
	})
	const left = existsSync(vols) ? readFileSync(vols, 'utf8') : ''
	return { out: r.stdout, rc: r.status, calls: readFileSync(log, 'utf8'), left: names(left.split('\n').filter(Boolean)) }
}

describe('powder-image-prune: dangling anonymous volumes', () => {
	it('idle server: removes anonymous volumes older than 7 days, keeps younger ones, undated ones and every named one', () => {
		const { out, rc, calls, left } = run()
		expect(rc).toBe(0)
		expect(calls).toMatch(/^docker volume ls -q --filter dangling=true --filter label=com\.docker\.volume\.anonymous$/m)
		expect(calls).toContain('docker volume rm 3f1c0a9e7b')
		expect(calls).toContain('docker volume rm 9b2d44e0c1')
		expect(calls).not.toMatch(/docker volume rm (5e6f7a8b9c|7c8d9e0f1a|4a5b6c7d8e|blog|acme)/)
		expect(left).toEqual(YOUNG_AND_NAMED)
		expect(out).toContain('removed 2 dangling anonymous volumes older than 7 days (kept 3 younger)')
	})

	it('ANON_VOLUME_MAX_AGE_DAYS shortens or lengthens the grace', () => {
		const short = run('', VOLUMES, { ANON_VOLUME_MAX_AGE_DAYS: '2' })
		expect(short.left).toEqual(['7c8d9e0f1a', '4a5b6c7d8e', 'blog_blog-pgdata', 'acme-shop-dev_shop-pgdata'])
		expect(short.out).toContain('removed 3 dangling anonymous volumes older than 2 days')
		const long = run('', VOLUMES, { ANON_VOLUME_MAX_AGE_DAYS: '100000' })
		expect(long.left).toEqual(names(VOLUMES))
		expect(long.out).toContain('removed 0 dangling anonymous volumes older than 100000 days')
	})

	it('a value that is not a whole number of days falls back to 7', () => {
		const { out, left } = run('', VOLUMES, { ANON_VOLUME_MAX_AGE_DAYS: '0; rm -rf /' })
		expect(out).toContain('is not a whole number of days of up to 6 digits, using 7')
		expect(left).toEqual(YOUNG_AND_NAMED)
	})

	it('a leading zero is read as base 10, not octal (08 and 010)', () => {
		const eight = run('', VOLUMES, { ANON_VOLUME_MAX_AGE_DAYS: '08' })
		expect(eight.rc).toBe(0)
		expect(eight.out).not.toContain('value too great for base')
		expect(eight.out).toContain('removed 2 dangling anonymous volumes older than 8 days (kept 3 younger)')
		expect(eight.left).toEqual(YOUNG_AND_NAMED)
		const ten = run('', VOLUMES, { ANON_VOLUME_MAX_AGE_DAYS: '010' })
		expect(ten.out).toContain('older than 10 days')
	})

	it('KEEP_DEPLOY_TAGS: base 10 with a leading zero, the default when it is not a whole number', () => {
		expect(run('', [], { KEEP_DEPLOY_TAGS: '08' }).out).toContain('newest 8 images per app')
		expect(run('', [], { KEEP_DEPLOY_TAGS: '010' }).out).toContain('newest 10 images per app')
		const bad = run('', [], { KEEP_DEPLOY_TAGS: 'all' })
		expect(bad.out).toContain("KEEP_DEPLOY_TAGS='all' is not a whole number of up to 6 digits, using 3")
		expect(bad.out).toContain('newest 3 images per app')
	})

	it('ANON_VOLUME_MAX_AGE_DAYS longer than 6 digits falls back to 7 (no overflowed cutoff)', () => {
		const { out, left } = run('', VOLUMES, { ANON_VOLUME_MAX_AGE_DAYS: '9223372036854775808' })
		expect(out).toContain("ANON_VOLUME_MAX_AGE_DAYS='9223372036854775808' is not a whole number of days of up to 6 digits, using 7")
		expect(left).toEqual(YOUNG_AND_NAMED)
		expect(run('', VOLUMES, { ANON_VOLUME_MAX_AGE_DAYS: '1000000' }).out).toContain('using 7')
		expect(run('', VOLUMES, { ANON_VOLUME_MAX_AGE_DAYS: '999999' }).out).toContain('older than 999999 days')
	})

	it('KEEP_DEPLOY_TAGS longer than 6 digits falls back to 3 (a wrapped value would be negative)', () => {
		const r = run('', [], { KEEP_DEPLOY_TAGS: '9223372036854775808' })
		expect(r.out).toContain("KEEP_DEPLOY_TAGS='9223372036854775808' is not a whole number of up to 6 digits, using 3")
		expect(r.out).toContain('newest 3 images per app')
		expect(run('', [], { KEEP_DEPLOY_TAGS: '999999' }).out).toContain('newest 999999 images per app')
	})

	// the tag loop needs associative arrays (bash 4+); macOS ships bash 3.2
	const BASH4 = Number(spawnSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' }).stdout.trim()) >= 4
	it.skipIf(!BASH4)('a KEEP_DEPLOY_TAGS longer than 6 digits keeps the newest 3 rollback tags', () => {
		const deploys = [5, 4, 3, 2, 1].map((n) => `blog:deploy-${n}|2020-01-0${n} 00:00:00 +0000 UTC|sha256:${String(n).repeat(12)}`)
		const r = run('', [], { KEEP_DEPLOY_TAGS: '9223372036854775808' }, deploys)
		expect(r.out).toContain('protected 3 rollback tags (newest 3 images per app)')
		expect(r.calls).toContain('docker rmi blog:deploy-2')
		expect(r.calls).toContain('docker rmi blog:deploy-1')
		expect(r.calls).not.toMatch(/docker rmi blog:deploy-[345]/)
	})

	it('only named dangling volumes: removes nothing, logs zero', () => {
		const named = VOLUMES.filter((v) => !v.includes(ANON))
		const { out, left, calls } = run('', named)
		expect(left).toEqual(names(named))
		expect(calls).not.toContain('docker volume rm')
		expect(out).toContain('removed 0 dangling anonymous volumes older than 7 days (kept 0 younger)')
	})

	it('a container start in progress: skips the volume step, removes nothing', () => {
		const { out, rc, calls, left } = run('  30 docker run -d --rm --name gate postgres:17\n')
		expect(rc).toBe(0)
		expect(calls).not.toContain('docker volume')
		expect(left).toEqual(names(VOLUMES))
		expect(out).toContain('anonymous-volume prune skipped')
		expect(out).toContain('removed 0 dangling anonymous volumes')
	})

	it('the script lists only dangling anonymous volumes, never prunes or force-removes volumes', () => {
		const sh = readFileSync(HOURLY, 'utf8')
		const code = sh
			.split('\n')
			.filter((l) => !l.trimStart().startsWith('#'))
			.join('\n')
		const volumeCalls = code.match(/docker volume [^\n]*/g) ?? []
		expect(volumeCalls).toEqual([
			`docker volume inspect -f '{{.CreatedAt}}' "$vol" 2>/dev/null) || continue`,
			'docker volume rm "$vol" >/dev/null 2>&1 && vol_removed=$((vol_removed+1)) || true',
			'docker volume ls -q --filter dangling=true --filter label=com.docker.volume.anonymous 2>/dev/null)',
		])
		expect(code).not.toMatch(/docker volume prune/)
		expect(code).not.toMatch(/docker volume rm[^\n]*\s-f\b/)
		expect(code).not.toMatch(/docker system prune/)
		expect(code).not.toMatch(/--volumes\b/)
	})
})

describe('powder-image-prune: unused non-deploy tags', () => {
	it('an image whose date cannot be read is kept; an old one is removed', () => {
		// ref|CreatedAt|ID as `docker images --format` prints it; the date stub fails on "not a date"
		const { rc, calls } = run('', [], {}, [
			`shop/web:latest|${OLD} UTC|aaa111`,
			'blog/web:latest|not a date UTC|bbb222',
		])
		expect(rc).toBe(0)
		expect(calls).toContain('docker rmi shop/web:latest')
		expect(calls).not.toContain('docker rmi blog/web:latest')
	})
})

describe('powder-image-prune: build cache', () => {
	it('idle server: prunes the build cache down to the cap', () => {
		const { rc, calls } = run()
		expect(rc).toBe(0)
		expect(calls).toMatch(/^docker builder prune -af --max-used-space /m)
	})

	it('a build in progress: no build cache prune, said in the log', () => {
		const { rc, calls, out } = run('  30 docker buildx build -t shop:next .\n')
		expect(rc).toBe(0)
		expect(calls).not.toContain('docker builder prune')
		expect(calls).not.toContain('docker image prune')
		expect(out).toContain('a build is in progress, build cache prune skipped')
	})
})
