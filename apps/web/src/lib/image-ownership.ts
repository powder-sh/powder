// ONE authority for "whose image is this repo" on a server. The local image store is a
// shared trust domain: every app's build writes into it, and every build (FROM, COPY
// --from, RUN --mount from=) and the test gate read from it (POWDER_BUILD_PULL=0 on the
// usual setup). Without this rule a compose could make any repo "its own" by building one tag of it
// (`image: acme/jobs:mine` made another app's `acme/jobs:latest` own), and a build could
// shadow a public base another app reads (`image: alpine/git:latest`).
//
// The rule: a repo (tag and digest dropped, `docker.io/`, `index.docker.io/`,
// `registry-1.docker.io/` and `library/` dropped, lowercase) is OWNED by app X iff X's
// compose builds it AND no other compose project on the server has built or run that repo
// (server probe: every local image, dangling ones too through their RepoDigests, with its
// `com.docker.compose.project` label, and every container in any state). On top of that
// a name a build writes is refused when another app's Dockerfile on the server reads it as
// an image, or when it is a Docker Hub namespace name (`<ns>/<name>`, no registry host)
// that does not start with the app or project name.
//
// Used by compose-safety.ts (the compose rule, code `image_owner`, high, never
// exemptable) and, through the DFR_OWNED list (dockerfileImageAuthority ->
// dockerfileAuthorityShell), by the on-server Dockerfile check: dfr_own, the IMG branch and
// dfr_bases exempt a ref only when its repo is owned here. Pure: no I/O.

/** Canonical repository of an image ref: digest and tag dropped, Docker Hub host and
 *  `library/` dropped, lowercase. `docker.io/library/Node:22` -> `node`,
 *  `ghcr.io/acme/web:1@sha256:...` -> `ghcr.io/acme/web`, `localhost:5000/x` keeps its host. */
export function ownershipRepo(ref: string): string {
	let r = ref.trim()
	const at = r.indexOf('@')
	if (at !== -1) r = r.slice(0, at)
	const parts = r.split('/')
	if (
		parts.length > 1 &&
		/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)$/i.test(parts[0] ?? '')
	)
		parts.shift()
	if (parts.length > 1 && parts[0]?.toLowerCase() === 'library') parts.shift()
	const last = parts.length - 1
	parts[last] = (parts[last] ?? '').replace(/:[^/:]*$/, '')
	return parts.join('/').toLowerCase()
}

/** A Docker Hub namespace repo: `<ns>/<name>` with no registry host in front (the first
 *  segment has no `.` or `:` and is not `localhost`). `alpine/git`, `oven/bun`. */
function isHubNamespaceRepo(repo: string): boolean {
	const parts = repo.split('/')
	if (parts.length < 2) return false
	const first = parts[0] ?? ''
	return !(first.includes('.') || first.includes(':') || first === 'localhost')
}

/** A repo with a registry host (`ghcr.io/...`, `registry:5000/...`, `localhost/...`). */
function hasRegistryHost(repo: string): boolean {
	return repo.includes('/') && !isHubNamespaceRepo(repo)
}

/** What the server says about image repos. `users`: repo -> the compose projects that built
 *  it (the image's `com.docker.compose.project` label) or run it (a container of that
 *  project, any state). `readers`: repo -> the /opt/apps folders (apps) whose Dockerfiles
 *  read it as an image (FROM, COPY --from, RUN --mount from=). */
export interface ServerImageFacts {
	users: Record<string, string[]>
	readers?: Record<string, string[]>
}

export interface ServerImageInput {
	/** every container, any state: compose project ('' = none) and the image ref */
	containers?: ReadonlyArray<{ project: string; image: string }>
	/** every local image: the repos of its RepoTags and RepoDigests, its compose project label */
	localImages?: ReadonlyArray<{ repos: readonly string[]; project: string }>
	/** every image ref a Dockerfile under /opt/apps reads: the app folder and the ref */
	dockerfileRefs?: ReadonlyArray<{ app: string; ref: string }>
}

function addTo(m: Map<string, Set<string>>, k: string, v: string) {
	if (!k || !v) return
	const s = m.get(k) ?? new Set<string>()
	s.add(v)
	m.set(k, s)
}

function toRecord(m: Map<string, Set<string>>): Record<string, string[]> {
	const out: Record<string, string[]> = {}
	for (const [k, s] of [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
		out[k] = [...s].sort()
	return out
}

/** Pure: the facts from the server probe. A container or image with no compose project (a
 *  hand-started container, an unlabelled image) is no project's: it adds no user. */
export function serverImageFacts(input: ServerImageInput): ServerImageFacts {
	const users = new Map<string, Set<string>>()
	for (const c of input.containers ?? [])
		if (c.project && c.image) addTo(users, ownershipRepo(c.image), c.project)
	for (const i of input.localImages ?? [])
		if (i.project) for (const r of i.repos) addTo(users, ownershipRepo(r), i.project)
	const facts: ServerImageFacts = { users: toRecord(users) }
	if (input.dockerfileRefs) {
		const readers = new Map<string, Set<string>>()
		for (const d of input.dockerfileRefs) addTo(readers, ownershipRepo(d.ref), d.app.toLowerCase())
		facts.readers = toRecord(readers)
	}
	return facts
}

export interface OwnershipSubject {
	/** the powder app name */
	appName: string
	/** its compose project name (composeProjectNameFor(appName)) */
	project: string
}

/** True when `repo` starts with the app or project name (`myapp`, `myapp-x`, `myapp/x`). */
function repoNamedAfter(repo: string, s: OwnershipSubject): boolean {
	return [s.appName.toLowerCase(), s.project.toLowerCase()].some(
		(p) => p !== '' && (repo === p || (repo.startsWith(p) && /[-_./]/.test(repo[p.length] ?? ''))),
	)
}

/** The OTHER projects that built or run `repo` on the server (never this project). */
function otherUsersOf(
	repo: string,
	s: OwnershipSubject,
	facts: ServerImageFacts | undefined,
): string[] {
	const own = new Set([s.project.toLowerCase(), s.appName.toLowerCase()])
	return (facts?.users[repo] ?? []).filter((p) => !own.has(p.toLowerCase()))
}

/** The OTHER apps whose Dockerfiles on the server read `repo` (never this app's own folder). */
function otherReadersOf(
	repo: string,
	s: OwnershipSubject,
	facts: ServerImageFacts | undefined,
): string[] {
	const own = new Set([s.project.toLowerCase(), s.appName.toLowerCase()])
	return (facts?.readers?.[repo] ?? []).filter((a) => !own.has(a))
}

/** Why a name this app BUILDS (a service `image:` next to `build:`, a `build.tags` entry,
 *  the compose default `<project>-<service>`) must not be written to the server's image
 *  store, or null. The three rules, in order:
 *  1. another compose project built or runs that repo (any tag): the build would take
 *     over its name, and the own-image exemption would let this app's Dockerfiles read
 *     the other project's tags;
 *  2. another app's Dockerfile on the server reads that repo as an image: the local tag
 *     would shadow its base. Two names keep passing, so another app cannot take an app's
 *     own image away by naming it in a Dockerfile: a name starting with the app or project
 *     name (`<app>`, `<app>-web`: another app reading it is refused at ITS build), and a
 *     name with a registry host this project itself already built or runs;
 *  3. a Docker Hub namespace name (`alpine/git`, `oven/bun`) not starting with the app or
 *     project name: a public image some build may read. */
export function imageOwnershipRefusal(
	ref: string,
	s: OwnershipSubject,
	facts: ServerImageFacts | undefined,
): string | null {
	const repo = ownershipRepo(ref)
	if (!repo) return null
	const users = otherUsersOf(repo, s, facts)
	if (users.length)
		return `another compose project on this server built or runs the repository ${repo} (${users.join(', ')})`
	const readers = otherReadersOf(repo, s, facts)
	if (readers.length) {
		const own = new Set([s.project.toLowerCase(), s.appName.toLowerCase()])
		const ownHistory = (facts?.users[repo] ?? []).some((p) => own.has(p.toLowerCase()))
		if (!repoNamedAfter(repo, s) && !(hasRegistryHost(repo) && ownHistory))
			return `a Dockerfile of another app on this server reads ${repo} as an image (${readers.join(', ')}); a local build would shadow it`
	}
	if (isHubNamespaceRepo(repo) && !repoNamedAfter(repo, s))
		return `${repo} is a Docker Hub namespace name (a public image other builds may read); a local build would shadow it`
	return null
}

/** The repos of `built` this app OWNS: no refusal above. Canonical, sorted, unique. */
export function ownedImageRepos(
	built: readonly string[],
	s: OwnershipSubject,
	facts: ServerImageFacts | undefined,
): string[] {
	const out = new Set<string>()
	for (const b of built) if (b && !imageOwnershipRefusal(b, s, facts)) out.add(ownershipRepo(b))
	return [...out].sort()
}
