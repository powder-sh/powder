import { describe, expect, it } from 'vitest'
import {
	type DeployFailureTarget,
	deployFailureRoutes,
	describeDeployFailureRoutes,
} from '../deploy-failure-routes'
import { buildChecklist } from '../setup-checklist'

const webhook = (over: Partial<DeployFailureTarget> = {}): DeployFailureTarget => ({
	id: 't1',
	kind: 'webhook',
	events: ['deploy_failed'],
	appRepoId: null,
	enabled: true,
	urlEncrypted: 'v1:sealed',
	email: null,
	...over,
})
const email = (over: Partial<DeployFailureTarget> = {}): DeployFailureTarget =>
	webhook({ id: 't2', kind: 'email', urlEncrypted: null, email: 'ops@example.com', ...over })

const SMTP = {
	POWDER_SMTP_URL: 'smtp://mail.example.com:587',
	POWDER_MAIL_FROM: 'powder@example.com',
}
const OPS = {
	POWDER_HQ_INGEST_TOKEN: 'token',
	POWDER_HQ_INGEST_URL: 'https://ops.example.com/ingest/deploy',
}
const ENV_HOOK = { POWDER_NOTIFY_WEBHOOK_URL: 'https://hooks.example.com/x' }

describe('deployFailureRoutes: every route that carries a failed deploy', () => {
	it('none: no env, no targets', () => {
		expect(deployFailureRoutes({}, [])).toEqual([])
	})
	it('each route alone', () => {
		expect(deployFailureRoutes(ENV_HOOK, [])).toEqual(['env-webhook'])
		expect(deployFailureRoutes({}, [webhook()])).toEqual(['webhook-target'])
		expect(deployFailureRoutes(SMTP, [email()])).toEqual(['email-target'])
		expect(deployFailureRoutes(OPS, [])).toEqual(['ops-endpoint'])
	})
	it('several at once, in a fixed order', () => {
		expect(deployFailureRoutes({ ...OPS, ...ENV_HOOK }, [])).toEqual([
			'env-webhook',
			'ops-endpoint',
		])
		expect(deployFailureRoutes({ ...OPS, ...SMTP, ...ENV_HOOK }, [email(), webhook()])).toEqual([
			'webhook-target',
			'email-target',
			'env-webhook',
			'ops-endpoint',
		])
	})
	it('the ops endpoint counts only with the deploy URL and the token; the warning and cron URLs carry no deploys', () => {
		expect(deployFailureRoutes({ POWDER_HQ_INGEST_URL: OPS.POWDER_HQ_INGEST_URL }, [])).toEqual([])
		expect(
			deployFailureRoutes({ POWDER_HQ_INGEST_TOKEN: 'token', POWDER_HQ_INGEST_URL: ' ' }, []),
		).toEqual([])
		expect(
			deployFailureRoutes(
				{
					POWDER_HQ_INGEST_TOKEN: 'token',
					POWDER_HQ_GENERIC_URL: 'https://ops.example.com/ingest/generic',
					POWDER_HQ_CRON_URL: 'https://ops.example.com/ingest/cron',
				},
				[],
			),
		).toEqual([])
	})
	it('targets that do not deliver a failed deploy of every app do not count', () => {
		expect(deployFailureRoutes({}, [webhook({ enabled: false })])).toEqual([])
		expect(deployFailureRoutes({}, [webhook({ events: ['app_down'] })])).toEqual([])
		expect(deployFailureRoutes({}, [webhook({ appRepoId: 'app_1' })])).toEqual([])
		expect(deployFailureRoutes({}, [webhook({ urlEncrypted: null })])).toEqual([])
		// an email target sends nothing without SMTP
		expect(deployFailureRoutes({}, [email()])).toEqual([])
		expect(deployFailureRoutes({ POWDER_SMTP_URL: SMTP.POWDER_SMTP_URL }, [email()])).toEqual([])
	})
	it('the description names routes, never a value', () => {
		const text = describeDeployFailureRoutes(deployFailureRoutes({ ...OPS, ...ENV_HOOK }, []))
		expect(text).toBe(
			'failed deploys go to the env webhook (POWDER_NOTIFY_WEBHOOK_URL) and your ops endpoint (ops endpoint reporting, POWDER_HQ_INGEST_URL)',
		)
		for (const v of [...Object.values(OPS), ...Object.values(ENV_HOOK)])
			expect(text).not.toContain(v)
	})
	it('the checklist row is done with the route named, or missing with none', () => {
		const item = (routes: ReturnType<typeof deployFailureRoutes>) =>
			buildChecklist({
				githubOAuth: true,
				servers: [],
				backups: true,
				deployFailureRoutes: routes,
				adminPersisted: true,
			}).find((i) => i.id === 'notify-webhook')
		expect(item(deployFailureRoutes(OPS, []))).toMatchObject({
			state: 'done',
			detail:
				'failed deploys go to your ops endpoint (ops endpoint reporting, POWDER_HQ_INGEST_URL)',
		})
		expect(item([])).toMatchObject({ state: 'missing' })
	})
})
