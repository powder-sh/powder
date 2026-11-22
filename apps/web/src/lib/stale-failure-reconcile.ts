// When may the servers sync record a synthetic "reconcile" success after a failed
// deploy? Only when the failure is provably stale: the app pulls a registry image
// (app_repos.build_mode = 'registry') and the image the container runs now is a
// different image from the one the failed deploy targeted. The image NAME proves
// nothing (a locally built image is often tagged like a registry image), so it is
// never part of the rule; the evidence is two image ids read on the server. When the
// failed deploy recorded no image reference (a failed deploy records none today:
// deploys.image_tag is written on success only), there is nothing to compare and
// nothing is reconciled: the failure stays on screen until a real deploy replaces it.
// Pure module.

/** A reference `docker image inspect` may be given: a tag or a digest, shell-safe. */
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-:/@]*$/

export interface ReconcileInput {
	buildMode: string | null
	lastDeploy: { status: string; imageTag: string | null } | null
}

/** The image reference to resolve on the server for this app, or null when the app
 *  is not a candidate (not registry mode, last deploy not failed, nothing recorded). */
export function reconcileTarget(i: ReconcileInput): string | null {
	if (i.buildMode !== 'registry') return null
	if (!i.lastDeploy || i.lastDeploy.status !== 'failed') return null
	const ref = i.lastDeploy.imageTag
	if (!ref || !IMAGE_REF.test(ref) || ref.length > 300) return null
	return ref
}

/** Reconcile only with two image ids that both resolved and differ. */
export function shouldReconcile(
	i: ReconcileInput & { runningImageId: string | null; targetImageId: string | null },
): boolean {
	if (!reconcileTarget(i)) return false
	const running = i.runningImageId?.trim()
	const target = i.targetImageId?.trim()
	if (!running || !target) return false
	if (!/^sha256:[0-9a-f]{64}$/.test(running) || !/^sha256:[0-9a-f]{64}$/.test(target)) return false
	return running !== target
}

/** Parse `name<TAB>running image id<TAB>target image id` lines (the command in
 *  server-list.ts prints one per candidate; an id that did not resolve is empty). */
export function parseImageIds(stdout: string): Map<string, { running: string | null; target: string | null }> {
	const out = new Map<string, { running: string | null; target: string | null }>()
	for (const line of stdout.split('\n')) {
		const parts = line.split('\t')
		if (parts.length !== 3) continue
		const [name = '', running = '', target = ''] = parts
		if (!name) continue
		out.set(name, { running: running.trim() || null, target: target.trim() || null })
	}
	return out
}
