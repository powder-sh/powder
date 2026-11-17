import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shouldNotifyCronFailure } from '../cron-notify'
import { parseCrontab } from '../crons'
import {
	argvToDisplay,
	buildExecHostCommand,
	canStartRun,
	computeNextRun,
	mapHostCron,
	normalizeCronPath,
	parseJobInput,
	scheduleError,
	splitArgv,
	STALE_RUN_GRACE_MS,
} from '../managed-crons'
import { shq } from '../shell'

describe('schedule parsing and next run', () => {
	const at = new Date('2026-01-15T10:30:00Z')
	it('evaluates in UTC by default', () => {
		expect(computeNextRun('0 6 * * *', at)?.toISOString()).toBe('2026-01-16T06:00:00.000Z')
		expect(computeNextRun('*/15 * * * *', at)?.toISOString()).toBe('2026-01-15T10:45:00.000Z')
	})
	it('evaluates in the job timezone (winter: Berlin is UTC+1)', () => {
		expect(computeNextRun('0 6 * * *', at, 'Europe/Berlin')?.toISOString()).toBe(
			'2026-01-16T05:00:00.000Z',
		)
	})
	it('follows DST (summer: Berlin is UTC+2)', () => {
		const summer = new Date('2026-07-01T00:00:00Z')
		expect(computeNextRun('0 6 * * *', summer, 'Europe/Berlin')?.toISOString()).toBe(
			'2026-07-01T04:00:00.000Z',
		)
	})
	it('rejects non-5-field, garbage and unknown zones', () => {
		expect(computeNextRun('0 0 6 * * *', at)).toBeNull()
		expect(computeNextRun('@daily', at)).toBeNull()
		expect(computeNextRun('99 * * * *', at)).toBeNull()
		expect(computeNextRun('0 6 * * *', at, 'Mars/Olympus')).toBeNull()
		expect(scheduleError('0 6 * *', 'UTC')).toMatch(/5-field/)
		expect(scheduleError('0 6 * * *', 'Nope/Zone')).toMatch(/timezone/)
		expect(scheduleError('0 6 * * *', 'Europe/Berlin')).toBeNull()
	})
})

describe('overlap guard', () => {
	const now = new Date('2026-01-15T10:30:00Z')
	it('runs when nothing is running', () => {
		expect(canStartRun(null, now, 30)).toBe(true)
	})
	it('skips while the previous run is within timeout + grace', () => {
		expect(canStartRun(new Date(now.getTime() - 5_000), now, 30)).toBe(false)
		expect(canStartRun(new Date(now.getTime() - 30_000 - STALE_RUN_GRACE_MS + 1), now, 30)).toBe(
			false,
		)
	})
	it('treats a mark older than timeout + grace as a dead run', () => {
		expect(canStartRun(new Date(now.getTime() - 30_000 - STALE_RUN_GRACE_MS), now, 30)).toBe(true)
	})
})

describe('splitArgv', () => {
	it('splits words and honours quotes without expanding anything', () => {
		const r = splitArgv(`node "scripts/a b.js" --name='x y' plain\\ space`)
		expect(r).toEqual({
			ok: true,
			argv: ['node', 'scripts/a b.js', '--name=x y', 'plain space'],
			shellSyntax: false,
		})
	})
	it('flags unquoted shell operators and $ outside single quotes', () => {
		expect(splitArgv('a | b')).toMatchObject({ ok: true, shellSyntax: true })
		expect(splitArgv('a && b')).toMatchObject({ ok: true, shellSyntax: true })
		expect(splitArgv('echo $HOME')).toMatchObject({ ok: true, shellSyntax: true })
		expect(splitArgv('echo "$HOME"')).toMatchObject({ ok: true, shellSyntax: true })
		expect(splitArgv(`sh -c 'a && b | c $X'`)).toEqual({
			ok: true,
			argv: ['sh', '-c', 'a && b | c $X'],
			shellSyntax: false,
		})
	})
	it('reports unterminated quotes', () => {
		expect(splitArgv(`echo 'oops`)).toMatchObject({ ok: false })
		expect(splitArgv(`echo "oops`)).toMatchObject({ ok: false })
	})
})

describe('exec argv quoting', () => {
	// The host command must hand the exact argv to the program: no word
	// splitting, globbing, expansion or command substitution. Evaluate the
	// quoted part with a real POSIX shell and compare.
	const nasty = [
		'plain',
		'two words',
		"it's",
		'$HOME',
		'$(touch /tmp/powder-pwned)',
		'`id`',
		'a;b && c | d > e',
		'*',
		'"dq"',
		'back\\slash',
		'',
		'line\nbreak',
	]
	it('round-trips through sh exactly', () => {
		const quoted = nasty.map(shq).join(' ')
		const r = spawnSync('sh', ['-c', `printf '%s\\0' ${quoted}`], { encoding: 'utf8' })
		expect(r.status).toBe(0)
		expect(r.stdout.split('\0').slice(0, -1)).toEqual(nasty)
	})
	it('builds timeout + docker exec with every element quoted', () => {
		const cmd = buildExecHostCommand('blog', ['node', 'x.js', '$(id)'], 45)
		expect(cmd).toBe(`timeout --kill-after=5 45 docker exec blog 'node' 'x.js' '$(id)'`)
	})
	it('refuses an unsafe container name or an empty argv', () => {
		expect(() => buildExecHostCommand('blog;rm', ['x'], 30)).toThrow(/unsafe/)
		expect(() => buildExecHostCommand('blog', [], 30)).toThrow(/empty/)
	})
	it('clamps the timeout', () => {
		expect(buildExecHostCommand('blog', ['x'], 99999)).toContain(' 3600 docker exec')
		expect(buildExecHostCommand('blog', ['x'], 0)).toContain(' 1 docker exec')
	})
	it('display form re-splits to the same argv', () => {
		for (const argv of [
			['node', 'a b.js', "it's"],
			['sh', '-c', 'a && b $X'],
		]) {
			expect(splitArgv(argvToDisplay(argv))).toEqual({ ok: true, argv, shellSyntax: false })
		}
	})
})

describe('host crontab import mapping', () => {
	const map = (line: string, container = 'blog') => {
		const [c] = parseCrontab(line)
		if (!c) throw new Error('no cron line parsed')
		return mapHostCron(c.schedule, c.command, container, c.comment)
	}
	it('docker exec line becomes an exec job with argv, flags and redirections dropped', () => {
		const r = map(
			'*/5 * * * * docker exec -i -u node blog node scripts/digest.js --send >> /var/log/digest.log 2>&1',
		)
		expect(r.ok).toBe(true)
		if (!r.ok) return
		expect(r.draft).toMatchObject({
			schedule: '*/5 * * * *',
			timezone: 'UTC',
			kind: 'exec',
			execArgv: ['node', 'scripts/digest.js', '--send'],
		})
		expect(r.warnings.join(' ')).toMatch(/redirection dropped/)
		expect(r.warnings.join(' ')).toMatch(/-u node/)
	})
	it('keeps an explicit sh -c inside the container as argv', () => {
		const r = map(`0 3 * * * docker exec blog sh -c 'cd /app && npm run cleanup'`)
		expect(r.ok && r.draft.execArgv).toEqual(['sh', '-c', 'cd /app && npm run cleanup'])
	})
	it('curl POST with a bearer env var becomes an http job', () => {
		const r = map(
			'0 6 * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://blog.example.com/api/cron/digest?x=1 # daily digest',
		)
		expect(r.ok).toBe(true)
		if (!r.ok) return
		expect(r.draft).toMatchObject({
			kind: 'http',
			httpMethod: 'POST',
			urlPath: '/api/cron/digest?x=1',
			bearerEnvVar: 'CRON_SECRET',
			description: 'daily digest',
		})
		expect(r.draft.importedFrom).toContain('curl -fsS')
	})
	it('plain curl is GET; a literal token is not copied', () => {
		const r = map(
			'* * * * * curl -s -H "Authorization: Bearer abc123" http://127.0.0.1:3006/api/cron/tick',
		)
		expect(r.ok).toBe(true)
		if (!r.ok) return
		expect(r.draft).toMatchObject({
			httpMethod: 'GET',
			urlPath: '/api/cron/tick',
			bearerEnvVar: null,
		})
		expect(JSON.stringify(r.draft)).not.toContain('abc123"')
		expect(r.warnings.join(' ')).toMatch(/literal bearer token/)
	})
	it('refuses a line for another container, host-only commands and host shell chains', () => {
		expect(map('0 * * * * docker exec other node x.js')).toMatchObject({ ok: false })
		expect(map('0 * * * * /opt/apps/blog/backup.sh')).toMatchObject({ ok: false })
		expect(map('0 * * * * docker exec blog node x.js | logger')).toMatchObject({ ok: false })
	})
})

describe('job input validation', () => {
	it('accepts a valid http job and normalises the path', () => {
		const r = parseJobInput({
			schedule: '0 6 * * *',
			timezone: 'Europe/Berlin',
			kind: 'http',
			urlPath: 'api/cron/x',
			httpMethod: 'get',
		})
		expect(r).toMatchObject({
			ok: true,
			job: {
				urlPath: '/api/cron/x',
				httpMethod: 'GET',
				timezone: 'Europe/Berlin',
				enabled: true,
			},
		})
	})
	it('rejects absolute URLs (SSRF) and bad bearer names', () => {
		expect(
			parseJobInput({ schedule: '0 6 * * *', kind: 'http', urlPath: 'http://169.254.169.254/' }),
		).toMatchObject({ ok: false })
		expect(
			parseJobInput({ schedule: '0 6 * * *', kind: 'http', urlPath: '//evil.com/x' }),
		).toMatchObject({ ok: false })
		expect(
			parseJobInput({ schedule: '0 6 * * *', kind: 'http', urlPath: '/x', bearerEnvVar: 'A B' }),
		).toMatchObject({ ok: false })
		expect(normalizeCronPath('/ok?x=1')).toBe('/ok?x=1')
	})
	it('exec needs a string argv', () => {
		expect(parseJobInput({ schedule: '0 6 * * *', kind: 'exec', execArgv: [] })).toMatchObject({
			ok: false,
		})
		expect(
			parseJobInput({ schedule: '0 6 * * *', kind: 'exec', execArgv: ['node', 1] }),
		).toMatchObject({ ok: false })
		expect(
			parseJobInput({
				schedule: '0 6 * * *',
				kind: 'exec',
				execArgv: ['node', 'x.js'],
				timeoutSeconds: 5000,
			}),
		).toMatchObject({
			ok: true,
			job: { execArgv: ['node', 'x.js'], timeoutSeconds: 3600 },
		})
	})
})

describe('failure alerts', () => {
	it('alerts once per failure streak', () => {
		expect(shouldNotifyCronFailure(null, 'failed')).toBe(true)
		expect(shouldNotifyCronFailure('success', 'timeout')).toBe(true)
		expect(shouldNotifyCronFailure('failed', 'failed')).toBe(false)
		expect(shouldNotifyCronFailure('timeout', 'failed')).toBe(false)
		expect(shouldNotifyCronFailure('failed', 'success')).toBe(false)
	})
})
