import type { ServerConfig } from '../servers'
import { appLockPath } from '../deploy-supersede'
import { type RecreateApproval, appLockShell, composeFileArgs, composeUpCommand, infraCountShell, resolveInfraServices } from './fragments'
import { assertSafeName, shq } from '../shell'
import { ALL_PROFILES } from './compose-hash'
import { runCommand } from '../ssh/connection'
import { type PushDecision, refusedPush } from '../deploy-push-policy'
import { withRegistryCreds } from '../docker-env'

// Polls a container's HTTP endpoint until it returns a non-5xx, or times out.
// Run on the app server itself so we don't need the container to be publicly
// reachable. Tries a host-published port first; falls back to the container's
// docker network IP + ExposedPorts. If neither yields a target (rare — happens
// for non-HTTP workloads like queues) we skip the check rather than fail it.
//
// "Healthy" = any response with HTTP < 500. We accept 4xx because many APIs
// 404 on `/` but are otherwise fine. The point is "process accepted a TCP
// connection and produced an HTTP response" — that rules out boot crashes,
// missing-env-var crashes, and listening-on-wrong-port mistakes.
//
// UNLESS the app declares a health path (app_repos.health_url — see
// deploys.ts). Then the gate gets teeth: the probe hits THAT path, sends the
// app's live hostname as the Host header (so host-routed middleware doesn't
// bounce us), and only a 2xx counts. 3xx/4xx/5xx all read as "answered, but
// not healthy" → the deploy fails and auto-rollback runs.
//
// Without a health path the gate only proves the app answers: a Host-less probe
// can hit host-routed middleware that answers 301 (in 1xx-4xx) while the real
// pages serve 500s. A declared path is asked with the live Host, so it is the
// real check.
export async function healthCheckContainer(
	server: ServerConfig,
	name: string,
	opts: {
		maxWaitMs?: number
		intervalMs?: number
		/** Path to probe instead of `/`. Its presence switches the gate to 2xx-only. */
		healthPath?: string
		/** Sent as `Host:` so host-routed middleware/Traefik-style apps answer for real. */
		hostHeader?: string
		onChunk?: (chunk: string) => void
	} = {},
): Promise<{ healthy: boolean; skipped: boolean; output: string; targetUrl: string | null }> {
	assertSafeName(name)
	const intervalSec = Math.max(1, Math.floor((opts.intervalMs ?? 5_000) / 1000))
	const totalSec = Math.max(intervalSec, Math.floor((opts.maxWaitMs ?? 60_000) / 1000))
	const attempts = Math.max(1, Math.floor(totalSec / intervalSec))

	const rawPath = opts.healthPath?.trim() ?? ''
	const strict = rawPath.length > 0
	const probePath = strict ? (rawPath.startsWith('/') ? rawPath : `/${rawPath}`) : '/'
	const hostHeader = opts.hostHeader?.trim() ?? ''

	const script = [
		`NAME=${shq(name)}`,
		`INTERVAL=${intervalSec}`,
		`ATTEMPTS=${attempts}`,
		`HPATH=${shq(probePath)}`,
		`HOSTHDR=${shq(hostHeader)}`,
		`STRICT=${strict ? 1 : 0}`,
		`if [ "$STRICT" = "1" ]; then ACCEPT=2xx; else ACCEPT=1xx-4xx; fi`,
		`PUB=$(docker port "$NAME" 2>/dev/null | grep -oE ':[0-9]+$' | head -1 | tr -d ':')`,
		// Host-network containers publish no ports and have no container IP —
		// they listen straight on the server. Probe 127.0.0.1:$PORT (their own PORT
		// env), which is exactly what the server's nginx forwards to. Without this,
		// every host-net app would be "skipped" and judged by liveness only, even
		// with a health_url set.
		`NETMODE=$(docker inspect "$NAME" --format '{{.HostConfig.NetworkMode}}' 2>/dev/null)`,
		`HNPORT=$(docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^PORT=\\([0-9][0-9]*\\)$/\\1/p' | head -1)`,
		`if [ -n "$PUB" ]; then`,
		`  TARGET="http://127.0.0.1:$PUB$HPATH"`,
		`  MODE=pub`,
		// Only with a health_url: sibling host-net services can share one PORT
		// value (api-worker inherits api's PORT=3000), so an unasked-for probe
		// could credit a worker with its sibling's answer. Without health_url a
		// host-net container keeps the liveness judgement.
		`elif [ "$STRICT" = "1" ] && [ "$NETMODE" = "host" ] && [ -n "$HNPORT" ]; then`,
		`  TARGET="http://127.0.0.1:$HNPORT$HPATH"`,
		`  MODE=hostnet`,
		`else`,
		`  IP=$(docker inspect "$NAME" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$v.IPAddress}} {{end}}' 2>/dev/null | tr ' ' '\\n' | grep -E '^[0-9]+\\.' | head -1)`,
		`  CPORT=$(docker inspect "$NAME" --format '{{range $p, $_ := .Config.ExposedPorts}}{{$p}} {{end}}' 2>/dev/null | grep -oE '[0-9]+' | head -1)`,
		`  if [ -n "$IP" ] && [ -n "$CPORT" ]; then`,
		`    TARGET="http://$IP:$CPORT$HPATH"`,
		`    MODE=guess`,
		`  else`,
		`    TARGET=""`,
		`  fi`,
		`fi`,
		`if [ -z "$TARGET" ]; then`,
		// A declared health_url is a promise the app answers HTTP — not being
		// able to find where to ask is a failure, not a pass.
		`  if [ "$STRICT" = "1" ]; then`,
		`    echo "── unhealthy: health_url is set but no probe target (no published port, no container IP+ExposedPorts, no PORT env on a host-network container) ──"`,
		`    echo "POWDER_HEALTH=fail"`,
		`    exit 1`,
		`  fi`,
		`  echo "── health check skipped: no published port and no container IP+ExposedPorts ──"`,
		`  echo "POWDER_HEALTH=skipped"`,
		`  exit 0`,
		`fi`,
		// Two curl forms rather than one with an interpolated flag: an empty
		// $HOSTHDR must produce NO -H argument at all, and unquoted expansion of
		// a "-H Host: x" string would word-split on the space.
		`probe() {`,
		`  if [ -n "$HOSTHDR" ]; then`,
		`    curl -sS --max-time 5 -H "Host: $HOSTHDR" -H "X-Forwarded-Proto: https" -o /dev/null -w '%{http_code}' "$TARGET" 2>/dev/null || true`,
		`  else`,
		`    curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$TARGET" 2>/dev/null || true`,
		`  fi`,
		`}`,
		`if [ -n "$HOSTHDR" ]; then HOSTDESC="host=$HOSTHDR, "; else HOSTDESC=""; fi`,
		`echo "── health check: $TARGET (mode=$MODE, $HOSTDESC$ATTEMPTS attempts x ${intervalSec}s, accept $ACCEPT) ──"`,
		// Only a REAL HTTP status counts. A check against the literal "000" is
		// not enough: on connection failure curl -w prints 000 (no newline) AND
		// an || fallback appends another, yielding "000000", which passes both a
		// != "000" guard and -lt 500, so an unreachable target would read
		// "healthy on attempt 1 (HTTP 000000)": a rubber stamp.
		// SAW_HTTP tracks whether the target ever spoke HTTP at all: a guessed
		// container-IP target that NEVER answers is indistinguishable from
		// "host can't reach that docker network", so it degrades
		// to skipped → the caller's liveness fallback judges the container.
		// A published port that never answers IS the app being down → fail.
		`i=0`,
		`SAW_HTTP=0`,
		`while [ "$i" -lt "$ATTEMPTS" ]; do`,
		`  i=$((i + 1))`,
		`  CODE=$(probe)`,
		`  case "$CODE" in`,
		`    2[0-9][0-9])`,
		`      echo "healthy on attempt $i (HTTP $CODE)"`,
		`      echo "POWDER_HEALTH=ok TARGET=$TARGET"`,
		`      exit 0`,
		`      ;;`,
		// Non-2xx that IS an HTTP answer. Guess-mode's "never answered → skipped"
		// degradation keys off SAW_HTTP, so a 301/404 must set it: the container
		// spoke HTTP, it just didn't say "healthy" — that's a fail, not a skip.
		`    1[0-9][0-9]|3[0-9][0-9]|4[0-9][0-9])`,
		`      if [ "$STRICT" = "0" ]; then`,
		`        echo "healthy on attempt $i (HTTP $CODE)"`,
		`        echo "POWDER_HEALTH=ok TARGET=$TARGET"`,
		`        exit 0`,
		`      fi`,
		`      SAW_HTTP=1`,
		`      ;;`,
		`    5[0-9][0-9])`,
		`      SAW_HTTP=1`,
		`      ;;`,
		`    *)`,
		`      CODE="no-connection"`,
		`      ;;`,
		`  esac`,
		`  echo "attempt $i: $CODE"`,
		`  sleep $INTERVAL`,
		`done`,
		// Guessed targets (container IP, or a host-net PORT env on a non-HTTP
		// worker) that never spoke HTTP degrade to skipped → liveness judges the
		// container. NOT when a health_url is set: then silence is a failure.
		`if [ "$STRICT" = "0" ] && [ "$MODE" != "pub" ] && [ "$SAW_HTTP" = "0" ]; then`,
		`  echo "── health check skipped: guessed target $TARGET never answered (host may not reach that docker network) ──"`,
		`  echo "POWDER_HEALTH=skipped TARGET=$TARGET"`,
		`  exit 0`,
		`fi`,
		`echo "── unhealthy: no $ACCEPT response after $ATTEMPTS attempts ──"`,
		`echo "POWDER_HEALTH=fail TARGET=$TARGET"`,
		`exit 1`,
	].join('\n')

	const { stdout, stderr, code } = await runCommand(
		server,
		script,
		totalSec * 1000 + 30_000,
		opts.onChunk,
	)
	const output = stdout || stderr
	const skipped = /POWDER_HEALTH=skipped/.test(output)
	const targetMatch = output.match(/TARGET=(http:\/\/\S+)/)
	return {
		healthy: code === 0 && !skipped,
		skipped,
		output,
		targetUrl: targetMatch ? targetMatch[1] ?? '' : null,
	}
}

// Liveness probe for non-HTTP workloads (queue workers, crons) that the HTTP
// health check can't judge — there's no port to curl. A freshly-recreated
// worker is healthy if it stays Running and doesn't crash-loop. We sample
// State.Running + RestartCount twice across a short window: a container that's
// crashing on boot (bad env, missing migration) racks up restarts under its
// `restart: unless-stopped` policy, which we catch as RestartCount climbing.
// A clean one-shot job (exited 0, never restarted) is treated as alive so we
// don't roll back a job container that simply finished its work.
export async function livenessCheckContainer(
	server: ServerConfig,
	name: string,
	opts: {
		windowMs?: number
		onChunk?: (chunk: string) => void
	} = {},
): Promise<{ alive: boolean; output: string }> {
	assertSafeName(name)
	const windowSec = Math.max(5, Math.floor((opts.windowMs ?? 20_000) / 1000))

	const script = [
		`NAME=${shq(name)}`,
		`WINDOW=${windowSec}`,
		`echo "── liveness check (non-HTTP workload): $NAME, watching ${windowSec}s for crash-loop ──"`,
		`RUN0=$(docker inspect "$NAME" --format '{{.State.Running}}' 2>/dev/null || echo error)`,
		`RC0=$(docker inspect "$NAME" --format '{{.RestartCount}}' 2>/dev/null || echo -1)`,
		`if [ "$RUN0" = "error" ] || [ "$RC0" = "-1" ]; then`,
		`  echo "could not inspect container - cannot judge liveness"`,
		`  echo "POWDER_LIVENESS=fail"`,
		`  exit 1`,
		`fi`,
		`echo "initial: Running=$RUN0 RestartCount=$RC0"`,
		`sleep $WINDOW`,
		`RUN1=$(docker inspect "$NAME" --format '{{.State.Running}}' 2>/dev/null || echo error)`,
		`RC1=$(docker inspect "$NAME" --format '{{.RestartCount}}' 2>/dev/null || echo -1)`,
		`echo "after ${windowSec}s: Running=$RUN1 RestartCount=$RC1"`,
		`if [ "$RUN1" != "true" ]; then`,
		`  EC=$(docker inspect "$NAME" --format '{{.State.ExitCode}}' 2>/dev/null || echo -1)`,
		`  if [ "$EC" = "0" ] && [ "$RC1" = "0" ]; then`,
		`    echo "container exited cleanly (code 0, never restarted) - completed one-shot, treating as alive"`,
		`    echo "POWDER_LIVENESS=ok"`,
		`    exit 0`,
		`  fi`,
		`  echo "container not running (exit code $EC) - crashed"`,
		`  echo "POWDER_LIVENESS=fail"`,
		`  exit 1`,
		`fi`,
		`if [ "$RC1" -gt "$RC0" ]; then`,
		`  echo "restart count climbed $RC0 → $RC1 - crash-looping"`,
		`  echo "POWDER_LIVENESS=fail"`,
		`  exit 1`,
		`fi`,
		`echo "alive: running and stable (no restarts in ${windowSec}s)"`,
		`echo "POWDER_LIVENESS=ok"`,
		`exit 0`,
	].join('\n')

	const { stdout, stderr, code } = await runCommand(
		server,
		script,
		windowSec * 1000 + 30_000,
		opts.onChunk,
	)
	const output = stdout || stderr
	return { alive: code === 0 && /POWDER_LIVENESS=ok/.test(output), output }
}

/** the rollback target when it is not on the server. `docker pull` runs as root
 *  with root's registry logins, so it is pulled only from a repo the app owns under the
 *  rollback tag push rule (deployPushDecision: the repo powder pushed that tag to);
 *  otherwise the rollback refuses, naming the reason. A local image (no registry repo)
 *  is never pulled. Shell; exits non-zero when the image is not usable. */
export function rollbackTargetShell(historicalImage: string, pull: PushDecision): string {
	const img = shq(historicalImage)
	const why = pull.reason.replace(/[^A-Za-z0-9 ._/:()@-]/g, '_')
	return (
		`(docker image inspect ${img} --format '{{.Id}}' 2>/dev/null || ` +
		(pull.allow
			? ` (echo "── image not local, pulling "${img}" ──" && ${withRegistryCreds(`docker pull ${img}`, pull)} && docker image inspect ${img} --format '{{.Id}}'))`
			: ` { echo "── image "${img}" is not on this server; powder does not pull it (${why}): root's registry login would fetch it. Pick a rollback target whose image is still local ──"; exit 1; })`)
	)
}

export async function rollbackToImage(
	server: ServerConfig,
	configFile: string,
	service: string,
	historicalImage: string,
	currentImage: string,
	onChunk: ((chunk: string) => void) | undefined,
	/** app: the app_repos container_name (the project-name check's authority); omit it
	 *  only when the caller has no app_repos row, the name is then not checked. */
	/** approval: checkComposeForRecreate on the compose on disk, run after any env
	 *  snapshot restore; its hash is pinned before the `up`. */
	opts: { composeFiles?: string[]; workingDir: string; app?: string; approval: RecreateApproval },
): Promise<{ output: string }> {
	if (!/^[A-Za-z0-9._\-:/]+$/.test(historicalImage))
		throw new Error(`unsafe image tag: ${historicalImage}`)
	if (!/^[A-Za-z0-9._\-:/]+$/.test(currentImage))
		throw new Error(`unsafe image tag: ${currentImage}`)
	const cf = composeFileArgs(configFile, opts.composeFiles)
	const infra = await resolveInfraServices(server, cf, service)
	const lock = appLockPath(opts.workingDir, service)
	// pull a missing target only from a repo this app owns (push rule).
	const pull: PushDecision = !historicalImage.includes('/')
		? refusedPush('a local image, never pushed')
		: !opts.app
			? refusedPush('no registered app owns this container')
			: await import('../deploy-push')
					.then((m) => m.loadDeployPushDecision(opts.app as string, historicalImage))
					.catch((err) => refusedPush(`could not read the push history (${err instanceof Error ? err.message : String(err)})`))
	// Lock the WHOLE retag + up: a lock timeout must not leave the shared tag
	// pointing at the historical image with no recreate.
	const cmd =
		`set -e; ` +
		`{ ${appLockShell(lock)}} && ` +
		`echo "── rollback target ──" && ` +
		// Try local first; if missing, pull only from a repo this app owns (registry-mode
		// apps where powder pushed the deploy-id tag); else refuse (rollbackTargetShell).
		`${rollbackTargetShell(historicalImage, pull)} && ` +
		`echo "── retag "${shq(historicalImage)}" as "${shq(currentImage)}" ──" && ` +
		`docker tag ${shq(historicalImage)} ${shq(currentImage)} 2>&1 && ` +
		`echo "── docker compose up ──" && ` +
		// Drop any leftover zero-downtime bridge of this service (label powder.bridge=<workdir>|<service>).
		`(docker ps -aq --filter ${shq(`label=powder.bridge=${opts.workingDir}|${service}`)} 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true) && ` +
		// Same service-targeting logic as rebuildDeploy — `|| true` keeps the
		// chain alive when grep -c finds zero matches.
		`SVC_LIST=$(docker compose ${cf} ${ALL_PROFILES} config --services 2>/dev/null || true) && ` +
		`SVC_COUNT=$(printf '%s\n' "$SVC_LIST" | grep -c . || true) && ` +
		infraCountShell(infra) +
		`if [ "$HAS_INFRA" -gt 0 ] && [ "$SVC_COUNT" -gt 1 ]; then TARGETS=${shq(service)}; else TARGETS=""; fi && ` +
		`export TARGETS && ` +
		composeUpCommand(configFile, service, opts.workingDir, {
			cf,
			targets: '$TARGETS',
			tail: null,
			lock: false,
			approval: opts.approval,
			...(opts.app !== undefined ? { app: opts.app } : {}),
		})
	onChunk?.(opts.approval.log)
	const { stdout, code, stderr } = await runCommand(server, cmd, 300_000, onChunk)
	if (code !== 0) throw new Error(stderr || stdout || 'rollback failed')
	return { output: opts.approval.log + stdout }
}

// ── per-deploy env snapshots (rollback restores the env its image ran with) ──
//
// The env file is rendered DB → disk BEFORE the build, so a rollback that only
// recreated the OLD image would run it with the NEW env, and a deploy broken by
// an env change would "roll back" into the same failure while reporting
// success. Every deploy
// that passes its gate snapshots the rendered env into the powder env state dir
// (`/var/lib/powder/env/<env>/deploy-<id>`, newest ENV_SNAPSHOT_KEEP kept); a
// rollback to deploy X restores X's snapshot. The restore also writes
// `powder-restored` in that dir = sha256 of what it restored, so the next deploy's
// drift guard can tell "powder's own rollback snapshot" (safe to re-render)
// from "someone hand-edited the file" (refuse, as before).
