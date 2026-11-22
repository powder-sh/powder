// Server bootstrap, check-first. Pure module (no db/ssh): renders the read-only
// check script, parses its output, and plans the safe additive `apply` steps.
// lib/server-bootstrap-run.ts runs it over SSH; bin/server-bootstrap.sh embeds
// the same check body and step commands (a test keeps them in sync).
//
// apply only adds what is missing: no restart/stop/rm/update of any container,
// never an existing traefik or nginx, never ufw, never an existing cron file. The
// one exception is an outdated helper, which is replaced only when its replace
// step is confirmed on its own (the dashboard leaves it unticked). Traefik is only
// started on a server whose servers.proxy is 'traefik', with no nginx installed
// or enabled and nothing listening on or bound to 80/443. Installing Docker
// (and publishing Traefik's ports) does add Docker's own iptables rules.
import { shq } from './shell'
import { SIDE_RUN_CAPS } from './side-run'
import {
	DEFAULT_TRAEFIK_NETWORK,
	type DockerNetworkInfo,
	type TraefikNetwork,
	assertDockerNetworkName,
	isDeclaredSource,
	isDockerNetworkName,
	parseDockerNetworks,
	routingNetwork,
} from './traefik-network'

export type BootstrapProxy = 'traefik' | 'nginx' | 'nginx-container'

// Pinned image for a fresh Traefik, by registry digest: the tag
// names the minor, the digest is what runs. Bump both together
// (`docker buildx imagetools inspect traefik:v3.6` prints the index digest).
export const TRAEFIK_IMAGE =
	'traefik:v3.6@sha256:31267173a15b4944e797a76ffd9c419707c8d8b32fe5b610f80cd0cfa05f372d'
export const BOOTSTRAP_NETWORKS = ['web', 'internal'] as const
// Why each piece is required (or not), in the check's own words. bin/server-bootstrap.sh
// prints the same text (server-bootstrap.test.ts holds both to it).
// The Traefik network: on Traefik servers the network Traefik routes over
// (traefik-network.ts: its flag, its config file, else the network it is attached to;
// `web`, what powder's own Traefik runs on, when none). Every app, preview, snapshot
// and rollback bridge powder starts there joins it: it must exist and Traefik must
// be attached to it. A missing `web` is then only an info line when Traefik routes
// over another network. On nginx and nginx-container servers only apps created at
// /new join `web`, and the new-app flow creates it first (app/api/apps/route.ts,
// createNetworkCommand): an info line when absent.
export const NETWORK_WEB_MISSING = 'missing: Traefik and the apps, previews and snapshots it routes run on it'
export const NETWORK_WEB_ABSENT = 'not created: powder creates it when the first app is created here at /new'
/** `web` on a Traefik server whose Traefik routes over another network. */
export function networkWebNotUsed(net: string, present: boolean): string {
	return present
		? `exists; not used for routing here: Traefik routes over ${net}`
		: `not needed: Traefik here routes over ${net}, and the apps, previews and snapshots powder starts here join ${net}`
}
/** The Traefik network (not `web`) is missing. */
export function traefikNetworkMissing(net: string): string {
	return `missing: Traefik routes over ${net}, and the apps, previews and snapshots powder starts here join it`
}
/** Traefik is attached to a network no flag or config declares: powder keeps `web`. */
export function traefikNetworkUndeclared(net: string): string {
	return `traefik is attached to ${net}; set providers.docker.network to let powder route apps over it (until then powder uses web)`
}
/** The traefik container is not attached to its routing network. */
export function traefikNotAttached(net: string): string {
	return `missing: the traefik container is not attached to ${net}, so it cannot reach what powder starts there (connect it by hand: docker network connect ${net} traefik; powder never changes an existing Traefik)`
}
// `internal`: only an app created with the opt-in "join the shared internal network"
// joins it, and the new-app flow creates it then. Optional: an info line when absent.
export const NETWORK_INTERNAL_ABSENT = 'not created: optional, only apps created with "join the shared internal network" use it, and powder creates it for the first one'
// The Traefik file provider and its folder: only domain redirects use them (powder
// writes their Traefik rules there, domain-redirects.ts applyToTraefik). Required on
// a Traefik server only while a redirect is set up there (redirectRowInUse: a www
// mode other than none, or custom redirects); otherwise an info line, since getting
// one can mean recreating the Traefik that fronts everything, for a feature not in
// use. bin/server-bootstrap.sh learns the fact from --redirects yes|no (default yes).
export const DYNAMIC_DIR_MISSING =
	'missing: domain redirects are set up on this server, and powder writes their Traefik rules here'
export const DYNAMIC_DIR_UNUSED =
	'not created: only domain redirects use it, and none is set up on this server; they stay unavailable here until Traefik has a file provider on it'
export function fileProviderMissing(dir: string): string {
	return `missing: domain redirects are set up on this server, and Traefik needs a watched file provider on ${dir} to serve them (add providers.file.directory + watch and mount it)`
}
export function fileProviderUnused(dir: string): string {
	return `not configured: domain redirects are unavailable on this server until Traefik has a watched file provider on ${dir} (add providers.file.directory + watch and mount it); nothing here uses it now`
}
const APPS_DIR = '/opt/apps'
const TRAEFIK_ACME_DIR = '/opt/infra/traefik/acme'
// Only files the daemons really load count as "handled elsewhere".
// cron: /etc/crontab always; in /etc/cron.d only names of letters, digits, `_` and `-`
// (Debian's cron(8): cron.d files "must conform to the same naming convention as used
// by run-parts(8) ... upper- and lower-case letters, digits, underscores, and hyphens.
// This means that they cannot contain any dots"), so a `name.bak` copy is not a cron
// file. logrotate: its default taboo extensions (logrotate(8), tabooext: files in an
// included directory with these endings are skipped). `.bak` is not on that list:
// logrotate does load a `.bak` file, so one counts, and so does a hidden file
// (logrotate skips only `.` and `..` there), so the scan includes dotfiles. A
// commented-out line never counts.
export const LOGROTATE_TABOO_EXTENSIONS = [
	',v', '.cfsaved', '.disabled', '.dpkg-bak', '.dpkg-del', '.dpkg-dist', '.dpkg-new', '.dpkg-old',
	'.dpkg-tmp', '.rhn-cfg-tmp-*', '.rpmnew', '.rpmorig', '.rpmsave', '.swp', '.ucf-dist', '.ucf-new',
	'.ucf-old', '~',
] as const
const LOGROTATE_TABOO_CASE = LOGROTATE_TABOO_EXTENSIONS.map((e) => `*${e}`).join(' | ')
// Written out as a literal in the grep programs below (data never becomes program
// text: shell-program-data.test.ts); server-bootstrap.test.ts holds them to this.
const TRAEFIK_LOG_DIR = '/var/log/traefik'
// Container path the file provider reads; the host dir is mounted there.
const TRAEFIK_DYNAMIC_MOUNT = '/etc/traefik/dynamic'
// Default Docker install: Docker's own apt repository (Debian, Ubuntu), its key
// trusted only after its fingerprint matches this one (docs.docker.com/engine/install).
const DOCKER_APT_BASE = 'https://download.docker.com/linux'
export const DOCKER_APT_KEY_FINGERPRINT = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88'
const DOCKER_APT_KEYRING = '/etc/apt/keyrings/docker.asc'
const DOCKER_APT_SOURCE = '/etc/apt/sources.list.d/docker.list'
// The apt install takes the newest docker-ce of this major.
export const DOCKER_MAJOR = '29'
// Opt-in only (bin/server-bootstrap.sh --docker-script): the convenience script.
const DOCKER_INSTALL_URL = 'https://get.docker.com'
// Pinned engine for the convenience script (`--version`): it installs the
// latest patch of this minor and fails if the repo does not have it.
export const DOCKER_VERSION = '29.4'
// Traefik's access log rotation, installed by bootstrap on traefik servers.
export const TRAEFIK_LOGROTATE_FILE = '/etc/logrotate.d/powder-traefik'
// copytruncate: Traefik opens access.log in append mode and keeps it open.
export const TRAEFIK_LOGROTATE_LINES = [
	`${TRAEFIK_LOG_DIR}/*.log {`,
	'  daily',
	'  maxsize 100M',
	'  rotate 7',
	'  missingok',
	'  notifempty',
	'  compress',
	'  delaycompress',
	'  copytruncate',
	'}',
] as const
export const INSPECT_MARKER = '===TRAEFIK_INSPECT==='
// The hourly prune, exactly the line infra/powder-image-prune.sh documents. Fixed
// content: nothing in it comes from the server or the operator.
export const PRUNE_CRON_FILE = '/etc/cron.d/powder-image-prune'
export const PRUNE_CRON_LINE =
	'17 * * * * root /usr/local/bin/powder-image-prune >> /var/log/powder-image-prune.log 2>&1'

/** Another logrotate file already rotates the Traefik logs: handled, left alone. */
export function logrotateElsewhere(other: string): string {
	return `/etc/logrotate.d/${other} already rotates ${TRAEFIK_LOG_DIR}; handled there, left alone (powder adds no second file)`
}
/** powder's file and another one both rotate the Traefik logs. */
export function logrotateTwice(other: string): string {
	return `${TRAEFIK_LOGROTATE_FILE} and /etc/logrotate.d/${other} both rotate ${TRAEFIK_LOG_DIR}: logrotate reports a duplicate entry and exits non-zero; remove one of them by hand`
}
/** Another cron file already runs powder-image-prune: handled, left alone. */
export function pruneCronElsewhere(other: string): string {
	return `/etc/${other} already runs powder-image-prune; handled there, left alone (powder adds no second line)`
}
/** powder's cron file and another one both run powder-image-prune. */
export function pruneCronTwice(other: string): string {
	return `${PRUNE_CRON_FILE} and /etc/${other} both run powder-image-prune; remove one of them by hand`
}

/** `printf` that writes TRAEFIK_LOGROTATE_LINES, one per line. */
function logrotatePrintf(): string {
	return `printf '%s\\n' ${TRAEFIK_LOGROTATE_LINES.map((l) => shq(l)).join(' ')}`
}

// Below these a server still works, but builds will struggle.
const MIN_DISK_FREE_BYTES = 10 * 1024 ** 3
const MIN_MEM_TOTAL_BYTES = 2 * 1024 ** 3

// systemctl is-enabled values that mean "nginx comes back on boot/restart".
const NGINX_UNIT_ENABLED = 'enabled* | static | alias | linked* | indirect'
// Values that mean it does not.
const NGINX_UNIT_OFF = 'disabled | masked | masked-runtime'

/**
 * Read-only check. `dynWord` is a shell word for the Traefik dynamic dir:
 * the runner passes shq(dir), bin/server-bootstrap.sh passes "$DYN".
 * Prints key=value lines, then INSPECT_MARKER and `docker inspect traefik`.
 */
export function renderCheckScript(dynWord: string): string {
	return [
		'have() { command -v "$1" >/dev/null 2>&1; }',
		'echo "uid=$(id -u)"',
		'os=unknown; [ -r /etc/os-release ] && os=$(. /etc/os-release && echo "${ID:-unknown}"); echo "os=$os"',
		`if have docker && docker info >/dev/null 2>&1; then echo docker=present; echo "docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null)"; elif have docker; then echo docker=unreachable; else echo docker=absent; fi`,
		'if docker compose version >/dev/null 2>&1; then echo compose=present; else echo compose=absent; fi',
		'for n in web internal; do if docker network inspect "$n" >/dev/null 2>&1; then echo "net_$n=present"; else echo "net_$n=absent"; fi; done',
		`case "$(docker inspect --type container -f '{{.State.Running}}' traefik 2>/dev/null)" in true) echo traefik=running ;; false) echo traefik=stopped ;; *) echo traefik=absent ;; esac`,
		// Every network with its internal flag, and the networks traefik is attached to:
		// what the Traefik network rule (traefik-network.ts) needs besides the inspect JSON.
		`echo "docker_networks=$(docker network ls --format '{{.Name}}:{{.Internal}}:{{.Label "com.docker.compose.project"}}' 2>/dev/null | tr '\\n' ' ')"`,
		`echo "traefik_project=$(docker inspect --type container -f '{{index .Config.Labels "com.docker.compose.project"}}' traefik 2>/dev/null)"`,
		`echo "traefik_networks=$(docker inspect --type container -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' traefik 2>/dev/null)"`,
		`if [ -d ${shq(APPS_DIR)} ]; then echo apps_dir=present; else echo apps_dir=absent; fi`,
		`if [ -d ${dynWord} ]; then echo dynamic_dir=present; else echo dynamic_dir=absent; fi`,
		'if have ufw; then case "$(ufw status 2>/dev/null | head -n1)" in *inactive*) echo ufw=inactive ;; *active*) echo ufw=active ;; *) echo ufw=unknown ;; esac; else echo ufw=absent; fi',
		// ss missing or exiting non-zero = unknown, never free.
		`if have ss && ssout=$(ss -ltn 2>/dev/null); then for p in 80 443; do if printf '%s\\n' "$ssout" | awk 'NR>1 {print $4}' | grep -Eq ":$p\\$"; then echo "port_$p=busy"; else echo "port_$p=free"; fi; done; else echo port_80=unknown; echo port_443=unknown; fi`,
		'if pgrep -x nginx >/dev/null 2>&1; then echo nginx=present; else echo nginx=absent; fi',
		'if have nginx; then echo nginx_bin=present; else echo nginx_bin=absent; fi',
		// Empty output only means "no unit" with exit 4; any other failure (no bus,
		// no permission) or an unrecognised state is unknown.
		`if have systemctl; then st=$(systemctl is-enabled nginx 2>/dev/null); rc=$?; case "$st" in ${NGINX_UNIT_ENABLED}) echo nginx_unit=enabled ;; ${NGINX_UNIT_OFF}) echo nginx_unit=disabled ;; not-found) echo nginx_unit=absent ;; "") if [ "$rc" -eq 4 ]; then echo nginx_unit=absent; else echo nginx_unit=unknown; fi ;; *) echo nginx_unit=unknown ;; esac; else echo nginx_unit=unknown; fi`,
		// Every container, running or stopped: a 80/443 host binding, or a proxy image.
		`if ! have docker; then echo port_bindings=none; echo proxy_containers=absent; elif ids=$(docker ps -aq 2>/dev/null); then if [ -z "$ids" ]; then echo port_bindings=none; echo proxy_containers=absent; elif ins=$(docker inspect --format '{{json .HostConfig.PortBindings}} {{.Config.Image}}' $ids 2>/dev/null); then if printf '%s\\n' "$ins" | grep -Eq '"HostPort":"(80|443)"'; then echo port_bindings=bound; else echo port_bindings=none; fi; if printf '%s\\n' "$ins" | awk '{print $NF}' | grep -Eiq '(nginx|traefik|caddy|haproxy|envoy)'; then echo proxy_containers=present; else echo proxy_containers=absent; fi; else echo port_bindings=unknown; echo proxy_containers=unknown; fi; else echo port_bindings=unknown; echo proxy_containers=unknown; fi`,
		`echo "disk_free_kb=$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}')"`,
		`awk '/^MemTotal:/ {print "mem_total_kb=" $2} /^MemAvailable:/ {print "mem_avail_kb=" $2}' /proc/meminfo 2>/dev/null`,
		// Per-server helpers at fixed paths (PER_SERVER_HELPERS), with the sha256 of each
		// installed copy so an outdated one can be told from the one powder ships.
		`for h in migrate image-prune resource-guard; do k=$(printf '%s' "$h" | tr - _); if [ -x "/usr/local/bin/powder-$h" ]; then echo "helper_$k=present"; else echo "helper_$k=absent"; fi; echo "helper_\${k}_sha=$(sha256sum "/usr/local/bin/powder-$h" 2>/dev/null | cut -c1-64)"; done`,
		// Deploys clone and pull with git and take the per-app lock with flock.
		'for c in git flock; do if have "$c"; then echo "cmd_$c=present"; else echo "cmd_$c=absent"; fi; done',
		// The prune's cron file: absent, powder's exact line, or something else (left alone).
		// Another cron file that already runs powder-image-prune (not a comment line).
		`o=; for f in /etc/crontab /etc/cron.d/*; do [ "$f" = ${shq(PRUNE_CRON_FILE)} ] && continue; case "$f" in /etc/cron.d/*) case "\${f##*/}" in *[!A-Za-z0-9_-]*) continue ;; esac ;; esac; if [ -f "$f" ] && grep -Eqs '^[^#]*powder-image-prune' "$f"; then o=\${f#/etc/}; break; fi; done; echo "prune_cron_other=$o"`,
		`if [ ! -d /etc/cron.d ]; then echo prune_cron=no-crond; elif [ ! -e ${shq(PRUNE_CRON_FILE)} ] && [ ! -L ${shq(PRUNE_CRON_FILE)} ]; then echo prune_cron=absent; elif [ "$(cat ${shq(PRUNE_CRON_FILE)} 2>/dev/null)" = ${shq(PRUNE_CRON_LINE)} ]; then echo prune_cron=current; else echo prune_cron=different; fi`,
		// Traefik's access log rotation: absent, powder's exact file, or something else (left alone).
		`if [ ! -d /etc/logrotate.d ]; then echo traefik_logrotate=no-logrotate; elif [ ! -e ${shq(TRAEFIK_LOGROTATE_FILE)} ] && [ ! -L ${shq(TRAEFIK_LOGROTATE_FILE)} ]; then echo traefik_logrotate=absent; elif [ "$(cat ${shq(TRAEFIK_LOGROTATE_FILE)} 2>/dev/null)" = "$(${logrotatePrintf()})" ]; then echo traefik_logrotate=current; else echo traefik_logrotate=different; fi`,
		// Another file under /etc/logrotate.d that already rotates the Traefik logs (by
		// the path it names, not by its file name; not a comment line).
		`o=; if [ -d /etc/logrotate.d ]; then for f in /etc/logrotate.d/* /etc/logrotate.d/.[!.]* /etc/logrotate.d/..?*; do [ "$f" = ${shq(TRAEFIK_LOGROTATE_FILE)} ] && continue; case "\${f##*/}" in ${LOGROTATE_TABOO_CASE}) continue ;; esac; if [ -f "$f" ] && grep -Eqs '^[^#]*/var/log/traefik' "$f"; then o=\${f##*/}; break; fi; done; fi; echo "traefik_logrotate_other=$o"`,
		`echo ${shq(INSPECT_MARKER)}`,
		'docker inspect --type container traefik 2>/dev/null || true',
	].join('\n')
}

type Presence = 'present' | 'absent'

export interface BootstrapFacts {
	root: boolean
	os: string
	docker: 'present' | 'absent' | 'unreachable'
	dockerVersion: string | null
	compose: Presence
	networks: { web: Presence; internal: Presence }
	traefik: 'running' | 'stopped' | 'absent'
	// Filled by the caller from the inspect JSON (checkFileProviderFromInspect).
	traefikFileProvider: 'ok' | 'missing' | 'n/a'
	// Filled by the caller (traefikNetworkFrom): the network Traefik routes over.
	// Absent = `web`, attachment unknown.
	traefikNetwork?: TraefikNetwork
	// Every docker network with its internal flag (null = not reported).
	dockerNetworks?: DockerNetworkInfo[] | null
	// Networks the traefik container is attached to (null = no container or not reported).
	traefikAttached?: string[] | null
	// The traefik container's compose project label (null = none or not reported).
	traefikProject?: string | null
	appsDir: Presence
	dynamicDir: Presence
	ufw: 'active' | 'inactive' | 'absent' | 'unknown'
	port80: 'busy' | 'free' | 'unknown'
	port443: 'busy' | 'free' | 'unknown'
	// nginx process running / binary on PATH / systemd unit state.
	nginx: Presence
	nginxBinary: Presence
	nginxUnit: 'enabled' | 'disabled' | 'absent' | 'unknown'
	// Any container, running or stopped, with a 80/443 host port binding.
	portBindings: 'bound' | 'none' | 'unknown'
	// Any container, running or stopped, from an nginx/traefik/caddy/haproxy/envoy image.
	proxyContainers: 'present' | 'absent' | 'unknown'
	diskFreeBytes: number | null
	memTotalBytes: number | null
	memAvailBytes: number | null
	// /usr/local/bin/powder-<name> executable on the server (PER_SERVER_HELPERS).
	helpers?: { migrate: Presence; imagePrune: Presence; resourceGuard: Presence }
	// sha256 of each installed helper (null: absent or unreadable).
	helperShas?: Partial<Record<HelperKey, string | null>>
	// Commands every deploy runs on the server.
	tools?: { git: Presence; flock: Presence }
	// /etc/cron.d/powder-image-prune: absent, PRUNE_CRON_LINE exactly, other
	// content, or no /etc/cron.d on the server.
	pruneCron?: 'current' | 'different' | 'absent' | 'no-crond'
	// TRAEFIK_LOGROTATE_FILE: absent, powder's content exactly, other content, or
	// no /etc/logrotate.d on the server.
	traefikLogrotate?: 'current' | 'different' | 'absent' | 'no-logrotate'
	// Another /etc/logrotate.d file that rotates /var/log/traefik (its name), or null.
	traefikLogrotateOther?: string | null
	// Another cron file (/etc/crontab, /etc/cron.d/x) that runs powder-image-prune, or null.
	pruneCronOther?: string | null
}

export type HelperKey = 'migrate' | 'imagePrune' | 'resourceGuard'

/** sha256 of the helpers this powder ships (lib/server-helpers.ts reads them from
 *  the image); a key without a value is not shipped or not readable. */
export type ShippedHelperShas = Partial<Record<HelperKey, string>>

/** Helper scripts from the repo's infra/ dir at fixed paths on an app server
 *  (docs: /docs/self-hosting#per-server-helpers). `installed`: "fix missing pieces"
 *  installs it from the copy in the powder image; the resource guard is optional
 *  and only ever installed by hand. */
export const PER_SERVER_HELPERS = [
	{ key: 'migrate', bin: 'powder-migrate', src: 'powder-migrate', installed: true, why: 'without it the per-app SQL migrations are skipped on deploy' },
	{ key: 'imagePrune', bin: 'powder-image-prune', src: 'powder-image-prune.sh', installed: true, why: 'without it old images and build cache fill the disk' },
	{ key: 'resourceGuard', bin: 'powder-resource-guard', src: 'powder-resource-guard.sh', installed: false, why: 'caps app containers that have no memory limit at the /opt/apps/.mem-cap size, 2g without the file, and keeps the OOM killer off powder and its database' },
] as const satisfies ReadonlyArray<{ key: HelperKey; bin: string; src: string; installed: boolean; why: string }>

export const HELPER_BIN_DIR = '/usr/local/bin'
const SHA256 = /^[0-9a-f]{64}$/

/** absent / outdated (installed copy differs from the shipped one) / current
 *  (matches, or nothing shipped to compare with). Pure. */
export function helperState(f: BootstrapFacts, key: HelperKey, shipped: ShippedHelperShas): 'absent' | 'outdated' | 'current' {
	if (f.helpers?.[key] !== 'present') return 'absent'
	const want = shipped[key]
	const have = f.helperShas?.[key]
	return want && have && want !== have ? 'outdated' : 'current'
}

/** Splits the check output into the key=value map and the inspect JSON text. */
export function parseCheckOutput(stdout: string): {
	facts: Omit<BootstrapFacts, 'traefikFileProvider' | 'traefikNetwork'>
	inspectJson: string
} {
	const idx = stdout.indexOf(INSPECT_MARKER)
	const head = idx >= 0 ? stdout.slice(0, idx) : stdout
	const inspectJson = idx >= 0 ? stdout.slice(idx + INSPECT_MARKER.length).trim() : ''
	const kv = new Map<string, string>()
	for (const line of head.split('\n')) {
		const m = /^([a-z0-9_]+)=(.*)$/.exec(line.trim())
		if (m?.[1] !== undefined) kv.set(m[1], (m[2] ?? '').trim())
	}
	// Missing or unexpected values fall back to the cautious side.
	const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
		const v = kv.get(key)
		return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
	}
	const presence = (key: string): Presence => pick(key, ['present', 'absent'], 'absent')
	const sha = (key: string): string | null => {
		const v = kv.get(key) ?? ''
		return SHA256.test(v) ? v : null
	}
	// A file name reported by the server: shown in the check, so a plain name only.
	const fileName = (key: string): string | null => {
		const v = kv.get(key) ?? ''
		// a leading dot too: logrotate loads hidden files
		return /^[A-Za-z0-9.][A-Za-z0-9._@+/-]{0,127}$/.test(v) && !v.includes('..') ? v : null
	}
	const kb = (key: string): number | null => {
		const n = Number(kv.get(key))
		return kv.get(key) && Number.isFinite(n) && n >= 0 ? n * 1024 : null
	}
	return {
		facts: {
			root: kv.get('uid') === '0',
			os: kv.get('os') || 'unknown',
			docker: pick('docker', ['present', 'absent', 'unreachable'], 'absent'),
			dockerVersion: kv.get('docker_version') || null,
			compose: presence('compose'),
			networks: { web: presence('net_web'), internal: presence('net_internal') },
			traefik: pick('traefik', ['running', 'stopped', 'absent'], 'absent'),
			...(kv.has('docker_networks') ? { dockerNetworks: parseDockerNetworks(kv.get('docker_networks') ?? '') } : {}),
			...(kv.has('traefik_project')
				? { traefikProject: /^[a-z0-9][a-z0-9_-]{0,127}$/.test(kv.get('traefik_project') ?? '') ? (kv.get('traefik_project') ?? null) : null }
				: {}),
			...(kv.has('traefik_networks')
				? { traefikAttached: (kv.get('traefik_networks') ?? '').split(/\s+/).filter(isDockerNetworkName) }
				: {}),
			appsDir: presence('apps_dir'),
			dynamicDir: presence('dynamic_dir'),
			ufw: pick('ufw', ['active', 'inactive', 'absent', 'unknown'], 'unknown'),
			port80: pick('port_80', ['busy', 'free', 'unknown'], 'unknown'),
			port443: pick('port_443', ['busy', 'free', 'unknown'], 'unknown'),
			nginx: pick('nginx', ['present', 'absent'], 'present'),
			nginxBinary: pick('nginx_bin', ['present', 'absent'], 'present'),
			nginxUnit: pick('nginx_unit', ['enabled', 'disabled', 'absent', 'unknown'], 'unknown'),
			portBindings: pick('port_bindings', ['bound', 'none', 'unknown'], 'unknown'),
			proxyContainers: pick('proxy_containers', ['present', 'absent', 'unknown'], 'unknown'),
			diskFreeBytes: kb('disk_free_kb'),
			memTotalBytes: kb('mem_total_kb'),
			memAvailBytes: kb('mem_avail_kb'),
			helpers: {
				migrate: presence('helper_migrate'),
				imagePrune: presence('helper_image_prune'),
				resourceGuard: presence('helper_resource_guard'),
			},
			helperShas: {
				migrate: sha('helper_migrate_sha'),
				imagePrune: sha('helper_image_prune_sha'),
				resourceGuard: sha('helper_resource_guard_sha'),
			},
			tools: { git: presence('cmd_git'), flock: presence('cmd_flock') },
			// Unknown output counts as "different": never written over.
			...(kv.has('prune_cron')
				? { pruneCron: pick('prune_cron', ['current', 'different', 'absent', 'no-crond'] as const, 'different') }
				: {}),
			...(kv.has('prune_cron_other') ? { pruneCronOther: fileName('prune_cron_other') } : {}),
			...(kv.has('traefik_logrotate_other') ? { traefikLogrotateOther: fileName('traefik_logrotate_other') } : {}),
			...(kv.has('traefik_logrotate')
				? {
						traefikLogrotate: pick(
							'traefik_logrotate',
							['current', 'different', 'absent', 'no-logrotate'] as const,
							'different',
						),
					}
				: {}),
		},
		inspectJson,
	}
}

export type CheckState = 'ok' | 'missing' | 'warn' | 'info'

export interface CheckItem {
	id: string
	label: string
	state: CheckState
	detail: string
}

function gb(n: number): string {
	return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** The Traefik network the facts carry, else `web` (attachment unknown). */
export function traefikNetworkOf(f: Pick<BootstrapFacts, 'traefikNetwork' | 'traefikAttached'>): TraefikNetwork {
	return (
		f.traefikNetwork ?? {
			name: DEFAULT_TRAEFIK_NETWORK,
			source: 'default',
			attached: f.traefikAttached ?? null,
			why: 'powder uses web',
		}
	)
}

/** Does the network exist on the server? `web` and `internal` from their own check
 *  lines, any other from the network list. */
export function networkPresent(f: Pick<BootstrapFacts, 'networks' | 'dockerNetworks'>, name: string): boolean {
	if (name === 'web' || name === 'internal') return f.networks[name] === 'present'
	return !!f.dockerNetworks?.some((n) => n.name === name)
}

/**
 * Human checklist. 'missing' items fail the check; 'warn'/'info' do not.
 * Traefik pieces are only required when the server's proxy is 'traefik'; on
 * nginx and nginx-container servers they are info, and so is the `web` network
 * (NETWORK_WEB_ABSENT). On Traefik servers the network Traefik routes over
 * (traefikNetworkOf) must exist and Traefik must be attached to it; `web` is an info
 * line when that is another network. The file provider and its folder are required
 * only when `redirectsInUse` (a domain redirect is set up on this server; default
 * true, the cautious side). The `internal` network is optional on every proxy.
 */
export function checkItems(
	f: BootstrapFacts,
	dynamicDir: string,
	proxy: BootstrapProxy,
	shipped: ShippedHelperShas = {},
	redirectsInUse = true,
): CheckItem[] {
	const traefikServer = proxy === 'traefik'
	const need = (ok: boolean): CheckState => (ok ? 'ok' : traefikServer ? 'missing' : 'info')
	// the file provider pieces: required only while a redirect needs them
	const needRedirects = (ok: boolean): CheckState => (ok ? 'ok' : traefikServer && redirectsInUse ? 'missing' : 'info')
	const tnet = traefikNetworkOf(f)
	// what powder routes over: the declared network (flag or config), else web
	const route = routingNetwork(tnet)
	const items: CheckItem[] = []
	items.push({
		id: 'docker',
		label: 'Docker engine',
		state: f.docker === 'present' ? 'ok' : 'missing',
		detail:
			f.docker === 'present'
				? `version ${f.dockerVersion ?? 'unknown'}`
				: f.docker === 'unreachable'
					? 'docker is installed but the daemon is not reachable for this user'
					: 'not installed',
	})
	items.push({
		id: 'compose',
		label: 'docker compose plugin',
		state: f.compose === 'present' ? 'ok' : 'missing',
		detail: f.compose === 'present' ? 'installed' : 'not installed',
	})
	if (traefikServer) {
		const present = networkPresent(f, route)
		items.push({
			id: 'traefik-network',
			label: `network ${route}`,
			state: present ? 'ok' : 'missing',
			detail: present
				? isDeclaredSource(tnet.source)
					? `exists; Traefik routes over it (${tnet.why})`
					: 'exists'
				: route === DEFAULT_TRAEFIK_NETWORK
					? NETWORK_WEB_MISSING
					: traefikNetworkMissing(route),
		})
		if (route !== DEFAULT_TRAEFIK_NETWORK) {
			items.push({
				id: 'network-web',
				label: 'network web',
				state: 'info',
				detail: networkWebNotUsed(route, f.networks.web === 'present'),
			})
		}
		// attached to a network nobody declared: reported, never used
		if (tnet.source === 'attached' && tnet.name !== DEFAULT_TRAEFIK_NETWORK) {
			items.push({
				id: 'traefik-network-undeclared',
				label: 'traefik networks',
				state: 'info',
				detail: traefikNetworkUndeclared(tnet.name),
			})
		}
	} else {
		items.push({
			id: 'network-web',
			label: 'network web',
			state: f.networks.web === 'present' ? 'ok' : 'info',
			detail: f.networks.web === 'present' ? 'exists' : NETWORK_WEB_ABSENT,
		})
	}
	items.push({
		id: 'network-internal',
		label: 'network internal',
		state: f.networks.internal === 'present' ? 'ok' : 'info',
		detail: f.networks.internal === 'present' ? 'exists' : NETWORK_INTERNAL_ABSENT,
	})
	items.push({
		id: 'traefik',
		label: 'traefik container',
		state: need(f.traefik === 'running'),
		detail:
			f.traefik === 'running'
				? 'running'
				: f.traefik === 'stopped'
					? 'exists but is stopped (powder does not start or change it)'
					: traefikServer
						? 'no container named traefik'
						: `not used: this server routes with ${proxy}`,
	})
	if (f.traefik !== 'absent' && traefikServer) {
		const attached = tnet.attached ?? f.traefikAttached ?? null
		items.push({
			id: 'traefik-attached',
			label: `traefik on ${route}`,
			state: attached === null ? 'info' : attached.includes(route) ? 'ok' : 'missing',
			detail:
				attached === null
					? 'could not read the networks of the traefik container'
					: attached.includes(route)
						? 'attached'
						: traefikNotAttached(route),
		})
	}
	if (f.traefik !== 'absent') {
		items.push({
			id: 'traefik-file-provider',
			label: 'traefik file provider',
			state: needRedirects(f.traefikFileProvider === 'ok'),
			detail:
				f.traefikFileProvider === 'ok'
					? `watches ${dynamicDir}`
					: !traefikServer
						? `no watched file provider on ${dynamicDir} (add providers.file.directory + watch and mount it)`
						: redirectsInUse
							? fileProviderMissing(dynamicDir)
							: fileProviderUnused(dynamicDir),
		})
	}
	items.push({
		id: 'apps-dir',
		label: APPS_DIR,
		state: f.appsDir === 'present' ? 'ok' : 'missing',
		detail: f.appsDir === 'present' ? 'exists' : 'missing',
	})
	items.push({
		id: 'dynamic-dir',
		label: dynamicDir,
		state: needRedirects(f.dynamicDir === 'present'),
		detail:
			f.dynamicDir === 'present'
				? 'exists'
				: !traefikServer
					? `not used with ${proxy}`
					: redirectsInUse
						? DYNAMIC_DIR_MISSING
						: DYNAMIC_DIR_UNUSED,
	})
	items.push({
		id: 'ufw',
		label: 'firewall (ufw)',
		state: 'info',
		detail:
			f.ufw === 'active'
				? 'active: make sure 80 and 443 are allowed (powder never runs ufw; ports Docker publishes bypass it)'
				: f.ufw === 'inactive'
					? 'installed, inactive'
					: f.ufw === 'absent'
						? 'not installed'
						: 'state unknown (needs root)',
	})
	items.push({
		id: 'disk',
		label: 'free disk on /',
		state:
			f.diskFreeBytes === null ? 'info' : f.diskFreeBytes < MIN_DISK_FREE_BYTES ? 'warn' : 'ok',
		detail: f.diskFreeBytes === null ? 'unknown' : gb(f.diskFreeBytes),
	})
	items.push({
		id: 'memory',
		label: 'memory',
		state:
			f.memTotalBytes === null ? 'info' : f.memTotalBytes < MIN_MEM_TOTAL_BYTES ? 'warn' : 'ok',
		detail:
			f.memTotalBytes === null
				? 'unknown'
				: `${gb(f.memAvailBytes ?? 0)} free of ${gb(f.memTotalBytes)}`,
	})
	if (f.tools) {
		const why = { git: 'deploys clone and pull app repos', flock: 'util-linux: the per-app deploy lock' } as const
		const absent = (['git', 'flock'] as const).filter((c) => f.tools?.[c] !== 'present')
		items.push({
			id: 'tools',
			label: 'git and flock',
			state: absent.length ? 'missing' : 'ok',
			detail: absent.length
				? `not installed: ${absent.map((c) => `${c} (${why[c]})`).join('; ')}. install with the distro's package manager (git, util-linux)`
				: 'installed',
		})
	}
	if (f.helpers) {
		const notes: string[] = []
		let warn = false
		const installed = PER_SERVER_HELPERS.filter((h) => h.installed)
		for (const h of installed) {
			const st = helperState(f, h.key, shipped)
			if (st === 'current') continue
			warn = true
			notes.push(
				st === 'outdated'
					? `${h.bin} outdated: differs from the copy in this powder (fix missing pieces replaces it only when you tick it)`
					: `${h.bin} not installed (${h.why}; fix missing pieces installs it)`,
			)
		}
		items.push({
			id: 'helpers',
			label: 'per-server helpers',
			// warn, not missing: a server without them still deploys.
			state: warn ? 'warn' : 'ok',
			detail: notes.length
				? `${notes.join('; ')}. /docs/self-hosting#per-server-helpers`
				: installed.map((h) => h.bin).join(', '),
		})
		// Optional and installed by hand: info either way, never compared or installed.
		const guard = PER_SERVER_HELPERS.find((h) => h.key === 'resourceGuard')
		items.push({
			id: 'resource-guard',
			label: 'powder-resource-guard',
			state: 'info',
			detail:
				f.helpers.resourceGuard === 'present'
					? 'installed (optional; not checked for updates)'
					: `optional, not installed: ${guard?.why ?? ''}. install by hand, /docs/self-hosting#per-server-helpers`,
		})
	}
	if (f.pruneCron) {
		const other = f.pruneCronOther ?? null
		const ownFile = f.pruneCron === 'current' || f.pruneCron === 'different'
		items.push({
			id: 'image-prune-cron',
			label: 'image prune cron',
			state:
				other && ownFile
					? 'warn'
					: other || f.pruneCron === 'current'
						? 'ok'
						: f.pruneCron === 'different'
							? 'info'
							: 'warn',
			detail:
				other && ownFile
					? pruneCronTwice(other)
					: other
						? pruneCronElsewhere(other)
						: f.pruneCron === 'current'
							? `${PRUNE_CRON_FILE}: hourly at :17`
							: f.pruneCron === 'different'
								? `${PRUNE_CRON_FILE} has other content; left as is. powder's line: ${PRUNE_CRON_LINE}`
								: f.pruneCron === 'absent'
									? `${PRUNE_CRON_FILE} missing: powder-image-prune never runs (fix missing pieces adds it)`
									: `no /etc/cron.d on this server: add this line to /etc/crontab by hand: ${PRUNE_CRON_LINE}`,
		})
	}
	if (f.traefikLogrotate && traefikServer) {
		const other = f.traefikLogrotateOther ?? null
		const ownFile = f.traefikLogrotate === 'current' || f.traefikLogrotate === 'different'
		items.push({
			id: 'traefik-logrotate',
			label: 'traefik access log rotation',
			state:
				other && ownFile
					? 'warn'
					: other || f.traefikLogrotate === 'current'
						? 'ok'
						: f.traefikLogrotate === 'different'
							? 'info'
							: 'warn',
			detail:
				other && ownFile
					? logrotateTwice(other)
					: other
						? logrotateElsewhere(other)
						: f.traefikLogrotate === 'current'
							? `${TRAEFIK_LOGROTATE_FILE}: daily, 7 kept, 100 MB cap`
							: f.traefikLogrotate === 'different'
								? `${TRAEFIK_LOGROTATE_FILE} has other content; left as is`
								: f.traefikLogrotate === 'absent'
									? `${TRAEFIK_LOGROTATE_FILE} missing: ${TRAEFIK_LOG_DIR}/access.log grows without bound (fix missing pieces adds it)`
									: `no /etc/logrotate.d on this server: ${TRAEFIK_LOG_DIR}/access.log is not rotated (install logrotate)`,
		})
	}
	return items
}

export function isCheckGreen(items: CheckItem[]): boolean {
	return items.every((i) => i.state !== 'missing')
}

/** The required pieces a check names as missing (its 'missing' items): what
 *  servers.check_missing stores and the setup checklist names. */
export function missingPieces(items: readonly CheckItem[]): Array<Pick<CheckItem, 'id' | 'label' | 'detail'>> {
	return items.filter((i) => i.state === 'missing').map(({ id, label, detail }) => ({ id, label, detail }))
}

export type StepId =
	| 'install-docker'
	| 'network-web'
	| 'network-internal'
	| 'network-traefik'
	| 'mkdir-apps'
	| 'mkdir-dynamic'
	| 'start-traefik'
	| 'install-powder-migrate'
	| 'install-powder-image-prune'
	| 'replace-powder-migrate'
	| 'replace-powder-image-prune'
	| 'install-image-prune-cron'
	| 'install-traefik-logrotate'

export interface BootstrapStep {
	id: StepId
	title: string
	command: string
	/** overwrites a file that exists (an outdated helper): opt-in, never run unless
	 *  this id is confirmed on its own */
	replaces?: boolean
	/** a helper install: the runner uploads the image's copy of this helper over
	 *  SFTP to a temp file "$T" first, then runs `command` */
	helper?: HelperKey
}

export interface BootstrapPlan {
	steps: BootstrapStep[]
	skipped: Array<{ id: string; reason: string }>
}

/** The step ids "run these" sends: every add, and a replace step only when its
 *  checkbox was ticked. Pure; the server page uses it. */
export function confirmedStepIds(steps: readonly BootstrapStep[], ticked: readonly string[]): StepId[] {
	return steps.filter((s) => !s.replaces || ticked.includes(s.id)).map((s) => s.id)
}

/** The default Docker install: Docker's apt repository on Debian and Ubuntu, any
 *  other distro refused with a pointer to installing it by hand. The repository key
 *  is downloaded to a fresh mktemp dir and only installed to DOCKER_APT_KEYRING
 *  (the source's signed-by) when it holds exactly one primary key and that key's
 *  fingerprint is DOCKER_APT_KEY_FINGERPRINT. Installs the newest docker-ce of
 *  DOCKER_MAJOR with the compose and buildx plugins. When apt-get update or the
 *  version lookup fails once the repository is added, the source (and the key, when
 *  this step wrote it) is removed again, so the server's apt is not left broken. Pure; bin/server-bootstrap.sh
 *  runs the same lines. */
export function installDockerCommand(): string {
	const fpr = DOCKER_APT_KEY_FINGERPRINT
	const apt = 'DEBIAN_FRONTEND=noninteractive apt-get'
	return [
		"if command -v docker >/dev/null 2>&1; then echo 'docker already installed, skipping'; exit 0; fi",
		'OS_ID=$(. /etc/os-release 2>/dev/null && echo "${ID:-}"); OS_CODENAME=$(. /etc/os-release 2>/dev/null && echo "${VERSION_CODENAME:-}")',
		`case "$OS_ID" in debian | ubuntu) ;; *) echo "Docker's apt repository is set up here on Debian and Ubuntu only (this server: \${OS_ID:-unknown}). Install Docker Engine and the compose plugin yourself (docs.docker.com/engine/install), or use bin/server-bootstrap.sh --docker-script"; exit 1 ;; esac`,
		`case "$OS_CODENAME" in '' | *[!a-z0-9]*) echo 'could not read VERSION_CODENAME from /etc/os-release'; exit 1 ;; esac`,
		`${apt} update -q && ${apt} install -y -q ca-certificates curl gnupg || { echo 'could not install ca-certificates, curl and gnupg'; exit 1; }`,
		`KD=$(mktemp -d /tmp/powder-docker-key.XXXXXX) || exit 1; trap 'rm -rf "$KD"' EXIT`,
		`curl -fsSL "${DOCKER_APT_BASE}/$OS_ID/gpg" -o "$KD/docker.asc" || { echo 'could not download the Docker repository key'; exit 1; }`,
		`FPR=$(GNUPGHOME="$KD" gpg --batch --show-keys --with-colons "$KD/docker.asc" 2>/dev/null | awk -F: '$1 == "pub" {p = 1; next} $1 == "fpr" && p {print $10; p = 0}')`,
		`if [ "$FPR" != '${fpr}' ]; then echo "the downloaded Docker repository key is not ${fpr} (got: \${FPR:-no key}), not trusting it"; exit 1; fi`,
		`echo 'Docker repository key fingerprint ${fpr} matches'`,
		`KN=0; [ -e ${DOCKER_APT_KEYRING} ] || KN=1`,
		`undo_repo() { rm -f ${DOCKER_APT_SOURCE}; if [ "$KN" = 1 ]; then rm -f ${DOCKER_APT_KEYRING}; fi; echo 'removed ${DOCKER_APT_SOURCE} again, so apt keeps working'; }`,
		`install -d -m 0755 /etc/apt/keyrings && install -m 0644 "$KD/docker.asc" ${DOCKER_APT_KEYRING} || { echo 'could not install the key'; exit 1; }`,
		`printf 'deb [arch=%s signed-by=${DOCKER_APT_KEYRING}] ${DOCKER_APT_BASE}/%s %s stable\\n' "$(dpkg --print-architecture)" "$OS_ID" "$OS_CODENAME" > ${DOCKER_APT_SOURCE} || { echo 'could not write ${DOCKER_APT_SOURCE}'; undo_repo; exit 1; }`,
		`${apt} update -q || { echo 'apt-get update failed with the Docker repository'; undo_repo; exit 1; }`,
		`DV=$(apt-cache madison docker-ce | awk -v m=${DOCKER_MAJOR} '{ v = $3; sub(/^[0-9]+:/, "", v); split(v, b, "."); if (b[1] == m) { print $3; exit } }')`,
		`if [ -z "$DV" ]; then echo 'no Docker ${DOCKER_MAJOR}.x in the Docker repository for this release'; undo_repo; exit 1; fi`,
		`echo "installing docker-ce $DV"`,
		`${apt} install -y -q "docker-ce=$DV" "docker-ce-cli=$DV" containerd.io docker-buildx-plugin docker-compose-plugin`,
	].join('\n')
}

/** Opt-in only (bin/server-bootstrap.sh --docker-script; the dashboard never runs
 *  it). Docker's convenience script changes upstream without a version, so no
 *  checksum can be pinned here. The step prints the sha256 of what it downloaded
 *  and, when POWDER_GET_DOCKER_SHA256 is set in the shell that runs it, refuses a
 *  different script. The script lands in a fresh mktemp file (random name, O_EXCL),
 *  never a fixed /tmp path another local user could plant a link at. */
export function installDockerScriptCommand(): string {
	return `if command -v docker >/dev/null 2>&1; then echo 'docker already installed, skipping'; exit 0; fi; GD=$(mktemp /tmp/powder-get-docker.XXXXXX) && trap 'rm -f "$GD"' EXIT && curl -fsSL ${DOCKER_INSTALL_URL} -o "$GD" && GD_SUM=$(sha256sum "$GD" | cut -c1-64) && echo "get.docker.com script sha256: $GD_SUM" && if [ -n "\${POWDER_GET_DOCKER_SHA256:-}" ] && [ "$GD_SUM" != "\${POWDER_GET_DOCKER_SHA256:-}" ]; then echo 'the script does not match POWDER_GET_DOCKER_SHA256, not running it'; exit 1; fi && sh "$GD" --version ${DOCKER_VERSION}`
}

/** Writes TRAEFIK_LOGROTATE_FILE (root:root 0644) via a temp file in /etc (outside
 *  the dir logrotate reads) and mv. A file that exists is left alone, and so is the
 *  step when another /etc/logrotate.d file already names the log dir (two stanzas
 *  for one log make logrotate fail). Pure;
 *  bin/server-bootstrap.sh runs the same lines. */
export function installTraefikLogrotateCommand(): string {
	const dest = shq(TRAEFIK_LOGROTATE_FILE)
	return [
		`if [ ! -d /etc/logrotate.d ]; then echo 'no /etc/logrotate.d on this server (install logrotate); ${TRAEFIK_LOG_DIR}/access.log is not rotated'; exit 1; fi`,
		`if [ -e ${dest} ] || [ -L ${dest} ]; then echo '${TRAEFIK_LOGROTATE_FILE} exists, left as is'; exit 0; fi`,
		`for f in /etc/logrotate.d/* /etc/logrotate.d/.[!.]* /etc/logrotate.d/..?*; do case "\${f##*/}" in ${LOGROTATE_TABOO_CASE}) continue ;; esac; if [ -f "$f" ] && grep -Eqs '^[^#]*/var/log/traefik' "$f"; then echo "$f already rotates ${TRAEFIK_LOG_DIR}, no second file written"; exit 0; fi; done`,
		`C=$(mktemp /etc/.powder-traefik-logrotate.XXXXXX) || { echo 'could not create a temp file in /etc'; exit 1; }`,
		`${logrotatePrintf()} > "$C" && chown root:root "$C" && chmod 0644 "$C" && mv -f "$C" ${dest} || { rm -f "$C"; echo 'install failed'; exit 1; }`,
		`echo 'installed ${TRAEFIK_LOGROTATE_FILE}'`,
	].join('\n')
}

/** Shell, after the helper's content was written to the temp file "$T" (same dir
 *  as the destination) and "$S" holds its expected sha256: verify the upload,
 *  refuse a directory at the destination, then root-owned 0755 and an atomic mv.
 *  Pure; bin/server-bootstrap.sh runs the same lines. */
export function installHelperCommand(bin: string): string {
	const dest = shq(`${HELPER_BIN_DIR}/${bin}`)
	return [
		`if [ "$(sha256sum "$T" | cut -c1-64)" != "$S" ]; then rm -f "$T"; echo 'the uploaded copy does not match, nothing installed'; exit 1; fi`,
		`if [ -d ${dest} ]; then rm -f "$T"; echo '${HELPER_BIN_DIR}/${bin} is a directory, not touching it'; exit 1; fi`,
		`chown root:root "$T" && chmod 0755 "$T" && mv -f "$T" ${dest} || { rm -f "$T"; echo 'install failed'; exit 1; }`,
		`echo "installed ${HELPER_BIN_DIR}/${bin} (sha256 $S)"`,
	].join('\n')
}

/** Writes PRUNE_CRON_FILE with PRUNE_CRON_LINE, root:root 0644, via a temp file
 *  (a dot name cron ignores) and mv. Re-checks at run time: a file that appeared
 *  since the check is left alone, and no line is written when /etc/crontab or another
 *  /etc/cron.d file already runs powder-image-prune. Pure; bin/server-bootstrap.sh runs the same lines. */
export function installPruneCronCommand(): string {
	const dest = shq(PRUNE_CRON_FILE)
	return [
		`if [ ! -d /etc/cron.d ]; then echo ${shq(`no /etc/cron.d on this server; add this line to /etc/crontab by hand: ${PRUNE_CRON_LINE}`)}; exit 1; fi`,
		`if [ -e ${dest} ] || [ -L ${dest} ]; then echo '${PRUNE_CRON_FILE} exists, left as is'; exit 0; fi`,
		`for f in /etc/crontab /etc/cron.d/*; do case "$f" in /etc/cron.d/*) case "\${f##*/}" in *[!A-Za-z0-9_-]*) continue ;; esac ;; esac; if [ -f "$f" ] && grep -Eqs '^[^#]*powder-image-prune' "$f"; then echo "$f already runs powder-image-prune, no second line written"; exit 0; fi; done`,
		`if [ ! -x '${HELPER_BIN_DIR}/powder-image-prune' ]; then echo '${HELPER_BIN_DIR}/powder-image-prune is not installed, no cron written'; exit 1; fi`,
		`C=$(mktemp /etc/cron.d/.powder-image-prune.XXXXXX) || { echo 'could not create a temp file in /etc/cron.d'; exit 1; }`,
		`printf '%s\\n' ${shq(PRUNE_CRON_LINE)} > "$C" && chown root:root "$C" && chmod 0644 "$C" && mv -f "$C" ${dest} || { rm -f "$C"; echo 'install failed'; exit 1; }`,
		`echo 'installed ${PRUNE_CRON_FILE}'`,
	].join('\n')
}

/** Creates the network when it is missing. The name is validated
 *  (assertDockerNetworkName), so it is a bare shell word. */
export function createNetworkCommand(name: string): string {
	return networkCommand(assertDockerNetworkName(name))
}

/** createNetworkCommand for a shell word (bin/server-bootstrap.sh passes "$TNET"). */
export function networkCommand(word: string): string {
	return `docker network inspect ${word} >/dev/null 2>&1 || docker network create ${word}`
}

export function mkdirCommand(dirWord: string): string {
	return `mkdir -p ${dirWord}`
}

// Re-checks at run time (a container, listener or nginx may have appeared
// since the check) and refuses rather than touching anything that exists.
// Fails closed: ss missing or erroring is a refusal.
export function startTraefikCommand(dynWord: string): string {
	const args = [
		'--entrypoints.web.address=:80',
		'--entrypoints.websecure.address=:443',
		'--entrypoints.web.http.redirections.entrypoint.to=websecure',
		'--entrypoints.web.http.redirections.entrypoint.scheme=https',
		'--providers.docker=true',
		'--providers.docker.exposedbydefault=false',
		'--providers.docker.network=web',
		// One backend connection per request: a container stopped in a deploy swap gets no
		// request over a pooled keep-alive connection after powder refused its new
		// connections (fragments.ts drainShellFunctions), so it drains and exits.
		'--serverstransport.maxidleconnsperhost=-1',
		`--providers.file.directory=${TRAEFIK_DYNAMIC_MOUNT}`,
		'--providers.file.watch=true',
		'--certificatesresolvers.le.acme.httpchallenge=true',
		'--certificatesresolvers.le.acme.httpchallenge.entrypoint=web',
		'--certificatesresolvers.le.acme.storage=/acme/acme.json',
		'--accesslog=true',
		'--accesslog.format=json',
		`--accesslog.filepath=${TRAEFIK_LOG_DIR}/access.log`,
	]
	return [
		"if docker inspect --type container traefik >/dev/null 2>&1; then echo 'a container named traefik exists, not touching it'; exit 1; fi",
		"if command -v nginx >/dev/null 2>&1; then echo 'nginx is installed, not starting traefik'; exit 1; fi",
		// Allow-list: only a disabled/masked/missing unit passes; systemctl erroring refuses.
		`if command -v systemctl >/dev/null 2>&1; then st=$(systemctl is-enabled nginx 2>/dev/null); rc=$?; case "$st" in ${NGINX_UNIT_OFF} | not-found) ;; "") if [ "$rc" -ne 4 ]; then echo 'could not read the nginx systemd unit state, not starting traefik'; exit 1; fi ;; *) echo 'an nginx systemd unit is enabled or in an unclear state, not starting traefik'; exit 1 ;; esac; fi`,
		"if ! command -v ss >/dev/null 2>&1; then echo 'ss is missing, cannot prove 80/443 are free'; exit 1; fi",
		"ssout=$(ss -ltn) || { echo 'ss failed, cannot prove 80/443 are free'; exit 1; }",
		`if printf '%s\\n' "$ssout" | awk 'NR>1 {print $4}' | grep -Eq ':(80|443)$'; then echo 'something listens on 80/443, not starting traefik'; exit 1; fi`,
		"ids=$(docker ps -aq) || { echo 'docker ps failed'; exit 1; }",
		`if [ -n "$ids" ]; then ins=$(docker inspect --format '{{json .HostConfig.PortBindings}}' $ids) || { echo 'docker inspect failed'; exit 1; }; if printf '%s\\n' "$ins" | grep -Eq '"HostPort":"(80|443)"'; then echo 'a container binds 80/443 (running or stopped), not starting traefik'; exit 1; fi; fi`,
		`mkdir -p ${dynWord} ${TRAEFIK_ACME_DIR}; install -d -m 0750 ${TRAEFIK_LOG_DIR}`,
		[
			`docker run -d --name traefik --restart unless-stopped --network web ${SIDE_RUN_CAPS}`,
			'-p 80:80 -p 443:443',
			'-v /var/run/docker.sock:/var/run/docker.sock:ro',
			`-v ${dynWord}:${TRAEFIK_DYNAMIC_MOUNT}:ro`,
			`-v ${TRAEFIK_ACME_DIR}:/acme`,
			`-v ${TRAEFIK_LOG_DIR}:${TRAEFIK_LOG_DIR}`,
			TRAEFIK_IMAGE,
			...args,
		].join(' '),
	].join('\n')
}

/** Why Traefik must not be started on this server, or null when it may. */
export function traefikBlocker(f: BootstrapFacts, proxy: BootstrapProxy): string | null {
	if (proxy !== 'traefik') {
		return `this server routes with ${proxy}; Traefik is only started on traefik servers`
	}
	if (f.traefik !== 'absent') return 'a container named traefik exists; powder never changes it'
	if (f.nginx !== 'absent' || f.nginxBinary !== 'absent') return 'nginx is installed on this server'
	if (f.nginxUnit === 'enabled') return 'an nginx systemd unit is enabled'
	if (f.nginxUnit === 'unknown') return 'could not read the nginx systemd unit state'
	if (f.port80 === 'unknown' || f.port443 === 'unknown') {
		return 'could not tell whether 80/443 are free (ss missing or failing); start Traefik by hand'
	}
	if (f.port80 !== 'free' || f.port443 !== 'free') return 'something already listens on 80/443'
	if (f.portBindings === 'bound') return 'a container (running or stopped) binds 80/443'
	if (f.portBindings === 'unknown') return 'could not read container port bindings'
	if (f.proxyContainers === 'present') {
		return 'a proxy container (nginx/traefik/caddy/haproxy/envoy) exists, running or stopped'
	}
	if (f.proxyContainers === 'unknown') return 'could not list containers'
	if (f.docker === 'unreachable') return 'docker is not usable'
	return null
}

/**
 * What `apply` would run for these facts. Only additive steps: missing
 * networks, missing dirs, Docker when absent, Traefik only when
 * traefikBlocker finds nothing. Never a command for an existing traefik,
 * nginx, ufw or any container.
 */
export function planApply(
	f: BootstrapFacts,
	dynWord: string,
	proxy: BootstrapProxy,
	shipped: ShippedHelperShas = {},
	redirectsInUse = true,
): BootstrapPlan {
	const steps: BootstrapStep[] = []
	const skipped: BootstrapPlan['skipped'] = []
	if (!f.root) {
		skipped.push({
			id: 'all',
			reason: 'the SSH user is not root; run bin/server-bootstrap.sh with sudo',
		})
		return { steps, skipped }
	}
	if (f.docker === 'absent') {
		steps.push({
			id: 'install-docker',
			title: `install Docker ${DOCKER_MAJOR}.x from Docker's apt repository, key fingerprint checked (Debian and Ubuntu; Docker adds its own iptables rules)`,
			command: installDockerCommand(),
		})
	} else if (f.docker === 'unreachable') {
		skipped.push({
			id: 'docker',
			reason: 'docker is installed but its daemon is not reachable; fix by hand',
		})
	}
	// Docker installed by the step above brings the compose plugin; an existing
	// engine without it is left alone.
	if (f.docker === 'present' && f.compose === 'absent') {
		skipped.push({ id: 'compose', reason: 'install the docker compose plugin by hand' })
	}
	const dockerUsable = f.docker === 'present' || f.docker === 'absent'
	if (f.appsDir === 'absent') {
		steps.push({
			id: 'mkdir-apps',
			title: `create ${APPS_DIR}`,
			command: mkdirCommand(shq(APPS_DIR)),
		})
	}
	// only domain redirects use the dynamic dir: created while one is set up here
	if (f.dynamicDir === 'absent' && proxy === 'traefik' && redirectsInUse) {
		steps.push({
			id: 'mkdir-dynamic',
			title: 'create the Traefik dynamic dir',
			command: mkdirCommand(dynWord),
		})
	}
	// The routing network: on Traefik servers the one Traefik routes over (`web`
	// unless it routes over another), elsewhere `web`. Then `internal`.
	const tnet = proxy === 'traefik' ? traefikNetworkOf(f) : null
	if (dockerUsable) {
		const routing = tnet ? routingNetwork(tnet) : DEFAULT_TRAEFIK_NETWORK
		for (const n of [routing, ...BOOTSTRAP_NETWORKS.filter((b) => b !== 'web' && b !== routing)]) {
			if (!networkPresent(f, n) || f.docker === 'absent') {
				const own = n === 'web' || n === 'internal'
				steps.push({
					id: own ? (`network-${n}` as StepId) : 'network-traefik',
					title: own ? `create docker network ${n}` : `create docker network ${n} (Traefik routes over it)`,
					command: createNetworkCommand(n),
				})
			}
		}
	}
	// An existing Traefik is never changed: attaching it is the operator's step.
	if (tnet && f.traefik !== 'absent') {
		const attached = tnet.attached ?? f.traefikAttached ?? null
		const routing = routingNetwork(tnet)
		if (attached && !attached.includes(routing)) {
			skipped.push({
				id: 'traefik-network',
				reason: `attach Traefik to ${routing} by hand (docker network connect ${routing} traefik); powder never changes an existing Traefik`,
			})
		}
	}
	const blocker = traefikBlocker(f, proxy)
	if (blocker) {
		skipped.push({ id: 'traefik', reason: blocker })
	} else {
		steps.push({
			id: 'start-traefik',
			title: `start ${TRAEFIK_IMAGE} (file provider + le ACME resolver; publishing 80/443 adds Docker iptables rules)`,
			command: startTraefikCommand(dynWord),
		})
	}
	for (const c of ['git', 'flock'] as const) {
		if (f.tools && f.tools[c] !== 'present') {
			skipped.push({ id: c, reason: `install ${c === 'flock' ? 'util-linux (flock)' : 'git'} with the distro's package manager` })
		}
	}
	if (f.helpers) {
		for (const h of PER_SERVER_HELPERS) {
			if (!h.installed) continue
			const st = helperState(f, h.key, shipped)
			if (st === 'current') continue
			const sha = shipped[h.key]
			if (!sha || !SHA256.test(sha)) {
				skipped.push({ id: h.bin, reason: `not in this powder image; install it by hand from infra/${h.src}` })
				continue
			}
			const replace = st === 'outdated'
			steps.push({
				id: `${replace ? 'replace' : 'install'}-${h.bin}` as StepId,
				title: replace
					? `replace ${HELPER_BIN_DIR}/${h.bin}: the installed copy differs from the one in this powder (a local change is lost)`
					: `install ${HELPER_BIN_DIR}/${h.bin} (root, 0755)`,
				command: `S=${sha}\n# T: a temp file in ${HELPER_BIN_DIR} that powder writes its infra/${h.src} to over SFTP\n${installHelperCommand(h.bin)}`,
				helper: h.key,
				...(replace ? { replaces: true } : {}),
			})
		}
	}
	// The prune's cron, once the helper is there or about to be installed; never a
	// second line when another cron file already runs it.
	if (f.pruneCron === 'absent' && f.pruneCronOther) {
		// handled elsewhere
	} else if (f.pruneCron === 'absent') {
	const prune =
		f.helpers?.imagePrune === 'present' || steps.some((s) => s.id === 'install-powder-image-prune')
	if (prune) {
		steps.push({
			id: 'install-image-prune-cron',
			title: `add ${PRUNE_CRON_FILE}: runs powder-image-prune hourly (root:root, 0644)`,
			command: installPruneCronCommand(),
		})
	} else {
		skipped.push({ id: 'image-prune-cron', reason: 'powder-image-prune is not installed; install it first' })
	}
	} else if (f.pruneCron === 'no-crond' && !f.pruneCronOther) {
	skipped.push({ id: 'image-prune-cron', reason: `no /etc/cron.d on this server; add to /etc/crontab: ${PRUNE_CRON_LINE}` })
	}
	// Traefik's access log rotation, on traefik servers only; an existing file is never changed.
	// Another file under /etc/logrotate.d that rotates the same logs counts as handled.
	if (proxy === 'traefik' && f.traefikLogrotate === 'absent' && !f.traefikLogrotateOther) {
		steps.push({
			id: 'install-traefik-logrotate',
			title: `add ${TRAEFIK_LOGROTATE_FILE}: rotates ${TRAEFIK_LOG_DIR}/*.log daily, keeps 7 (root:root, 0644)`,
			command: installTraefikLogrotateCommand(),
		})
	} else if (proxy === 'traefik' && f.traefikLogrotate === 'no-logrotate') {
		skipped.push({ id: 'traefik-logrotate', reason: `no /etc/logrotate.d on this server; install logrotate to rotate ${TRAEFIK_LOG_DIR}/access.log` })
	}
	return { steps, skipped }
}
