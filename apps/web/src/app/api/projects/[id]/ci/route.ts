// The /projects/[id]/ci tab. Two parts, each its own request (?part=checks,
// ?part=github; no part = both) so a slow or failing GitHub never holds the checks:
//   1. checks: powder's own checks, from the deploys table (always, no GitHub needed):
//      the last git deploys with the stage each stopped at, the test gate result each
//      deploy recorded (deploys.test_gate), and a 30-day summary line.
//   2. GitHub Actions: the repo's runs on the project's branch, kept only when their
//      workflow is active and judged against the deployed commit (lib/ci-runs.ts). The
//      latest current failing run gets the cheap pattern-match diagnosis; "diagnose
//      with AI" hits the separate diagnose endpoint.

import { type CurrentUser, requireProjectAccess } from '@/lib/access'
import {
	checksSummaryLine,
	ciTestGate,
	gateDisplay,
	isSuperseded,
	lacksTestGate,
} from '@/lib/ci-checks'
import { type DeployedCommit, ciRunsVerdict } from '@/lib/ci-runs'
import { translateFailure } from '@/lib/ci-translate'
import { type AppRepo, and, db, deploys, desc, eq, gte, inArray, isNotNull, sql } from '@/lib/db'
import {
	CI_GH_TIMEOUT_MS,
	getCommitBySha,
	getRunFailureTail,
	listRunsForRepo,
	listWorkflowsForRepo,
	parseGitHubRepo,
} from '@/lib/github-ci'
import { getAdminGithubIntegration } from '@/lib/integrations'
import { redactNullable } from '@/lib/secret-text'
import { deployListOrder } from '@/lib/deploy-order-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CHECK_ROWS = 20
const SUMMARY_DAYS = 30
const SHOWN_RUNS = 10

const iso = (v: Date | string | null): string | null => (v ? new Date(v).toISOString() : null)

// The kinds the tab lists: git deploys, and rollbacks (they replace the running app too).
const LISTED_KINDS = ['git_deploy', 'rollback'] as const

// The gate is the stored deploys.test_gate (written by the deploy runner), never the
// deploy log. The one raw deploy text read here (secret-raw-reads allowlist) is
// errorSummary, and it leaves only through redactNullable.
const checkColumns = {
	id: deploys.id,
	kind: deploys.kind,
	status: deploys.status,
	gitSha: deploys.gitSha,
	queuedAt: deploys.queuedAt,
	startedAt: deploys.startedAt,
	finishedAt: deploys.finishedAt,
	failedStep: deploys.failedStep,
	exitCode: deploys.exitCode,
	errorSummary: deploys.errorSummary,
	testGate: deploys.testGate,
}

type Repo = AppRepo

// The deployed commit: the latest successful deploy that names one (a rollback too),
// picked by started_at, with the time that deploy was QUEUED (lib/ci-runs.ts rule 2):
// started_at is reset when the worker claims the row, queued_at never is.
async function readDeployed(repo: Repo): Promise<DeployedCommit | null> {
	const [row] = await db
		.select({ gitSha: deploys.gitSha, queuedAt: deploys.queuedAt })
		.from(deploys)
		.where(
			and(
				eq(deploys.serverId, repo.serverId),
				eq(deploys.containerName, repo.containerName),
				inArray(deploys.kind, [...LISTED_KINDS]),
				eq(deploys.status, 'success'),
				isNotNull(deploys.gitSha),
			),
		)
		.orderBy(desc(deploys.startedAt))
		.limit(1)
	return row ? { sha: row.gitSha, queuedAt: iso(row.queuedAt) } : null
}

// ── 1. powder's own checks: the database only ──────────────────────────────
async function readChecks(repo: Repo) {
	const listed = inArray(deploys.kind, [...LISTED_KINDS])
	const since = new Date(Date.now() - SUMMARY_DAYS * 86_400_000)
	const [rows, lastSuccess, counts, deployed] = await Promise.all([
		db
			.select(checkColumns)
			.from(deploys)
			.where(
				and(
					eq(deploys.serverId, repo.serverId),
					eq(deploys.containerName, repo.containerName),
					listed,
				),
			)
			// the check list orders like every deploy list: newest push first (lib/deploy-order.ts)
			.orderBy(...deployListOrder())
			.limit(CHECK_ROWS),
		// the notice reads the newest successful git deploy, however far back
		db
			.select(checkColumns)
			.from(deploys)
			.where(
				and(
					eq(deploys.serverId, repo.serverId),
					eq(deploys.containerName, repo.containerName),
					eq(deploys.kind, 'git_deploy'),
					eq(deploys.status, 'success'),
				),
			)
			.orderBy(desc(deploys.startedAt))
			.limit(1),
		db
			.select({
				status: deploys.status,
				failedStep: deploys.failedStep,
				testGate: deploys.testGate,
				count: sql<number>`count(*)::int`,
			})
			.from(deploys)
			.where(
				and(
					eq(deploys.serverId, repo.serverId),
					eq(deploys.containerName, repo.containerName),
					listed,
					gte(deploys.startedAt, since),
				),
			)
			.groupBy(deploys.status, deploys.failedStep, deploys.testGate),
		readDeployed(repo),
	])

	const checkRows = rows.map((r) => {
		const superseded = isSuperseded(r)
		const testGate = ciTestGate(r.kind, r.testGate)
		const display = gateDisplay({
			status: r.status,
			superseded,
			failedStep: r.failedStep,
			testGate,
		})
		return {
			id: r.id,
			kind: r.kind,
			status: r.status,
			superseded,
			sha: r.gitSha,
			queuedAt: iso(r.queuedAt),
			startedAt: iso(r.startedAt) ?? '',
			finishedAt: iso(r.finishedAt),
			// parsed from the script output: masked like every other deploy reader
			failedStep: redactNullable(r.failedStep),
			exitCode: r.exitCode,
			// deploy text goes through the read-side redactor, like every deploy reader.
			errorSummary: redactNullable(r.errorSummary),
			testGate,
			gateBadge: display.badge,
			failedAt: display.failedAt,
		}
	})
	const last = lastSuccess[0]
	const noTestGate = last
		? lacksTestGate([
				{ kind: last.kind, status: last.status, testGate: ciTestGate(last.kind, last.testGate) },
			])
		: false
	return {
		rows: checkRows,
		summary: checksSummaryLine(
			counts.map((c) => ({
				status: c.status,
				failedStep: c.failedStep,
				testGate: c.testGate,
				count: Number(c.count),
			})),
			SUMMARY_DAYS,
		),
		noTestGate,
		deployedSha: deployed?.sha ?? null,
	}
}

// ── 2. GitHub Actions, plus the commit messages of the listed deploys ─────────
// Every GitHub call has a time limit (CI_GH_TIMEOUT_MS); a failure reads as "could not
// read", never as "no workflows".
async function readGithub(repo: Repo, user: CurrentUser) {
	const parsed = parseGitHubRepo(repo.repoUrl)
	if (!parsed) return { connected: false, reason: 'not_github', runs: [] }

	// Only a CURRENT admin's token, the owner's first when the owner is one (same
	// as the diagnose route); a removed or non-admin owner's stored token is never used.
	const tokenSource = await getAdminGithubIntegration(repo.ownerUserId ?? user.id)
	if (!tokenSource) return { connected: false, reason: 'no_token', runs: [] }
	const { token } = tokenSource

	const [deployed, shaRows] = await Promise.all([
		readDeployed(repo),
		db
			.select({ gitSha: deploys.gitSha })
			.from(deploys)
			.where(
				and(
					eq(deploys.serverId, repo.serverId),
					eq(deploys.containerName, repo.containerName),
					inArray(deploys.kind, [...LISTED_KINDS]),
				),
			)
			.orderBy(...deployListOrder())
			.limit(CHECK_ROWS),
	])
	const shas = [...new Set(shaRows.map((r) => r.gitSha).filter((x): x is string => !!x))]
	const commitMessages: Record<string, string> = {}

	const [runs, workflows] = await Promise.all([
		// 30, not 10: dropped runs (deleted, disabled or GitHub-managed workflows) make
		// room; the tab shows the first 10 kept
		listRunsForRepo(token, parsed.owner, parsed.repo, { branch: repo.branch, perPage: 30 }),
		listWorkflowsForRepo(token, parsed.owner, parsed.repo),
		// commit messages: cached per SHA (github-ci.ts), best effort.
		Promise.allSettled(
			shas.map(async (sha) => {
				const commit = await getCommitBySha(token, parsed.owner, parsed.repo, sha, {
					timeoutMs: CI_GH_TIMEOUT_MS,
				})
				if (commit) commitMessages[sha] = commit.message
			}),
		),
	])

	const verdict = ciRunsVerdict(runs, workflows, deployed)

	// Translate the latest CURRENT failing run synchronously: cheap pattern match, no LLM.
	let latestFailureDiagnosis = null
	if (verdict.failingRun) {
		const log = await getRunFailureTail(
			token,
			parsed.owner,
			parsed.repo,
			verdict.failingRun.id,
			6000,
			{
				timeoutMs: CI_GH_TIMEOUT_MS,
			},
		)
		latestFailureDiagnosis = translateFailure(log)
	}

	return {
		connected: true,
		owner: parsed.owner,
		repo: parsed.repo,
		branch: repo.branch,
		commitMessages,
		workflows: verdict.workflows,
		activeWorkflows: verdict.activeWorkflows,
		droppedRuns: verdict.dropped,
		runs: verdict.runs.slice(0, SHOWN_RUNS).map((r) => ({
			id: r.id,
			name: r.name,
			displayTitle: r.display_title,
			status: r.status,
			conclusion: r.conclusion,
			htmlUrl: r.html_url,
			headSha: r.head_sha,
			headBranch: r.head_branch,
			runNumber: r.run_number,
			event: r.event,
			createdAt: r.created_at,
			runStartedAt: r.run_started_at,
			updatedAt: r.updated_at,
			notDeployed: r.notDeployed,
		})),
		latestFailedRunId: verdict.failingRun?.id ?? null,
		latestFailureDiagnosis,
	}
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params

	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id, { selfRead: true })
	if (access instanceof Response) return access
	const { repo, user } = access

	// GitHub failing in a way the readers did not catch still reads as "could not read".
	const github = () =>
		readGithub(repo, user).catch(() => ({
			connected: true,
			workflows: 'unknown' as const,
			runs: [],
		}))
	const part = new URL(req.url).searchParams.get('part')
	if (part === 'checks') return Response.json({ checks: await readChecks(repo) })
	if (part === 'github') return Response.json(await github())
	const [checks, gh] = await Promise.all([readChecks(repo), github()])
	return Response.json({ checks, ...gh })
}
