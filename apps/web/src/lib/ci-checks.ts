// powder's own checks for the ci tab: the recorded test gate result of a deploy, which
// stage a failed deploy stopped at, and the one-line summary over the last 30 days. Pure:
// the route reads the rows, these functions decide what they mean.

import type { TestGate } from '@powder/db/schema'
import { isTestGateStep } from './deploy-failure'

/** The test gate of one deploy as the tab shows it: the value the deploy recorded in
 *  deploys.test_gate (the deploy script's nonced mark, never a log search), or unknown.
 *  - passed: .powder/test.sh ran and exited 0
 *  - failed: the deploy failed at the test gate
 *  - none: the commit had no .powder/test.sh, nothing tested it before the swap
 *  - unknown: nothing recorded (NULL: the deploy ended before the gate, or the row is
 *    older than the column), or not a git deploy (a rollback runs no gate) */
export type CiTestGate = TestGate | 'unknown'

/** The stored value as a CiTestGate. Only git deploys run the gate. */
export function ciTestGate(kind: string, stored: TestGate | null | undefined): CiTestGate {
	if (kind !== 'git_deploy') return 'unknown'
	return stored ?? 'unknown'
}

/** What a row of the tab shows about its gate and its failure. */
export interface GateDisplay {
	/** the gate badge: passed, failed, none, or null for no badge */
	badge: TestGate | null
	/** the stage after "failed at", or null when the row is not a failure */
	failedAt: string | null
}

/** The one display rule for a row (see docs/deploys.md "The ci tab"):
 *  - a failure (status failed, not superseded) reads "failed at <failed_step>"; with no
 *    failed_step it reads "failed at test gate" when the gate is recorded as failed, else
 *    "failed at an unrecorded step"
 *  - the badge is the recorded gate: passed, none, or failed; a failed gate gets no badge
 *    when the failure line already names the test gate (it says the same thing)
 *  - unknown shows nothing, and a superseded row (it did nothing) shows no badge */
export function gateDisplay(row: {
	status: string
	superseded: boolean
	failedStep: string | null
	testGate: CiTestGate
}): GateDisplay {
	const failure = row.status === 'failed' && !row.superseded
	const failedAt = failure
		? row.failedStep || (row.testGate === 'failed' ? 'test gate' : 'an unrecorded step')
		: null
	if (row.superseded || row.testGate === 'unknown') return { badge: null, failedAt }
	if (row.testGate === 'failed' && isTestGateStep(failedAt)) return { badge: null, failedAt }
	return { badge: row.testGate, failedAt }
}

/** A failed_step as a short stage word for the summary line. null = no step recorded. */
export function failedStage(step: string | null | undefined): string {
	const s = (step ?? '').trim().toLowerCase()
	if (!s) return 'no step recorded'
	if (/test gate/.test(s)) return 'test gate'
	if (/preflight/.test(s)) return 'preflight'
	if (/^build$|docker compose build|prebuilt image/.test(s)) return 'build'
	if (/compose guard/.test(s)) return 'compose guard'
	if (/db migrate/.test(s)) return 'migrate'
	if (/health/.test(s)) return 'health check'
	return s.replace(/\s*\(.*$/, '')
}

/** A deploy that lost to a newer one and deliberately did nothing (deploy-runner.ts:
 *  status failed, failed_step "superseded"). Not a failure: no red, not counted as failed. */
export function isSuperseded(row: {
	status: string
	failedStep: string | null | undefined
}): boolean {
	return row.status === 'failed' && row.failedStep === 'superseded'
}

export interface StatusCount {
	status: string
	failedStep: string | null
	/** the stored deploys.test_gate; a failed deploy with no failed_step and a failed gate
	 *  counts as "test gate", the stage its row shows (gateDisplay) */
	testGate?: TestGate | null
	count: number
}

/** "<days> days: <n> deploys, <f> failed (<count> <stage>, ...)". Only finished deploys count;
 *  superseded ones did nothing and count neither as deploys nor as failed. */
export function checksSummaryLine(rows: readonly StatusCount[], days = 30): string {
	let total = 0
	let failed = 0
	const byStage = new Map<string, number>()
	for (const r of rows) {
		if (r.status !== 'success' && r.status !== 'failed') continue
		if (isSuperseded(r)) continue
		total += r.count
		if (r.status !== 'failed') continue
		failed += r.count
		const stage = !r.failedStep && r.testGate === 'failed' ? 'test gate' : failedStage(r.failedStep)
		byStage.set(stage, (byStage.get(stage) ?? 0) + r.count)
	}
	const head = `${days} days: ${total} ${total === 1 ? 'deploy' : 'deploys'}`
	if (total === 0) return `${days} days: no deploys`
	if (failed === 0) return `${head}, none failed`
	const parts = [...byStage.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([stage, n]) => `${n} ${stage}`)
	return `${head}, ${failed} failed (${parts.join(', ')})`
}

/** The notice rule: the most recent successful git deploy (rows newest first) is
 *  recorded as having no .powder/test.sh ('none'). Unknown (NULL) is not "none": no
 *  notice without a record. */
export function lacksTestGate(
	rows: readonly { kind: string; status: string; testGate: CiTestGate }[],
): boolean {
	const last = rows.find((r) => r.kind === 'git_deploy' && r.status === 'success')
	return last?.testGate === 'none'
}
