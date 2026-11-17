// The throwaway postgres cluster the .db tests start (initdb in a temp dir).
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

// initdb / pg_ctl are often off PATH (Debian keeps them in /usr/lib/postgresql/<v>/bin).
function pgBin(): string | null {
	if (spawnSync('initdb', ['--version']).status === 0) return ''
	const dirs = [spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' }).stdout?.trim() ?? '']
	try {
		for (const v of readdirSync('/usr/lib/postgresql').sort().reverse())
			dirs.push(`/usr/lib/postgresql/${v}/bin`)
	} catch {}
	for (const d of dirs) if (d && spawnSync(join(d, 'initdb'), ['--version']).status === 0) return d
	return null
}

/** The dir of initdb/pg_ctl ('' when on PATH), or null when postgres is not installed. */
export const PG_BIN = pgBin()
export const pg = (cmd: string) => (PG_BIN ? join(PG_BIN, cmd) : cmd)

// hermetic.ts strips LANG and LC_*. Linux initdb and postgres then fall back to the C
// locale; macOS initdb refuses ("invalid locale settings") and the postmaster exits
// ("postmaster became multithreaded during startup ... Set the LC_ALL environment
// variable to a valid locale"). So the cluster runs with LC_ALL=C and is created with
// --no-locale: the C locale (byte-order collation) the Linux clusters always got.

/** initdb arguments for a cluster in `data`. */
export const initdbArgs = (data: string) => [
	'-D',
	data,
	'-U',
	'postgres',
	'--auth=trust',
	'-E',
	'UTF8',
	'--no-locale',
]

/** The env for initdb / pg_ctl / psql: the test's env with LC_ALL=C. */
export const pgEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: 'C' })
