import { randomBytes } from 'node:crypto'
import { appRepos, createId, db, eq, prefixes, previewDeploys, servers } from './db'
import type { AppRepo } from './db'
import { decryptSecret, encryptSecret } from './crypto'
import { branchProblem, repoUrlProblem } from './git-input'
import { projectNameCollisionError } from './app-names'
import { appNameDbClash } from './backup-db-owner'

function newWebhookToken(): string {
	return randomBytes(24).toString('base64url')
}

function newWebhookSecret(): string {
	return randomBytes(32).toString('hex')
}

export async function getRepoFor(
	serverId: string,
	containerName: string,
): Promise<AppRepo | null> {
	const rows = await db
		.select()
		.from(appRepos)
		.where(eq(appRepos.serverId, serverId))
		.limit(1000)
	return rows.find((r) => r.containerName === containerName) ?? null
}

export async function getRepoByToken(token: string): Promise<AppRepo | null> {
	const [row] = await db.select().from(appRepos).where(eq(appRepos.webhookToken, token)).limit(1)
	return row ?? null
}

/** null when a new app named `containerName` on `serverId` gets a compose project
 *  name of its own (projectNameCollisionError against the server's app_repos names), and
 * is neither `<other>-db` of a registered app nor the parent of a registered
 *  `<name>-db` (appNameDbClash). */
export async function projectNameProblem(
	serverId: string,
	containerName: string,
	q: Pick<typeof db, 'select'> = db,
): Promise<string | null> {
	const names = await appNamesOnServer(serverId, q)
	// also the `<app>-db` backup convention (backup-db-owner.ts).
	return projectNameCollisionError(containerName, names) ?? appNameDbClash(containerName, names)
}

/** A new app may not take the name of any preview row (any status, any server): a
 *  preview spin re-clones its row's working dir, /opt/apps/<name>, and its cleanup
 *  removes it. Null when free. */
export async function previewNameProblem(containerName: string, q: Pick<typeof db, 'select'> = db): Promise<string | null> {
	const rows = await q
		.select({ id: previewDeploys.id })
		.from(previewDeploys)
		.where(eq(previewDeploys.containerName, containerName))
	return rows.length
		? `"${containerName}" is the name of a preview of another app; pick another name, or delete that preview first`
		: null
}

/** The app_repos container names on a server. */
export async function appNamesOnServer(serverId: string, q: Pick<typeof db, 'select'> = db): Promise<string[]> {
	const rows = await q
		.select({ name: appRepos.containerName })
		.from(appRepos)
		.where(eq(appRepos.serverId, serverId))
	return rows.map((r) => r.name)
}

/** createRepo refused: the server row is gone (deleted while the app was set up). */
export class ServerGoneError extends Error {
	constructor(serverId: string) {
		super(`server ${serverId} no longer exists`)
		this.name = 'ServerGoneError'
	}
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Inside an app-creating transaction: key-share-lock the server row, so deleteServer
 *  (FOR UPDATE on the same row, lib/servers.ts) waits for this transaction and then
 *  sees its app row, or this one waits for the delete and finds no server. There is
 *  no foreign key from app_repos to servers; this lock is what serializes the two.
 *  FOR KEY SHARE, not FOR SHARE: an update of the row's other columns (status,
 *  last_seen_at) does not wait for the create. Throws ServerGoneError when the row
 *  is not there. */
export async function lockServerForAppCreate(tx: Tx, serverId: string): Promise<void> {
	const [row] = await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId)).for('key share')
	if (!row) throw new ServerGoneError(serverId)
}

export async function createRepo(input: {
	serverId: string
	containerName: string
	repoUrl: string
	branch: string
	pub: string
	priv: string
	hasPostgres?: boolean
	hasKv?: boolean
	ownerUserId?: string
	/** 'build' | 'registry' | 'auto'. /new passes 'build' (it scaffolds a
	 *  build: key); adopt/import flows default to 'auto' since the existing
	 *  container may still be registry-mode. */
	buildMode?: string
	/** The Dockerfile and container port /new validated (validateAppInputs).
	 *  Stored so previews build and route like the app. Omitted: './Dockerfile'
	 *  and NULL (previews then read the port from the app's compose). */
	dockerfilePath?: string
	containerPort?: number
}): Promise<{ row: AppRepo; webhookSecret: string }> {
	const bad = repoUrlProblem(input.repoUrl) ?? branchProblem(input.branch)
	if (bad) throw new Error(bad)
	const webhookSecret = newWebhookSecret()
	const id = createId(prefixes.appRepo)
	const row = await db.transaction(async (tx) => {
		await lockServerForAppCreate(tx, input.serverId)
		// backstop; the create / import routes check first and answer 400.
		const clash = await projectNameProblem(input.serverId, input.containerName, tx)
		if (clash) throw new Error(clash)
		const [inserted] = await tx
			.insert(appRepos)
			.values({
				id,
				serverId: input.serverId,
				containerName: input.containerName,
				repoUrl: input.repoUrl,
				branch: input.branch,
				webhookToken: newWebhookToken(),
				webhookSecretEncrypted: encryptSecret(webhookSecret),
				deployKeyPub: input.pub,
				deployKeyPrivEncrypted: encryptSecret(input.priv),
				hasPostgres: input.hasPostgres === true,
				hasKv: input.hasKv === true,
				ownerUserId: input.ownerUserId ?? null,
				buildMode: input.buildMode ?? 'auto',
				...(input.dockerfilePath ? { dockerfilePath: input.dockerfilePath } : {}),
				containerPort: input.containerPort ?? null,
			})
			.returning()
		return inserted
	})
	if (!row) throw new Error('failed to insert repo')
	return { row, webhookSecret }
}

/** record the GitHub ids of what powder installed at connect.
 *  Best effort: a failure is logged, the connect stands. */
export async function setRepoGithubIds(
	id: string,
	ids: { deployKeyId?: number | null; hookId?: number | null; repoId?: number | null },
): Promise<void> {
	const set: Partial<Pick<AppRepo, 'githubDeployKeyId' | 'githubHookId' | 'githubRepoId'>> = {}
	if (typeof ids.deployKeyId === 'number') set.githubDeployKeyId = ids.deployKeyId
	if (typeof ids.hookId === 'number') set.githubHookId = ids.hookId
	if (typeof ids.repoId === 'number') set.githubRepoId = ids.repoId
	if (Object.keys(set).length === 0) return
	try {
		await db.update(appRepos).set(set).where(eq(appRepos.id, id))
	} catch (err) {
		console.warn('[repos] could not store GitHub ids:', err instanceof Error ? err.message : err)
	}
}

export async function deleteRepo(id: string): Promise<void> {
	await db.delete(appRepos).where(eq(appRepos.id, id))
}

export function decryptWebhookSecret(row: AppRepo): string {
	return decryptSecret(row.webhookSecretEncrypted)
}

export function decryptDeployKey(row: AppRepo): string {
	return decryptSecret(row.deployKeyPrivEncrypted)
}
