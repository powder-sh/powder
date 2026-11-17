// Which servers /new can deploy to, and whether it shows a picker. Pure, so the
// rule is unit-tested (lib/__tests__/new-app-servers.test.ts).
//
// /new scaffolds a docker compose app, so only `compose` servers are eligible.
// The picker shows whenever there is more than one eligible server; exactly one
// is picked for the user. Traefik or not does not change that: two Traefik
// servers still need a choice.

export interface NewAppServerLike {
	id: string
	kind: string
}

export interface NewAppServerChoice<S extends NewAppServerLike> {
	eligible: S[]
	/** servers /new cannot use (raw-docker) */
	ineligible: S[]
	/** the id to preselect: the only eligible server, else the current pick when it is still eligible */
	selectedId: string
	showPicker: boolean
}

export function newAppServerChoice<S extends NewAppServerLike>(all: readonly S[], currentId = ''): NewAppServerChoice<S> {
	const eligible = all.filter((s) => s.kind === 'compose')
	const ineligible = all.filter((s) => s.kind !== 'compose')
	const selectedId =
		eligible.length === 1 ? (eligible[0]?.id ?? '') : eligible.some((s) => s.id === currentId) ? currentId : ''
	return { eligible, ineligible, selectedId, showPicker: eligible.length > 1 }
}
