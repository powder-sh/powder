// What changed in an app's compose STRUCTURE since its last successful deploy.
//
// A successful deploy stores, next to compose_config_hash, a small view of the same
// structural config (deploys.compose_config_view, 0062): per service, per key, the
// values that are safe to print (network_mode, ports, binds, image repo, networks, ...)
// and, for every key that can hold a secret (labels, build, command, healthcheck, any
// key not listed here), only the key names with a short keyed hash of each value. The
// hash is an HMAC keyed with powder's POWDER_ENCRYPTION_KEY and a random salt stored in
// the view, so a database copy alone cannot test guesses of a low-entropy label value
// offline. To diff, the probed config is hashed with the stored view's salt. The
// `environment` of every service is never in it (the structural config drops it).
//
// When the guard refuses because the config differs from that deploy, it prints the
// difference (composeViewDiff), so a hand edit of the compose on the server is visible
// at once instead of only the rule it happened to trip. Pure: no I/O.

import { createHmac, randomBytes } from 'node:crypto'

/** per service, per key: a scalar (string) or a sorted list of items (string[]).
 *  A hidden value is `#<hash>` (whole value) or `<name>=#<hash>` (one entry of a map). */
export interface ComposeView {
	v: 2
	/** random per view; with POWDER_ENCRYPTION_KEY it keys the value hashes */
	salt: string
	services: Record<string, Record<string, string | string[]>>
	top: Record<string, string[]>
}

/** keys whose values are printed as they are (no secret is expected there). */
const SHOWN_KEYS = new Set([
	'network_mode', 'image', 'user', 'pid', 'ipc', 'privileged', 'read_only', 'restart', 'container_name',
	'hostname', 'domainname', 'userns_mode', 'cgroup_parent', 'cgroup', 'platform', 'pull_policy', 'init',
	'stop_signal', 'stop_grace_period', 'working_dir', 'shm_size', 'mem_limit', 'memswap_limit',
	'mem_reservation', 'cpus', 'cpu_shares', 'cpuset', 'oom_score_adj', 'oom_kill_disable', 'runtime', 'tty',
	'stdin_open', 'isolation', 'mac_address', 'scale', 'pids_limit', 'cpu_count', 'cpu_percent',
	'ports', 'expose', 'volumes', 'networks', 'depends_on', 'cap_add', 'cap_drop', 'devices', 'dns',
	'dns_search', 'dns_opt', 'extra_hosts', 'security_opt', 'env_file', 'label_file', 'profiles', 'tmpfs',
	'group_add', 'links', 'external_links', 'volumes_from', 'sysctls', 'ulimits', 'secrets', 'configs',
	'device_cgroup_rules', 'storage_opt', 'blkio_config',
])

type Hasher = (v: unknown) => string

/** the keyed hash of hidden values: HMAC-SHA256 over the canonical JSON, keyed by
 *  powder's encryption key (when set) and the view's salt, cut to 12 hex. */
function hasherFor(salt: string, pepper: string): Hasher {
	const key = createHmac('sha256', `compose-view:${pepper}`).update(salt).digest()
	return (v) => `#${createHmac('sha256', key).update(JSON.stringify(canonical(v)) ?? 'undefined').digest('hex').slice(0, 12)}`
}

/** a fresh salt for a view that will be stored. */
export function newViewSalt(): string {
	return randomBytes(16).toString('hex')
}

function canonical(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(canonical)
	if (v && typeof v === 'object')
		return Object.fromEntries(
			Object.keys(v as Record<string, unknown>)
				.sort()
				.map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
		)
	return v
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** one port as compose writes it: `[host_ip:]published:target[/proto]`. */
function portItem(p: Record<string, unknown>): string {
	const target = String(p.target ?? '')
	const published = p.published !== undefined && p.published !== '' ? String(p.published) : ''
	const ip = typeof p.host_ip === 'string' && p.host_ip !== '' ? `${p.host_ip}:` : ''
	const proto = typeof p.protocol === 'string' && p.protocol !== 'tcp' ? `/${p.protocol}` : ''
	return published ? `${ip}${published}:${target}${proto}` : `${target}${proto}`
}

/** one mount: `source:target[:ro]` (`type:source:target` for a non-bind non-volume). */
function volumeItem(m: Record<string, unknown>): string {
	const ro = m.read_only === true || m.read_only === 'true' ? ':ro' : ''
	const src = typeof m.source === 'string' ? m.source : ''
	const tgt = typeof m.target === 'string' ? m.target : ''
	const t = typeof m.type === 'string' ? m.type : ''
	if (t === 'bind' || t === 'volume' || t === '') return `${src}:${tgt}${ro}`
	return `${t}:${src ? `${src}:` : ''}${tgt}${ro}`
}

function shownItems(key: string, v: unknown): string | string[] {
	if (v === null || typeof v !== 'object') return String(v)
	if (Array.isArray(v))
		return v
			.map((x) => {
				if (!isObj(x)) return String(x)
				if (key === 'ports') return portItem(x)
				if (key === 'volumes') return volumeItem(x)
				return JSON.stringify(canonical(x))
			})
			.sort()
	// maps: networks / depends_on / secrets / configs name what they join; sysctls,
	// ulimits, extra_hosts and the like are name -> value
	return Object.entries(v)
		.map(([k, x]) => {
			if (x === null || x === undefined) return k
			if (isObj(x)) return Object.keys(x).length ? `${k} ${JSON.stringify(canonical(x))}` : k
			return `${k}=${Array.isArray(x) ? x.join(',') : String(x)}`
		})
		.sort()
}

function hiddenItems(v: unknown, h: Hasher): string[] {
	if (isObj(v)) return Object.entries(v).map(([k, x]) => `${k}=${h(x)}`).sort()
	return [h(v)]
}

/** The view of a structural compose doc (the merged config with env_file paths,
 *  `environment` dropped and image tags removed, as structuralComposeHash hashes it).
 *  `salt`: a stored view's salt to diff against, else a fresh one. `pepper`: powder's
 *  encryption key (from the environment when unset). */
export function composeViewOf(
	doc: unknown,
	salt: string = newViewSalt(),
	pepper: string = process.env.POWDER_ENCRYPTION_KEY ?? '',
): ComposeView | null {
	if (!isObj(doc) || !isObj(doc.services)) return null
	const h = hasherFor(salt, pepper)
	const services: ComposeView['services'] = {}
	for (const [name, svc] of Object.entries(doc.services)) {
		const out: Record<string, string | string[]> = {}
		if (isObj(svc)) {
			for (const [k, v] of Object.entries(svc)) {
				if (k === 'environment') continue
				out[k] = SHOWN_KEYS.has(k) ? shownItems(k, v) : hiddenItems(v, h)
			}
		} else out[''] = hiddenItems(svc, h)
		services[name] = out
	}
	const top: ComposeView['top'] = {}
	for (const [k, v] of Object.entries(doc)) {
		if (k === 'services' || k === 'name') continue
		top[k] = hiddenItems(v, h)
	}
	return { v: 2, salt, services, top }
}

/** Pure: a stored view read back from the database, or null when it is not one. */
export function parseComposeView(x: unknown): ComposeView | null {
	if (!isObj(x) || x.v !== 2 || typeof x.salt !== 'string' || !/^[0-9a-f]{32}$/.test(x.salt) || !isObj(x.services) || !isObj(x.top)) return null
	for (const svc of Object.values(x.services)) {
		if (!isObj(svc)) return null
		for (const v of Object.values(svc)) if (typeof v !== 'string' && !(Array.isArray(v) && v.every((i) => typeof i === 'string'))) return null
	}
	for (const v of Object.values(x.top)) if (!Array.isArray(v) || !v.every((i) => typeof i === 'string')) return null
	return x as unknown as ComposeView
}

const HIDDEN_ENTRY = /^(.*)=#[0-9a-f]{12}$/
const HIDDEN_WHOLE = /^#[0-9a-f]{12}$/

function listDiff(path: string, before: string[], after: string[]): string[] {
	const b = new Set(before)
	const a = new Set(after)
	const allHidden = [...before, ...after].every((i) => HIDDEN_ENTRY.test(i) || HIDDEN_WHOLE.test(i))
	if (allHidden) {
		if ([...before, ...after].some((i) => HIDDEN_WHOLE.test(i))) return [`${path}: changed (value not shown)`]
		const names = (l: string[]) => new Map(l.map((i) => [i.replace(HIDDEN_ENTRY, '$1'), i]))
		const nb = names(before)
		const na = names(after)
		const added = [...na.keys()].filter((k) => !nb.has(k))
		const removed = [...nb.keys()].filter((k) => !na.has(k))
		const changed = [...na.keys()].filter((k) => nb.has(k) && nb.get(k) !== na.get(k))
		const parts = [
			added.length ? `added ${added.join(', ')}` : '',
			removed.length ? `removed ${removed.join(', ')}` : '',
			changed.length ? `changed ${changed.join(', ')} (values not shown)` : '',
		].filter(Boolean)
		return parts.length ? [`${path}: ${parts.join('; ')}`] : []
	}
	const added = after.filter((i) => !b.has(i))
	const removed = before.filter((i) => !a.has(i))
	const parts = [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : ''].filter(Boolean)
	return parts.length ? [`${path}: ${parts.join('; ')}`] : []
}

function keyDiff(path: string, before: string | string[] | undefined, after: string | string[] | undefined): string[] {
	if (JSON.stringify(before) === JSON.stringify(after)) return []
	const scalar = (x: string | string[] | undefined) => x === undefined || typeof x === 'string'
	if (scalar(before) && scalar(after)) return [`${path}: ${before ?? '(unset)'} -> ${after ?? '(unset)'}`]
	const asList = (x: string | string[] | undefined) => (x === undefined ? [] : typeof x === 'string' ? [x] : x)
	return listDiff(path, asList(before), asList(after))
}

/** the most lines the refusal prints; the rest is counted. */
export const MAX_DIFF_LINES = 30

/** Pure: one plain line per changed key, `services.<svc>.<key>: ...`. Secret-bearing
 *  keys (labels, build, command, ...) show only key names, never values. Both views
 *  must carry the same salt (hash `after` with before.salt); otherwise every hidden
 *  value would read as changed, so the hidden keys are compared by name only. */
export function composeViewDiff(before: ComposeView, after: ComposeView): string[] {
	if (before.salt !== after.salt) {
		const strip = (v: ComposeView): ComposeView => ({
			...v,
			services: Object.fromEntries(
				Object.entries(v.services).map(([s, keys]) => [
					s,
					Object.fromEntries(
						Object.entries(keys).map(([k, x]) => [k, Array.isArray(x) ? x.map((i) => i.replace(/#[0-9a-f]{12}$/, '#000000000000')) : x]),
					),
				]),
			),
			top: Object.fromEntries(Object.entries(v.top).map(([k, x]) => [k, x.map((i) => i.replace(/#[0-9a-f]{12}$/, '#000000000000'))])),
		})
		return composeViewDiff(strip(before), { ...strip(after), salt: before.salt })
	}
	const out: string[] = []
	const svcNames = [...new Set([...Object.keys(before.services), ...Object.keys(after.services)])].sort()
	for (const s of svcNames) {
		const b = before.services[s]
		const a = after.services[s]
		if (!b) {
			out.push(`services.${s}: added (new service)`)
			continue
		}
		if (!a) {
			out.push(`services.${s}: removed`)
			continue
		}
		for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) out.push(...keyDiff(`services.${s}.${k}`, b[k], a[k]))
	}
	for (const k of [...new Set([...Object.keys(before.top), ...Object.keys(after.top)])].sort())
		out.push(...listDiff(k, before.top[k] ?? [], after.top[k] ?? []))
	if (out.length > MAX_DIFF_LINES) return [...out.slice(0, MAX_DIFF_LINES), `(+${out.length - MAX_DIFF_LINES} more changes)`]
	return out
}
