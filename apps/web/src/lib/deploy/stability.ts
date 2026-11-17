// Deploy-setup checks: read-only facts the deploy script reports back as
// nonce-tagged marker lines (like the sha and bridge markers), so build or test
// output cannot print them. The runner turns them into warning cards (hq.ts
// stabilityCardPlan, behind POWDER_STABILITY_CARDS). Warnings only: a check never
// fails, waits on or changes a deploy, and a check that cannot finish prints no
// marker (unknown: no card is raised or resolved).
//
// Marker lines, one per check, `<marker> <kind> <value>`:
//   compose-drift drift|ok
//   migrate-path  ok | <case>[,<case>...]   (MIGRATE_PATH_CASES)
//   test-gate     present|absent           (.powder/test.sh in the build context)

import { shq } from '../shell'
import { RELEASE_SCHEMA_PUSH_ERE, SCHEMA_TOOL_ERE } from './fragments'

/** Marker prefix of this run, '' without a nonce (then no marker is printed). */
export function stabilityMarkerFor(nonce: string): string {
	const n = nonce.replace(/[^A-Za-z0-9]/g, '')
	return n ? `__POWDER_STAB_${n}__` : ''
}

/** Shell statement printing one marker line (`echo '...'; `), '' without a nonce.
 *  `kind` and `value` are fixed words chosen by powder, never data. */
export function stabilityMarkShell(nonce: string, kind: string, value: string): string {
	const m = stabilityMarkerFor(nonce)
	if (!m || !/^[a-z-]+$/.test(kind) || !/^[a-z,-]+$/.test(value)) return ''
	return `echo '${m} ${kind} ${value}'; `
}

/** Ways an app's schema changes bypass powder-migrate (migrate-path marker):
 *  - stray-sql: migration-looking *.sql files, none in a folder powder-migrate reads
 *  - boot-cmd: the image Cmd/Entrypoint runs a schema tool (SCHEMA_TOOL_ERE)
 *  - release-cmd: the image label powder.release.cmd runs a schema push
 *    (RELEASE_SCHEMA_PUSH_ERE). A ledgered migrator there (knex migrate, prisma
 *    migrate deploy, a migrate script) is the supported path: no case.
 *  - start-script: package.json `start` runs one */
export const MIGRATE_PATH_CASES = ['stray-sql', 'boot-cmd', 'release-cmd', 'start-script'] as const
export type MigratePathCase = (typeof MIGRATE_PATH_CASES)[number]

export type StabilityMarkers = {
	/** the repo's docker-compose.yml differs from the runtime compose */
	composeDrift: 'drift' | 'ok' | null
	/** [] = none found, every part of the scan finished */
	migratePath: MigratePathCase[] | null
	/** the build context has .powder/test.sh (the opt-in test gate) */
	testGate: 'present' | 'absent' | null
}

export const NO_STABILITY_MARKERS: StabilityMarkers = Object.freeze({ composeDrift: null, migratePath: null, testGate: null })

/** The last valid marker line per kind. Never throws: anything malformed is
 *  ignored, and an unexpected error gives "unknown" for every kind. */
export function parseStabilityMarkers(out: string, nonce: string): StabilityMarkers {
	const v: StabilityMarkers = { ...NO_STABILITY_MARKERS }
	try {
		const marker = stabilityMarkerFor(nonce)
		if (!marker || typeof out !== 'string') return v
		for (const l of out.split('\n')) {
			if (!l.startsWith(`${marker} `)) continue
			const parts = l.slice(marker.length + 1).trim().split(/\s+/)
			if (parts.length !== 2) continue
			const [kind, value] = parts as [string, string]
			if (kind === 'compose-drift' && (value === 'drift' || value === 'ok')) v.composeDrift = value
			else if (kind === 'test-gate' && (value === 'present' || value === 'absent')) v.testGate = value
			else if (kind === 'migrate-path') {
				if (value === 'ok') v.migratePath = []
				else {
					const cases = value.split(',')
					if (cases.length > 0 && cases.every((c) => (MIGRATE_PATH_CASES as readonly string[]).includes(c)))
						v.migratePath = [...new Set(cases as MigratePathCase[])]
				}
			}
		}
		return v
	} catch {
		return { ...NO_STABILITY_MARKERS }
	}
}

/** `out` without this run's marker lines: they are read by parseStabilityMarkers
 *  and carry nothing for the stored deploy log. Other lines are kept as they are. */
export function stripStabilityMarkers(out: string, nonce: string): string {
	const marker = stabilityMarkerFor(nonce)
	if (!marker) return out
	return out
		.split('\n')
		.filter((l) => !l.startsWith(`${marker} `))
		.join('\n')
}

/** The live counterpart of stripStabilityMarkers: wraps a chunk sink (the live log,
 *  which is also what a failed deploy stores) so this run's marker lines never reach
 *  it, whatever the chunk boundaries. Text goes through as soon as it cannot start a
 *  marker line; only a line start that could still become one is held until its
 *  newline or flush(). Each stream (stdout, stderr, powder's own lines) keeps its own
 *  line state, as their chunks interleave: a stderr line without its newline yet
 *  does not make the next stdout marker look like the middle of a line. flush()
 *  ends the run: the next push starts at a line start on every stream. No nonce:
 *  everything passes through unchanged. */
export function stabilityMarkerFilter(
	nonce: string,
	sink: ((chunk: string) => void) | undefined,
): { push: (chunk: string, stream?: string) => void; flush: () => void } {
	const marker = stabilityMarkerFor(nonce)
	if (!marker || !sink) return { push: (c) => sink?.(c), flush: () => {} }
	const prefix = `${marker} `
	const streams = new Map<string, { atLineStart: boolean; held: string }>()
	return {
		push(chunk, stream = '') {
			let st = streams.get(stream)
			if (!st) {
				st = { atLineStart: true, held: '' }
				streams.set(stream, st)
			}
			let { atLineStart } = st
			let text = st.held + chunk
			let held = ''
			let out = ''
			while (text) {
				const nl = text.indexOf('\n')
				if (!atLineStart) {
					if (nl < 0) {
						out += text
						text = ''
					} else {
						out += text.slice(0, nl + 1)
						text = text.slice(nl + 1)
						atLineStart = true
					}
					continue
				}
				const line = nl < 0 ? text : text.slice(0, nl)
				if (nl < 0) {
					if (prefix.startsWith(line) || line.startsWith(prefix)) held = line
					else {
						out += line
						atLineStart = false
					}
					text = ''
				} else {
					if (!line.startsWith(prefix)) out += `${line}\n`
					text = text.slice(nl + 1)
				}
			}
			st.atLineStart = atLineStart
			st.held = held
			if (out) sink(out)
		},
		flush() {
			for (const st of streams.values()) if (st.held && !st.held.startsWith(prefix)) sink(st.held)
			streams.clear()
		},
	}
}

/** The folders powder-migrate reads *.sql from (infra/powder-migrate, first with a
 *  *.sql at depth 1 wins), relative to /opt/apps/<app>/src (or the app dir). */
export const POWDER_MIGRATE_DIRS = ['src/drizzle', 'drizzle', 'migrations', 'src/migrations', 'supabase/migrations', 'db/migrations'] as const

/** A *.sql path that looks like a migration: in a folder named *migrat*, named
 *  *migrat*, or numbered (`0001_x.sql`, `20240101-x.sql`). grep -iE. */
export const MIGRATION_SQL_ERE = 'migrat[^/]*/[^/]+[.]sql$|/[^/]*migrat[^/]*[.]sql$|/[0-9]{3,}[_-][^/]*[.]sql$'

// Never searched for stray migrations: dependencies, build output, VCS, test fixtures.
const SCAN_PRUNE = ['node_modules', '.next', '.git', '.turbo', '.cache', 'dist', 'build', 'out', 'coverage', 'vendor', 'test', 'tests', '__tests__', 'fixtures', '__fixtures__', 'testdata', 'e2e']

/** Read-only migrate-path scan, run right before powder-migrate (deploy/script.ts).
 *  A subshell (no variable or cwd leaks, set +e, stdin closed), every external
 *  command capped by `timeout` when the host has it (find 10 s, docker 5 s), the
 *  tree walk bounded (-maxdepth 6, SCAN_PRUNE pruned, symlinks not followed). Prints
 *  a `[migrate-path] WARNING` line per finding and one marker: the cases found, or
 *  `ok` only when every part finished; a part that fails or times out makes the
 *  result unknown (no marker) unless something was found; any non-zero find exit
 *  counts as not finished. The tree walk runs only in the src/ layout (a workdir-layout
 *  app dir also holds data and backups): elsewhere the result is never `ok`. `|| true` around it: it
 *  can never fail the deploy. Image: $IMGREF (staged deploys) else $LB_IMG (the
 *  image label guard's resolution), the image the swap will run. '' without a nonce. */
export function migratePathScanShell(nonce: string, workingDir: string): string {
	const m = stabilityMarkerFor(nonce)
	if (!m) return ''
	const prune = SCAN_PRUNE.map((n) => `-name ${shq(n)}`).join(' -o ')
	const fix = 'powder-migrate applies *.sql from src/drizzle, drizzle, migrations, src/migrations, supabase/migrations or db/migrations'
	return (
		'{ ( set +e; set +o pipefail 2>/dev/null; ' +
		'__t=""; __ti=""; if command -v timeout >/dev/null 2>&1; then __t="timeout 10"; __ti="timeout 5"; fi; ' +
		// The tree walk only runs in the src/ layout: a workdir-layout app dir (no src/) also
		// holds runtime data and backups (a dated *.sql dump would read as a stray
		// migration), so there the stray-sql part is unknown.
		`S=${shq(`${workingDir}/src`)}; ` +
		'if [ -L "$S" ]; then exit 0; fi; ' +
		'F=""; U=0; MD=n; ' +
		'if [ -d "$S" ]; then ' +
		// powder-migrate refuses a symlinked candidate dir (the deploy fails there): unknown.
		`for d in ${POWDER_MIGRATE_DIRS.map((d) => shq(d)).join(' ')}; do if [ -L "$S/$d" ]; then exit 0; fi; [ -d "$S/$d" ] || continue; if [ -n "$(find "$S/$d" -maxdepth 1 -name '*.sql' -print 2>/dev/null | head -n 1)" ]; then MD=y; break; fi; done; ` +
		'else U=1; MD=skip; S=""; fi; ' +
		// any non-zero find exit (timeout, permission denied, I/O error) = not finished:
		// unknown. A hit find printed before a non-timeout error still counts.
		`if [ "$MD" = n ]; then L=$($__t find "$S" -maxdepth 6 \\( ${prune} \\) -prune -o -type f -name '*.sql' -print 2>/dev/null); R=$?; if [ "$R" != 0 ]; then U=1; fi; ` +
		`if [ "$R" -ge 124 ]; then L=""; else H=$(printf '%s\\n' "$L" | grep -iE ${shq(MIGRATION_SQL_ERE)} | head -n 1); L=""; ` +
		`if [ -n "$H" ]; then F="$F,stray-sql"; H="\${H#"$S"/}"; H=$(printf '%s' "$H" | tr -cd 'A-Za-z0-9._/-' | cut -c1-200); echo "[migrate-path] WARNING: *.sql migration files (e.g. $H) sit outside the folders powder-migrate reads, so this deploy applies none of them (${fix})"; fi; fi; fi; ` +
		'I="${IMGREF:-}"; [ -n "$I" ] || I="${LB_IMG:-}"; ' +
		`if [ -n "$I" ]; then C=$($__ti docker image inspect -f '{{json .Config.Cmd}} {{json .Config.Entrypoint}}' "$I" 2>/dev/null); if [ $? = 0 ]; then if printf '%s' "$C" | grep -qE ${shq(SCHEMA_TOOL_ERE)}; then F="$F,boot-cmd"; echo "[migrate-path] WARNING: the image command/entrypoint runs a schema tool at container start, outside powder-migrate"; fi; else U=1; fi; ` +
		`C=$($__ti docker image inspect -f '{{index .Config.Labels "powder.release.cmd"}}' "$I" 2>/dev/null); if [ $? = 0 ]; then if printf '%s' "$C" | grep -qE ${shq(RELEASE_SCHEMA_PUSH_ERE)}; then F="$F,release-cmd"; echo "[migrate-path] WARNING: the powder.release.cmd label runs a schema push (drizzle-kit push, prisma db push), which diffs the live schema with no ledger"; fi; else U=1; fi; else U=1; fi; C=""; ` +
		'P=""; if [ -n "${PF_CTX:-}" ]; then P="$PF_CTX/package.json"; elif [ -n "$S" ]; then P="$S/package.json"; else U=1; fi; ' +
		`if [ -z "$P" ]; then :; elif [ -L "$P" ]; then U=1; elif [ -f "$P" ]; then C=$(head -c 262144 "$P" 2>/dev/null | grep -m1 -E '"start"[[:space:]]*:'); if printf '%s' "$C" | grep -qE ${shq(SCHEMA_TOOL_ERE)}; then F="$F,start-script"; echo "[migrate-path] WARNING: package.json start runs a schema tool at container start, outside powder-migrate"; fi; fi; ` +
		'F="${F#,}"; ' +
		`if [ -n "$F" ]; then echo ${shq(`${m} migrate-path`)}" $F"; elif [ "$U" = 0 ]; then echo ${shq(`${m} migrate-path ok`)}; fi; ` +
		') </dev/null 2>/dev/null || true; } && '
	)
}

/** Prebuilt deploys run the test gate on the builder host; the target checks the
 *  same commit's build context for .powder/test.sh (presence only, nothing is read
 *  or run) so the test-gate marker exists there too. Behind `|| true`. '' without a nonce. */
export function testGatePresenceShell(nonce: string): string {
	const present = stabilityMarkShell(nonce, 'test-gate', 'present')
	const absent = stabilityMarkShell(nonce, 'test-gate', 'absent')
	if (!present || !absent) return ''
	return `{ ( if [ -f "\${PF_CTX:-$(pwd)/src}/.powder/test.sh" ]; then ${present}else ${absent}fi ) </dev/null 2>/dev/null || true; } && `
}
