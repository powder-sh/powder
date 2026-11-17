import { nanoid } from 'nanoid'

export const prefixes = {
	deploy: 'dep',
	server: 'srv',
	appRepo: 'rep',
	integration: 'itg',
	cronJob: 'cron',
	cronRun: 'crun',
	cronJobRun: 'cjr',
	domainRedirect: 'dr',
	previewDeploy: 'pre',
	appDomain: 'adom',
	userApiToken: 'tok',
	backup: 'bkp',
	backupRestore: 'rst',
	repoGroup: 'rgrp',
	envVar: 'env',
	notificationTarget: 'ntf',
} as const

export type EntityPrefix = (typeof prefixes)[keyof typeof prefixes]

export function createId(prefix: EntityPrefix): string {
	return `${prefix}_${nanoid(21)}`
}
