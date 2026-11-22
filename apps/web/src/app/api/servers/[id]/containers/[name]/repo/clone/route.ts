import { requireContainerAccess } from '@/lib/access'
import { type AppCheckout, cloneRefusal } from '@/lib/app-checkout'
import { appLockPath } from '@/lib/deploy-supersede'
import { decryptDeployKey, getRepoFor } from '@/lib/repos'
import { redactSecrets } from '@/lib/secret-text'
import { inspectContainer, runCommand, writeFileSecret } from '@/lib/ssh'
import { shq } from '@/lib/shell'
import { CLONE_KEY_TMP_PREFIX, randomTempPath } from '@/lib/temp-path'
import { cloneIntoAppSrc, deployKeyMissingForRepo, probeAppCheckout } from '@/lib/ssh/git'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Connects a repo to a container that was started by hand with no checkout: clones
// the repo into <working dir>/src (the standard layout) and touches nothing else.
// The working dir (runtime compose, deploy key, data dirs) is never moved or
// replaced. Refused, with nothing written, whenever the app already has a checkout
// (src/ or the working dir), a src/ that is not a checkout is there, or the layout
// cannot be read (lib/app-checkout.ts cloneRefusal).
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name, { allowUnmanaged: true })
	if (access instanceof Response) return access
	const { server } = access

	const repo = await getRepoFor(id, name)
	if (!repo) return Response.json({ error: 'repo not connected' }, { status: 400 })

	const detail = await inspectContainer(server, name)
	const { workingDir, service } = detail.compose
	if (!workingDir || !service) {
		return Response.json(
			{ error: 'container has no compose working dir / service labels' },
			{ status: 400 },
		)
	}

	const wd = workingDir.replace(/\/+$/, '')
	const keyPath = `${wd}/.deploy-key`
	const priv = decryptDeployKey(repo)
	const keyFailed = (err: unknown) =>
		Response.json(
			{
				error: `the clone is in place at ${wd}/src, but the deploy key could not be written to ${keyPath} (${redactSecrets(clientErrorMessage(err, 'write failed', 'servers/:id/containers/:name/repo/clone'))}). Deploys need it: press clone again now, or after a reload press "write key" on the repo card; either writes only the key.`,
			},
			{ status: 500 },
		)

	// the layout decides, before anything is written
	let co: AppCheckout
	try {
		co = await probeAppCheckout(server, workingDir)
	} catch {
		co = { kind: 'unknown' }
	}
	// the state an earlier clone left when its key could not be written: src/ is a
	// checkout of this repo and <wd>/.deploy-key is missing. Then write only the key.
	if (co.kind === 'src' && (await deployKeyMissingForRepo(server, wd, repo.repoUrl).catch(() => false))) {
		try {
			await writeFileSecret(server, keyPath, priv)
		} catch (err) {
			return keyFailed(err)
		}
		return Response.json({ ok: true, output: `the clone was already in place at ${wd}/src; wrote the missing deploy key to ${keyPath}` })
	}
	const refusal = cloneRefusal(workingDir, co)
	if (refusal) return Response.json({ error: refusal }, { status: 409 })

	// The clone reads the deploy key from a temp file outside the app's directory, so
	// a clone the script refuses leaves the app's directory exactly as it was (the
	// script removes the temp key when it exits, and so does the finally below). Only
	// after the clone is in place is <working dir>/.deploy-key (planted on connect)
	// re-planted from the db, in case it went missing.
	const tmpKey = randomTempPath(CLONE_KEY_TMP_PREFIX)
	try {
		let output: string
		try {
			await writeFileSecret(server, tmpKey, priv)
			;({ output } = await cloneIntoAppSrc(server, workingDir, repo.repoUrl, repo.branch, tmpKey, appLockPath(workingDir, service), { removeKey: true }))
		} catch (err) {
			// the script may still be running when the SSH call gives up: say so, not "failed"
			if (err instanceof Error && err.message.startsWith('SSH timeout'))
				return Response.json(
					{ error: `the clone did not answer in time and may still be running on the server; reload in a minute to see whether ${wd}/src appeared` },
					{ status: 504 },
				)
			return Response.json(
				{ error: redactSecrets(clientErrorMessage(err, 'clone failed', 'servers/:id/containers/:name/repo/clone')) },
				{ status: 500 },
			)
		}
		try {
			await writeFileSecret(server, keyPath, priv)
		} catch (err) {
			return keyFailed(err)
		}
		// git output and errors can carry secrets (a token in a remote URL)
		return Response.json({ ok: true, output: redactSecrets(output) })
	} finally {
		await runCommand(server, `rm -f ${shq(tmpKey)}`, 10_000).catch(() => {})
	}
}
