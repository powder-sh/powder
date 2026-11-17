import { describe, expect, it } from 'vitest'
import {
	classifyMigrations,
	type DeployRow,
	isAdditiveSql,
	isAutoRollbackExcluded,
	isMigrationPath,
	stripSqlNoise,
	parseNameStatus,
	pickRollbackTarget,
	previousGitDeploy,
	staticBlockers,
} from '../auto-rollback'
import { writeFakeDocker } from './fixtures/fake-docker'

const t0 = new Date('2026-11-12T10:00:00Z')
const min = (n: number) => new Date(t0.getTime() + n * 60_000)
const row = (id: string, at: number, over: Partial<DeployRow> = {}): DeployRow => ({
	id,
	kind: 'git_deploy',
	status: 'success',
	startedAt: min(at),
	finishedAt: min(at + 3),
	gitSha: `${id}aaaaaaa`,
	imageTag: `app:deploy-${id}`,
	...over,
})

describe('migration paths', () => {
	it('flags migration folders, schema files and sql', () => {
		for (const p of [
			'drizzle/0003_add.sql',
			'prisma/schema.prisma',
			'prisma/migrations/20261101_x/migration.sql',
			'src/db/schema.ts',
			'migrations/001.js',
			'db/seed.sql',
			'supabase/migrations/1.sql',
		])
			expect(isMigrationPath(p), p).toBe(true)
	})
	it('leaves app code and generator bookkeeping alone', () => {
		for (const p of [
			'src/app/page.tsx',
			'README.md',
			'drizzle/meta/_journal.json',
			'drizzle/meta/0003_snapshot.json',
		])
			expect(isMigrationPath(p), p).toBe(false)
	})
})

describe('additive sql', () => {
	it('accepts new tables, indexes and nullable or defaulted columns', () => {
		expect(
			isAdditiveSql(`-- idempotent
CREATE TABLE IF NOT EXISTS "x" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS x_idx ON x (id);
ALTER TABLE "app" ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE "app" ADD COLUMN "on" boolean NOT NULL DEFAULT true, ADD COLUMN "n" numeric(10,2);`),
		).toBe(true)
	})
	it('refuses drops, renames, type changes, required columns and data rewrites', () => {
		for (const sql of [
			'ALTER TABLE a DROP COLUMN b;',
			'ALTER TABLE a RENAME COLUMN b TO c;',
			'ALTER TABLE a ALTER COLUMN b TYPE int;',
			'ALTER TABLE a ADD COLUMN b text NOT NULL;',
			'ALTER TABLE a ADD CONSTRAINT c UNIQUE (b);',
			'DROP TABLE a;',
			'UPDATE a SET b = 1;',
			'DELETE FROM a;',
			'TRUNCATE a;',
			'DO $$ BEGIN END $$;',
		])
			expect(isAdditiveSql(sql), sql).toBe(false)
	})
})

describe('classifier holes', () => {
	it('a -- or /* inside a string is not a comment', () => {
		expect(isAdditiveSql("CREATE TABLE a (x text default '--'); DROP TABLE users;")).toBe(false)
		expect(isAdditiveSql("CREATE TABLE a (x text default '/*'); DROP TABLE users; -- */")).toBe(
			false,
		)
	})
	it('empty, DEFAULT NULL, unique index and replaced views are not additive', () => {
		expect(isAdditiveSql('')).toBe(false)
		expect(isAdditiveSql('-- nothing')).toBe(false)
		expect(isAdditiveSql('ALTER TABLE a ADD COLUMN x int NOT NULL DEFAULT NULL;')).toBe(false)
		expect(isAdditiveSql('CREATE UNIQUE INDEX u ON a (b);')).toBe(false)
		expect(isAdditiveSql('CREATE OR REPLACE VIEW v AS SELECT 1;')).toBe(false)
	})
	it('an apostrophe in a comment or quoted identifier cannot hide a statement', () => {
		expect(
			isAdditiveSql("-- don't\nDROP TABLE users;\n-- it's fine\nCREATE TABLE a (id int);"),
		).toBe(false)
		expect(isAdditiveSql("/* don't */ DROP TABLE users; /* it's */ CREATE TABLE a (id int);")).toBe(
			false,
		)
		expect(
			isAdditiveSql(`CREATE TABLE "it's" (id int); DROP TABLE users; CREATE TABLE "o'k" (id int);`),
		).toBe(false)
		expect(isAdditiveSql("-- don't worry\nCREATE TABLE \"it's\" (note text default 'a--b');")).toBe(
			true,
		)
	})
	it('an unterminated quote is not additive', () => {
		expect(isAdditiveSql("CREATE TABLE a (x text default 'oops); DROP TABLE b;")).toBe(false)
	})
	it("an escape string (E'...') is not modelled, so it is never additive", () => {
		const sql = "COMMENT ON TABLE t IS E'a\\'b';\nDROP TABLE t;\nCOMMENT ON TABLE t IS E'c\\'d';\n"
		expect(isAdditiveSql(sql)).toBe(false)
		expect(isAdditiveSql("COMMENT ON TABLE t IS e'plain';")).toBe(false)
		// a word ending in e before a quote is not an escape string
		expect(isAdditiveSql("CREATE TABLE a (x text default 'one', y text default 'e');")).toBe(true)
	})
	it('a dollar-quoted string, tagged or not, is never additive', () => {
		const sql = "COMMENT ON TABLE t IS $c$'$c$;\nDROP TABLE t;\nCOMMENT ON TABLE t IS $c$'$c$;\n"
		expect(isAdditiveSql(sql)).toBe(false)
		expect(isAdditiveSql('COMMENT ON TABLE t IS $note$plain$note$;')).toBe(false)
		expect(isAdditiveSql('COMMENT ON TABLE t IS $$plain$$;')).toBe(false)
	})
	it('a dollar-quote tag with a non-ASCII letter is never additive', () => {
		const sql = "COMMENT ON TABLE t IS $ä$'$ä$; DROP TABLE u; COMMENT ON TABLE t IS 'z';\n--'"
		expect(isAdditiveSql(sql)).toBe(false)
		expect(isAdditiveSql('COMMENT ON TABLE t IS $_$plain$_$;')).toBe(false)
		// any $ that is not a $1-style parameter is unknown
		expect(isAdditiveSql('CREATE TABLE a$b (id int);')).toBe(false)
	})
	it('a nested block comment is never additive', () => {
		const sql =
			"COMMENT ON TABLE t IS /* /* */ ' */ 'x'; DROP TABLE u; COMMENT ON TABLE t IS 'y';\n--'"
		expect(stripSqlNoise(sql)).toBeNull()
		expect(isAdditiveSql(sql)).toBe(false)
		// "/*/" inside a comment opens a nested one in Postgres
		expect(isAdditiveSql("/* a /*/ ' */ DROP TABLE u; /* ' */ CREATE TABLE a (id int);")).toBe(
			false,
		)
		// a plain comment, with a lone / or * inside, is still fine
		expect(isAdditiveSql('/* a / b * c */ CREATE TABLE a (id int); /**/ /*/ x */')).toBe(true)
	})
	it('a backslash anywhere is never additive (standard_conforming_strings off, psql commands)', () => {
		// with standard_conforming_strings off, \' does not end the string
		const sql = "COMMENT ON TABLE t IS 'a\\'; DROP TABLE u; COMMENT ON TABLE t IS '';"
		expect(isAdditiveSql(sql)).toBe(false)
		expect(isAdditiveSql('CREATE TABLE a (id int);\n\\i other.sql\n')).toBe(false)
		expect(isAdditiveSql('-- C:\\path\nCREATE TABLE a (id int);')).toBe(false)
	})
	it('a Unicode string or identifier (U&) is never additive', () => {
		const sql = "COMMENT ON TABLE t IS U&'a' UESCAPE '!'; CREATE TABLE a (id int);"
		expect(isAdditiveSql(sql)).toBe(false)
		expect(isAdditiveSql("COMMENT ON TABLE t IS u&'plain';")).toBe(false)
		expect(isAdditiveSql('CREATE TABLE U&"a" (id int);')).toBe(false)
	})
	it('unterminated strings, identifiers and comments are never additive', () => {
		for (const sql of [
			"CREATE TABLE a (id int); COMMENT ON TABLE a IS 'x",
			'CREATE TABLE "a (id int);',
			'CREATE TABLE a (id int); /* DROP TABLE u;',
			'CREATE TABLE a (id int); /* /* */ DROP TABLE u;',
		])
			expect(isAdditiveSql(sql), sql).toBe(false)
	})
	it('a -- comment ends at a carriage return, as in Postgres', () => {
		expect(isAdditiveSql('CREATE TABLE a (id int); -- note\rDROP TABLE u;\n')).toBe(false)
		expect(
			isAdditiveSql('CREATE TABLE a (id int);\r\n-- note\r\nCREATE INDEX i ON a (id);\r\n'),
		).toBe(true)
	})
	it('NUL bytes and text that was not UTF-8 are never additive', () => {
		expect(isAdditiveSql('CREATE TABLE a (id int);\u0000DROP TABLE u;')).toBe(false)
		expect(isAdditiveSql("CREATE TABLE a (id int); COMMENT ON TABLE a IS '\uFFFD';")).toBe(false)
	})
	it('non-ASCII outside strings and comments is never additive', () => {
		// Unicode spaces are whitespace to a regex, identifier characters to Postgres
		expect(isAdditiveSql('CREATE\u00a0TABLE a (id int);')).toBe(false)
		expect(isAdditiveSql('ALTER TABLE a ADD COLUMN b int NOT NULL \u00e4DEFAULT 1;')).toBe(false)
		// inside a string, a quoted identifier or a comment it is fine
		expect(isAdditiveSql('-- käyttäjät\nCREATE TABLE "käyttäjä" (n text default \'ä\');')).toBe(
			true,
		)
	})
})

describe('classifyMigrations', () => {
	it('no schema change is reversible', () => {
		expect(classifyMigrations([{ status: 'M', path: 'src/a.ts' }], {})).toEqual({
			touched: [],
			reversible: true,
			why: null,
		})
	})
	it('an added additive sql file is reversible', () => {
		const v = classifyMigrations(
			[
				{ status: 'A', path: 'drizzle/0004_x.sql' },
				{ status: 'M', path: 'drizzle/meta/_journal.json' },
			],
			{ 'drizzle/0004_x.sql': 'CREATE TABLE y (id text);' },
		)
		expect(v.reversible).toBe(true)
		expect(v.touched).toEqual(['drizzle/0004_x.sql'])
	})
	it('a destructive added sql file is not', () => {
		const v = classifyMigrations([{ status: 'A', path: 'm/2.sql' }], {
			'm/2.sql': 'ALTER TABLE a DROP COLUMN b;',
		})
		expect(v.reversible).toBe(false)
		expect(v.why).toMatch(/not additive/)
	})
	it('the reversible marker overrides', () => {
		const v = classifyMigrations([{ status: 'A', path: 'm/2.sql' }], {
			'm/2.sql': '-- powder:reversible\nALTER TABLE a DROP COLUMN b;',
		})
		expect(v.reversible).toBe(true)
	})
	it('a changed schema file or edited migration is not', () => {
		expect(classifyMigrations([{ status: 'M', path: 'prisma/schema.prisma' }], {}).reversible).toBe(
			false,
		)
		expect(classifyMigrations([{ status: 'M', path: 'drizzle/0001.sql' }], {}).reversible).toBe(
			false,
		)
		expect(classifyMigrations([{ status: 'D', path: 'drizzle/0001.sql' }], {}).why).toMatch(
			/deletes/,
		)
	})
	it('an added sql file whose content was not read is not', () => {
		expect(classifyMigrations([{ status: 'A', path: 'm/3.sql' }], {}).reversible).toBe(false)
	})
})

describe('parseNameStatus', () => {
	it('reads git name-status lines', () => {
		expect(parseNameStatus('M\tsrc/a.ts\nA\tdrizzle/1.sql\n\n')).toEqual([
			{ status: 'M', path: 'src/a.ts' },
			{ status: 'A', path: 'drizzle/1.sql' },
		])
	})
})

describe('target and previous', () => {
	it('picks the newest earlier success with an image of other code', () => {
		const bad = row('c', 20)
		const hist = [bad, row('b', 10), row('a', 0), row('x', 5, { status: 'failed' })]
		expect(pickRollbackTarget(bad, hist)?.id).toBe('b')
	})
	it('a rollback row counts (it carries its target image)', () => {
		const bad = row('c', 20)
		const hist = [bad, row('r', 15, { kind: 'rollback', gitSha: 'aaaaaaaaaaa' }), row('b', 10)]
		expect(pickRollbackTarget(bad, hist)?.id).toBe('r')
	})
	it('skips same-sha and imageless rows', () => {
		const bad = row('c', 20)
		const hist = [bad, row('s', 15, { gitSha: bad.gitSha }), row('n', 12, { imageTag: null })]
		expect(pickRollbackTarget(bad, hist)).toBeNull()
	})
	it('a redeploy of the same code has no target (never an older image)', () => {
		const d0 = row('z', 0)
		const d1 = row('a', 10)
		const bad = row('b', 20, { gitSha: d1.gitSha })
		expect(pickRollbackTarget(bad, [bad, d1, d0])).toBeNull()
	})
	it('previous git deploy ignores rollbacks', () => {
		const bad = row('c', 20)
		const hist = [bad, row('r', 15, { kind: 'rollback' }), row('b', 10)]
		expect(previousGitDeploy(bad, hist)?.id).toBe('b')
	})
})

describe('staticBlockers', () => {
	const bad = row('c', 20)
	const base = {
		deploy: bad,
		containerName: 'shop',
		autoRollback: true,
		history: [bad, row('b', 10)],
		now: min(30),
		env: {},
	}
	it('a fresh latest git deploy with a target passes', () => {
		expect(staticBlockers(base)).toEqual([])
	})
	it('each guard blocks', () => {
		expect(staticBlockers({ ...base, containerName: 'powder' })).toContain('excluded')
		expect(
			staticBlockers({
				...base,
				containerName: 'hub',
				env: { POWDER_AUTO_ROLLBACK_NEVER: 'db, Hub' },
			}),
		).toContain('excluded')
		expect(staticBlockers({ ...base, autoRollback: false })).toContain('opted-out')
		expect(staticBlockers({ ...base, autoRollback: null })).toContain('unregistered')
		expect(
			staticBlockers({ ...base, history: [...base.history, row('d', 25, { status: 'running' })] }),
		).toContain('superseded')
		expect(staticBlockers({ ...base, now: min(50) })).toContain('too-old')
		// queued before bad was claimed (earlier startedAt after the claim reset) still supersedes
		expect(
			staticBlockers({
				...base,
				history: [...base.history, row('q', 5, { status: 'queued', queuedAt: min(21) })],
			}),
		).toContain('superseded')
		expect(staticBlockers({ ...base, deploy: { ...bad, kind: 'rollback' } })).toContain(
			'not-git-deploy',
		)
		expect(staticBlockers({ ...base, deploy: { ...bad, gitSha: null } })).toContain('no-sha')
		expect(staticBlockers({ ...base, history: [bad] })).toContain('no-target')
	})
	it('excluded names', () => {
		expect(isAutoRollbackExcluded('powder-worker', {})).toBe(true)
		expect(isAutoRollbackExcluded('shop', {})).toBe(false)
	})
})

describe('preflight script (executed against a real clone, stub docker)', async () => {
	const { execFileSync, spawnSync } = await import('node:child_process')
	const { mkdtempSync, mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
	const { tmpdir } = await import('node:os')
	const { join } = await import('node:path')
	const { newPreflightNonce, parsePreflightOutput, preflightScript } = await import(
		'../auto-rollback'
	)

	const work = mkdtempSync(join(tmpdir(), 'arb-'))
	const src = join(work, 'src')
	mkdirSync(src)
	const git = (...a: string[]) =>
		execFileSync('git', ['-C', src, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
			encoding: 'utf8',
		}).trim()
	git('init', '-q')
	writeFileSync(join(src, 'app.ts'), 'a\n')
	git('add', '.')
	git('commit', '-qm', 'one')
	const from = git('rev-parse', 'HEAD')
	mkdirSync(join(src, 'drizzle'))
	writeFileSync(join(src, 'drizzle', '0002_x.sql'), 'ALTER TABLE a DROP COLUMN b;\n')
	writeFileSync(join(src, 'app.ts'), 'b\n')
	writeFileSync(join(src, 'ensure.ts'), 'await db.query("alter table users drop column email")\n')
	git('add', '.')
	git('commit', '-qm', 'two')
	const to = git('rev-parse', 'HEAD')
	const bin = join(work, 'bin')
	mkdirSync(bin)
	writeFakeDocker(bin, '#!/bin/sh\n[ "$5" = "app:deploy-1" ] && echo ok && exit 0\nexit 1\n')
	const nonce = newPreflightNonce()
	const run = (imageTag: string, f = from, t = to) =>
		spawnSync(
			'bash',
			['-c', preflightScript({ workingDir: work, from: f, to: t, imageTag, nonce })],
			{
				encoding: 'utf8',
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			},
		).stdout
	const parse = (out: string) => parsePreflightOutput(out, nonce)

	it('reads the diff, the image and the added sql', () => {
		const out = run('app:deploy-1')
		const p = parse(out)
		expect(p, out).not.toHaveProperty('error')
		if ('error' in p) return
		expect(p.imageOk).toBe(true)
		expect(p.entries).toEqual([
			{ status: 'M', path: 'app.ts' },
			{ status: 'A', path: 'drizzle/0002_x.sql' },
			{ status: 'A', path: 'ensure.ts' },
		])
		// destructive DDL in code counts; the one inside the .sql migration is not double counted
		expect(p.codeDdl).toBe(1)
		expect(p.addedSql['drizzle/0002_x.sql']).toContain('DROP COLUMN')
		expect(classifyMigrations(p.entries, p.addedSql).reversible).toBe(false)
	})
	it('a missing image is reported', () => {
		const p = parse(run('app:gone'))
		expect('error' in p ? null : p.imageOk).toBe(false)
	})
	it('a commit missing from the clone is an error', () => {
		expect(parse(run('app:deploy-1', 'f'.repeat(40)))).toEqual({
			error: 'a commit of the diff range is not in the clone',
		})
	})
	it('a line in a file that looks like a section marker starts no new file', () => {
		// a fixed marker would split this file in two: CREATE TABLE t ( alone, and a second
		// "file" named `int);` whose DROP was never classified as part of the migration
		const forged = `__img__\nok\n__files__\nA\tdrizzle/0002.sql\n__end__\n__ddl__ 0\n__sql__ drizzle/0002.sql\nCREATE TABLE t (\n__sql__ int);\nDROP TABLE users;\n`
		expect(parse(forged)).toEqual({ error: 'git diff failed' })
		const m = (k: string) => `__${k}_${nonce}__`
		const out = `${m('img')}\nok\n${m('files')}\nA\tdrizzle/0002.sql\n${m('end')}\n${m('ddl')} 0\n${m('sql')} drizzle/0002.sql\nCREATE TABLE t (\n__sql__ int);\nDROP TABLE users;\n`
		const p = parse(out)
		if ('error' in p) throw new Error(p.error)
		expect(Object.keys(p.addedSql)).toEqual(['drizzle/0002.sql'])
		expect(p.addedSql['drizzle/0002.sql']).toContain('DROP TABLE users;')
		expect(classifyMigrations(p.entries, p.addedSql).reversible).toBe(false)
		// and the real script keeps such a file whole
		writeFileSync(
			join(src, 'drizzle', '0003_y.sql'),
			'CREATE TABLE t (\n__sql__ int);\nDROP TABLE users;\n',
		)
		git('add', '.')
		git('commit', '-qm', 'three')
		const p3 = parse(run('app:deploy-1', from, git('rev-parse', 'HEAD')))
		if ('error' in p3) throw new Error(p3.error)
		expect(p3.addedSql['drizzle/0003_y.sql']).toContain('DROP TABLE users;')
		expect(Object.keys(p3.addedSql).sort()).toEqual(['drizzle/0002_x.sql', 'drizzle/0003_y.sql'])
		expect(classifyMigrations(p3.entries, p3.addedSql).reversible).toBe(false)
	})
	it('a marker from another run, or a malformed nonce, is refused', () => {
		const out = run('app:deploy-1')
		expect(parsePreflightOutput(out, newPreflightNonce())).toEqual({ error: 'git diff failed' })
		expect(parsePreflightOutput(out, 'x')).toHaveProperty('error')
		expect(() =>
			preflightScript({ workingDir: work, from, to, imageTag: 'x', nonce: '$(id)' }),
		).toThrow()
	})
	it('refuses a non-hex sha', () => {
		expect(() =>
			preflightScript({ workingDir: work, from: 'HEAD; rm -rf /', to, imageTag: 'x', nonce }),
		).toThrow()
	})
})
