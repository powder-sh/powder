// powder and the worker load powder.env through compose `env_file`, so a
// changed value reaches them only when the containers are recreated
// (lib/recreate-hint.ts); a plain restart keeps the old env. A docs page or a
// UI/API string that tells the operator to set an env var and "restart" sends
// them down the path that silently changes nothing. This guard flags a sentence
// that names an env var (or powder.env) and asks for a restart. Sentences that
// say a restart does NOT re-read the file pass.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = resolve(__dirname, '../../../../..')
const WEB = join(REPO, 'apps/web')

const ENV_REF = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|powder\.env/
const RESTART_ASK = /\b(?:and|then)\s+restart\b|,\s+restart\s+(?:powder|the worker|both|the containers?)\b/i
const NEGATED = /restart\)?\s+(?:does|do|will)\s+not|plain restart|not a restart/i

/** Sentences of `text` that pair an env var instruction with a restart. */
function restartAfterEnv(text: string): string[] {
	return text
		.split(/(?<=[.;!?])\s+|\n\s*\n/)
		.map((s) => s.replace(/\s+/g, ' ').trim())
		.filter((s) => ENV_REF.test(s) && RESTART_ASK.test(s) && !NEGATED.test(s))
}

function walk(dir: string, keep: (f: string) => boolean, out: string[] = []): string[] {
	for (const n of readdirSync(dir)) {
		if (n === 'node_modules' || n === '__tests__' || n.startsWith('.')) continue
		const p = join(dir, n)
		if (statSync(p).isDirectory()) walk(p, keep, out)
		else if (keep(p)) out.push(p)
	}
	return out
}

describe('env change instructions say recreate, not restart', () => {
	it('the matcher flags the restart wording and passes the recreate wording', () => {
		expect(restartAfterEnv('Set `POWDER_SWAP_CHECK=off` in `powder.env` and restart powder and the worker.')).toHaveLength(1)
		expect(restartAfterEnv("take the id out of POWDER_ADMIN_USER_IDS and restart powder first")).toHaveLength(1)
		expect(restartAfterEnv('Set GITHUB_CLIENT_ID in powder.env, then restart.')).toHaveLength(1)
		expect(
			restartAfterEnv('set GITHUB_CLIENT_ID in powder.env, then recreate the containers (a restart does not re-read the file)'),
		).toEqual([])
		expect(restartAfterEnv('If the first login errors, restart powder, take the new token from the log.')).toEqual([])
		expect(restartAfterEnv('Rollback, restart, logs and redeploy answer 404, keyed on `POWDER_SELF_CONTAINER`.')).toEqual([])
	})

	it('no docs page or UI/API string asks for a restart after an env change', () => {
		const files = [
			...readdirSync(REPO)
				.filter((f) => f.endsWith('.md') && f !== 'CHANGELOG.md')
				.map((f) => join(REPO, f)),
			...walk(join(REPO, 'docs'), (f) => f.endsWith('.md')),
			...walk(join(WEB, 'content/docs'), (f) => f.endsWith('.md')),
			...walk(join(WEB, 'src'), (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)),
		]
		const hits = files.flatMap((f) => restartAfterEnv(readFileSync(f, 'utf8')).map((s) => `${relative(REPO, f)}: ${s}`))
		expect(hits).toEqual([])
	})
})
