#!/usr/bin/env bash
# Server bootstrap, check-first. Run directly on a server powder should manage.
# Same checks and the same additive steps as "check server" / "fix missing
# pieces" on the dashboard's server page (apps/web/src/lib/server-bootstrap.ts;
# the test server-bootstrap.test.ts keeps the check body and the step commands
# below identical to it).
#
#   sudo bin/server-bootstrap.sh                      # check only (read-only, default)
#   sudo bin/server-bootstrap.sh --proxy nginx        # check as an nginx server (check defaults to traefik)
#   sudo bin/server-bootstrap.sh --apply --proxy traefik   # check, print the plan, confirm, run it
#   sudo bin/server-bootstrap.sh --apply --proxy nginx --yes
#   sudo bin/server-bootstrap.sh --apply --proxy traefik --replace-helpers
#   sudo bin/server-bootstrap.sh --apply --proxy nginx --docker-script
#
# --proxy is the server's servers.proxy and is REQUIRED with --apply.
#
# apply only adds what is missing: the docker networks web + internal,
# /opt/apps, the Traefik dynamic dir (traefik servers), Docker ONLY when docker
# is absent, and a pinned Traefik with the file provider + `le` ACME resolver
# ONLY when --proxy is traefik, there is no container named traefik, nginx is
# not installed or enabled, nothing listens on 80/443 and no container (running
# or stopped) binds them. On traefik servers it also writes
# /etc/logrotate.d/powder-traefik (daily, 7 kept, 100 MB cap, copytruncate) when
# absent; an existing file is never changed.
# Docker comes from Docker's apt repository (Debian and Ubuntu only; other
# distros are refused: install Docker yourself first): the repository key is
# trusted only when its fingerprint is 9DC858229FC7DD38854AE2D88D81803C0EBFCD88,
# it is kept in /etc/apt/keyrings/docker.asc (the source's signed-by), and the
# newest docker-ce 29.x is installed with the compose and buildx plugins.
# --docker-script uses Docker's convenience script (get.docker.com --version
# 29.4) instead; only that flag runs it, --yes alone never does.
# It also installs powder-migrate and powder-image-prune from this checkout's
# infra/ into /usr/local/bin (root, 0755) when absent, and writes
# /etc/cron.d/powder-image-prune (root, 0644, the hourly line from the script's
# header) when that file is absent; an existing cron file is never changed. An
# installed helper that differs from this checkout's copy is reported as
# outdated and only replaced with --replace-helpers. powder-resource-guard is
# optional: reported, never installed or compared.
# It never restarts or changes an existing container, Traefik or nginx, and
# never runs ufw. Installing Docker and publishing Traefik's ports add Docker's
# own iptables rules (published ports bypass ufw).
#
# Env: POWDER_TRAEFIK_DYNAMIC_DIR (default /opt/infra/traefik/dynamic), the
# same variable powder reads. POWDER_GET_DOCKER_SHA256: with --docker-script,
# the step refuses a convenience script with another sha256 (it always prints
# the hash it got). Docker installed some other way first: the step skips.
set -uo pipefail

MODE=check
YES=0
REPLACE=0
DOCKER_SCRIPT=0
PROXY=
while [ $# -gt 0 ]; do
	case "$1" in
	--apply) MODE=apply ;;
	--check) MODE=check ;;
	--yes | -y) YES=1 ;;
	--replace-helpers) REPLACE=1 ;;
	--docker-script) DOCKER_SCRIPT=1 ;;
	--proxy)
		PROXY="${2:-}"
		shift
		;;
	--proxy=*) PROXY="${1#--proxy=}" ;;
	-h | --help)
		sed -n '2,/^set -uo pipefail$/p' "$0" | sed '$d'
		exit 0
		;;
	*)
		echo "unknown argument: $1" >&2
		exit 2
		;;
	esac
	shift
done
# apply must be told the routing mode; check may default to reporting as traefik.
if [ -z "$PROXY" ]; then
	if [ "$MODE" = apply ]; then
		echo "--apply needs --proxy traefik|nginx|nginx-container (the server's routing mode)" >&2
		exit 2
	fi
	PROXY=traefik
fi
case "$PROXY" in
traefik | nginx | nginx-container) ;;
*)
	echo "--proxy must be traefik, nginx or nginx-container" >&2
	exit 2
	;;
esac

DYN="${POWDER_TRAEFIK_DYNAMIC_DIR:-/opt/infra/traefik/dynamic}"
DYN="${DYN%/}"
if ! [[ "$DYN" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$DYN" == *..* ]]; then
	echo "invalid POWDER_TRAEFIK_DYNAMIC_DIR: $DYN" >&2
	exit 2
fi

powder_check() (
	# BEGIN CHECK
	have() { command -v "$1" >/dev/null 2>&1; }
	echo "uid=$(id -u)"
	os=unknown; [ -r /etc/os-release ] && os=$(. /etc/os-release && echo "${ID:-unknown}"); echo "os=$os"
	if have docker && docker info >/dev/null 2>&1; then echo docker=present; echo "docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null)"; elif have docker; then echo docker=unreachable; else echo docker=absent; fi
	if docker compose version >/dev/null 2>&1; then echo compose=present; else echo compose=absent; fi
	for n in web internal; do if docker network inspect "$n" >/dev/null 2>&1; then echo "net_$n=present"; else echo "net_$n=absent"; fi; done
	case "$(docker inspect --type container -f '{{.State.Running}}' traefik 2>/dev/null)" in true) echo traefik=running ;; false) echo traefik=stopped ;; *) echo traefik=absent ;; esac
	if [ -d '/opt/apps' ]; then echo apps_dir=present; else echo apps_dir=absent; fi
	if [ -d "$DYN" ]; then echo dynamic_dir=present; else echo dynamic_dir=absent; fi
	if have ufw; then case "$(ufw status 2>/dev/null | head -n1)" in *inactive*) echo ufw=inactive ;; *active*) echo ufw=active ;; *) echo ufw=unknown ;; esac; else echo ufw=absent; fi
	if have ss && ssout=$(ss -ltn 2>/dev/null); then for p in 80 443; do if printf '%s\n' "$ssout" | awk 'NR>1 {print $4}' | grep -Eq ":$p\$"; then echo "port_$p=busy"; else echo "port_$p=free"; fi; done; else echo port_80=unknown; echo port_443=unknown; fi
	if pgrep -x nginx >/dev/null 2>&1; then echo nginx=present; else echo nginx=absent; fi
	if have nginx; then echo nginx_bin=present; else echo nginx_bin=absent; fi
	if have systemctl; then st=$(systemctl is-enabled nginx 2>/dev/null); rc=$?; case "$st" in enabled* | static | alias | linked* | indirect) echo nginx_unit=enabled ;; disabled | masked | masked-runtime) echo nginx_unit=disabled ;; not-found) echo nginx_unit=absent ;; "") if [ "$rc" -eq 4 ]; then echo nginx_unit=absent; else echo nginx_unit=unknown; fi ;; *) echo nginx_unit=unknown ;; esac; else echo nginx_unit=unknown; fi
	if ! have docker; then echo port_bindings=none; echo proxy_containers=absent; elif ids=$(docker ps -aq 2>/dev/null); then if [ -z "$ids" ]; then echo port_bindings=none; echo proxy_containers=absent; elif ins=$(docker inspect --format '{{json .HostConfig.PortBindings}} {{.Config.Image}}' $ids 2>/dev/null); then if printf '%s\n' "$ins" | grep -Eq '"HostPort":"(80|443)"'; then echo port_bindings=bound; else echo port_bindings=none; fi; if printf '%s\n' "$ins" | awk '{print $NF}' | grep -Eiq '(nginx|traefik|caddy|haproxy|envoy)'; then echo proxy_containers=present; else echo proxy_containers=absent; fi; else echo port_bindings=unknown; echo proxy_containers=unknown; fi; else echo port_bindings=unknown; echo proxy_containers=unknown; fi
	echo "disk_free_kb=$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}')"
	awk '/^MemTotal:/ {print "mem_total_kb=" $2} /^MemAvailable:/ {print "mem_avail_kb=" $2}' /proc/meminfo 2>/dev/null
	for h in migrate image-prune resource-guard; do k=$(printf '%s' "$h" | tr - _); if [ -x "/usr/local/bin/powder-$h" ]; then echo "helper_$k=present"; else echo "helper_$k=absent"; fi; echo "helper_${k}_sha=$(sha256sum "/usr/local/bin/powder-$h" 2>/dev/null | cut -c1-64)"; done
	for c in git flock; do if have "$c"; then echo "cmd_$c=present"; else echo "cmd_$c=absent"; fi; done
	if [ ! -d /etc/cron.d ]; then echo prune_cron=no-crond; elif [ ! -e '/etc/cron.d/powder-image-prune' ] && [ ! -L '/etc/cron.d/powder-image-prune' ]; then echo prune_cron=absent; elif [ "$(cat '/etc/cron.d/powder-image-prune' 2>/dev/null)" = '17 * * * * root /usr/local/bin/powder-image-prune >> /var/log/powder-image-prune.log 2>&1' ]; then echo prune_cron=current; else echo prune_cron=different; fi
	if [ ! -d /etc/logrotate.d ]; then echo traefik_logrotate=no-logrotate; elif [ ! -e '/etc/logrotate.d/powder-traefik' ] && [ ! -L '/etc/logrotate.d/powder-traefik' ]; then echo traefik_logrotate=absent; elif [ "$(cat '/etc/logrotate.d/powder-traefik' 2>/dev/null)" = "$(printf '%s\n' '/var/log/traefik/*.log {' '  daily' '  maxsize 100M' '  rotate 7' '  missingok' '  notifempty' '  compress' '  delaycompress' '  copytruncate' '}')" ]; then echo traefik_logrotate=current; else echo traefik_logrotate=different; fi
	echo '===TRAEFIK_INSPECT==='
	docker inspect --type container traefik 2>/dev/null || true
	# END CHECK
)

# The helpers this checkout ships (infra/, the same files the powder image copies).
HELPERS_SRC="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/infra"
helper_src() { case "$1" in migrate) echo "$HELPERS_SRC/powder-migrate" ;; image_prune) echo "$HELPERS_SRC/powder-image-prune.sh" ;; esac; }
shipped_sha() { local f; f=$(helper_src "$1"); [ -f "$f" ] && sha256sum "$f" | cut -c1-64; }
# Helper install: copy the checkout's file to a temp file next to the destination,
# then the same lines as installHelperCommand() in server-bootstrap.ts.
helper_install() ( # key bin
	SRC=$(helper_src "$1"); [ -f "$SRC" ] || { echo "$SRC not found in this checkout"; exit 1; }
	S=$(sha256sum "$SRC" | cut -c1-64) && T=$(mktemp "/usr/local/bin/.$2.XXXXXX") || exit 1
	cat "$SRC" > "$T" || { rm -f "$T"; exit 1; }
	"step_body_$1"
)

# Steps: each runs in a subshell so its `exit` ends only that step.
step_install_docker() (
	if command -v docker >/dev/null 2>&1; then echo 'docker already installed, skipping'; exit 0; fi
	OS_ID=$(. /etc/os-release 2>/dev/null && echo "${ID:-}"); OS_CODENAME=$(. /etc/os-release 2>/dev/null && echo "${VERSION_CODENAME:-}")
	case "$OS_ID" in debian | ubuntu) ;; *) echo "Docker's apt repository is set up here on Debian and Ubuntu only (this server: ${OS_ID:-unknown}). Install Docker Engine and the compose plugin yourself (docs.docker.com/engine/install), or use bin/server-bootstrap.sh --docker-script"; exit 1 ;; esac
	case "$OS_CODENAME" in '' | *[!a-z0-9]*) echo 'could not read VERSION_CODENAME from /etc/os-release'; exit 1 ;; esac
	DEBIAN_FRONTEND=noninteractive apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q ca-certificates curl gnupg || { echo 'could not install ca-certificates, curl and gnupg'; exit 1; }
	KD=$(mktemp -d /tmp/powder-docker-key.XXXXXX) || exit 1; trap 'rm -rf "$KD"' EXIT
	curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o "$KD/docker.asc" || { echo 'could not download the Docker repository key'; exit 1; }
	FPR=$(GNUPGHOME="$KD" gpg --batch --show-keys --with-colons "$KD/docker.asc" 2>/dev/null | awk -F: '$1 == "pub" {p = 1; next} $1 == "fpr" && p {print $10; p = 0}')
	if [ "$FPR" != '9DC858229FC7DD38854AE2D88D81803C0EBFCD88' ]; then echo "the downloaded Docker repository key is not 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 (got: ${FPR:-no key}), not trusting it"; exit 1; fi
	echo 'Docker repository key fingerprint 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 matches'
	KN=0; [ -e /etc/apt/keyrings/docker.asc ] || KN=1
	undo_repo() { rm -f /etc/apt/sources.list.d/docker.list; if [ "$KN" = 1 ]; then rm -f /etc/apt/keyrings/docker.asc; fi; echo 'removed /etc/apt/sources.list.d/docker.list again, so apt keeps working'; }
	install -d -m 0755 /etc/apt/keyrings && install -m 0644 "$KD/docker.asc" /etc/apt/keyrings/docker.asc || { echo 'could not install the key'; exit 1; }
	printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$OS_ID" "$OS_CODENAME" > /etc/apt/sources.list.d/docker.list || { echo 'could not write /etc/apt/sources.list.d/docker.list'; undo_repo; exit 1; }
	DEBIAN_FRONTEND=noninteractive apt-get update -q || { echo 'apt-get update failed with the Docker repository'; undo_repo; exit 1; }
	DV=$(apt-cache madison docker-ce | awk -v m=29 '{ v = $3; sub(/^[0-9]+:/, "", v); split(v, b, "."); if (b[1] == m) { print $3; exit } }')
	if [ -z "$DV" ]; then echo 'no Docker 29.x in the Docker repository for this release'; undo_repo; exit 1; fi
	echo "installing docker-ce $DV"
	DEBIAN_FRONTEND=noninteractive apt-get install -y -q "docker-ce=$DV" "docker-ce-cli=$DV" containerd.io docker-buildx-plugin docker-compose-plugin
)
# Only planned with --docker-script: Docker's convenience script.
step_install_docker_script() (
	if command -v docker >/dev/null 2>&1; then echo 'docker already installed, skipping'; exit 0; fi; GD=$(mktemp /tmp/powder-get-docker.XXXXXX) && trap 'rm -f "$GD"' EXIT && curl -fsSL https://get.docker.com -o "$GD" && GD_SUM=$(sha256sum "$GD" | cut -c1-64) && echo "get.docker.com script sha256: $GD_SUM" && if [ -n "${POWDER_GET_DOCKER_SHA256:-}" ] && [ "$GD_SUM" != "${POWDER_GET_DOCKER_SHA256:-}" ]; then echo 'the script does not match POWDER_GET_DOCKER_SHA256, not running it'; exit 1; fi && sh "$GD" --version 29.4
)
step_body_migrate() (
	if [ "$(sha256sum "$T" | cut -c1-64)" != "$S" ]; then rm -f "$T"; echo 'the uploaded copy does not match, nothing installed'; exit 1; fi
	if [ -d '/usr/local/bin/powder-migrate' ]; then rm -f "$T"; echo '/usr/local/bin/powder-migrate is a directory, not touching it'; exit 1; fi
	chown root:root "$T" && chmod 0755 "$T" && mv -f "$T" '/usr/local/bin/powder-migrate' || { rm -f "$T"; echo 'install failed'; exit 1; }
	echo "installed /usr/local/bin/powder-migrate (sha256 $S)"
)
step_body_image_prune() (
	if [ "$(sha256sum "$T" | cut -c1-64)" != "$S" ]; then rm -f "$T"; echo 'the uploaded copy does not match, nothing installed'; exit 1; fi
	if [ -d '/usr/local/bin/powder-image-prune' ]; then rm -f "$T"; echo '/usr/local/bin/powder-image-prune is a directory, not touching it'; exit 1; fi
	chown root:root "$T" && chmod 0755 "$T" && mv -f "$T" '/usr/local/bin/powder-image-prune' || { rm -f "$T"; echo 'install failed'; exit 1; }
	echo "installed /usr/local/bin/powder-image-prune (sha256 $S)"
)
step_install_powder_migrate() (
	helper_install migrate powder-migrate
)
step_install_powder_image_prune() (
	helper_install image_prune powder-image-prune
)
# Only planned with --replace-helpers: overwrites an outdated installed copy.
step_replace_powder_migrate() (
	helper_install migrate powder-migrate
)
step_replace_powder_image_prune() (
	helper_install image_prune powder-image-prune
)
# Same lines as installPruneCronCommand() in server-bootstrap.ts.
step_install_image_prune_cron() (
	if [ ! -d /etc/cron.d ]; then echo 'no /etc/cron.d on this server; add this line to /etc/crontab by hand: 17 * * * * root /usr/local/bin/powder-image-prune >> /var/log/powder-image-prune.log 2>&1'; exit 1; fi
	if [ -e '/etc/cron.d/powder-image-prune' ] || [ -L '/etc/cron.d/powder-image-prune' ]; then echo '/etc/cron.d/powder-image-prune exists, left as is'; exit 0; fi
	if [ ! -x '/usr/local/bin/powder-image-prune' ]; then echo '/usr/local/bin/powder-image-prune is not installed, no cron written'; exit 1; fi
	C=$(mktemp /etc/cron.d/.powder-image-prune.XXXXXX) || { echo 'could not create a temp file in /etc/cron.d'; exit 1; }
	printf '%s\n' '17 * * * * root /usr/local/bin/powder-image-prune >> /var/log/powder-image-prune.log 2>&1' > "$C" && chown root:root "$C" && chmod 0644 "$C" && mv -f "$C" '/etc/cron.d/powder-image-prune' || { rm -f "$C"; echo 'install failed'; exit 1; }
	echo 'installed /etc/cron.d/powder-image-prune'
)
# Same lines as installTraefikLogrotateCommand() in server-bootstrap.ts.
step_install_traefik_logrotate() (
	if [ ! -d /etc/logrotate.d ]; then echo 'no /etc/logrotate.d on this server (install logrotate); /var/log/traefik/access.log is not rotated'; exit 1; fi
	if [ -e '/etc/logrotate.d/powder-traefik' ] || [ -L '/etc/logrotate.d/powder-traefik' ]; then echo '/etc/logrotate.d/powder-traefik exists, left as is'; exit 0; fi
	C=$(mktemp /etc/.powder-traefik-logrotate.XXXXXX) || { echo 'could not create a temp file in /etc'; exit 1; }
	printf '%s\n' '/var/log/traefik/*.log {' '  daily' '  maxsize 100M' '  rotate 7' '  missingok' '  notifempty' '  compress' '  delaycompress' '  copytruncate' '}' > "$C" && chown root:root "$C" && chmod 0644 "$C" && mv -f "$C" '/etc/logrotate.d/powder-traefik' || { rm -f "$C"; echo 'install failed'; exit 1; }
	echo 'installed /etc/logrotate.d/powder-traefik'
)
step_network_web() (
	docker network inspect web >/dev/null 2>&1 || docker network create web
)
step_network_internal() (
	docker network inspect internal >/dev/null 2>&1 || docker network create internal
)
step_mkdir_apps() (
	mkdir -p '/opt/apps'
)
step_mkdir_dynamic() (
	mkdir -p "$DYN"
)
step_start_traefik() (
	if docker inspect --type container traefik >/dev/null 2>&1; then echo 'a container named traefik exists, not touching it'; exit 1; fi
	if command -v nginx >/dev/null 2>&1; then echo 'nginx is installed, not starting traefik'; exit 1; fi
	if command -v systemctl >/dev/null 2>&1; then st=$(systemctl is-enabled nginx 2>/dev/null); rc=$?; case "$st" in disabled | masked | masked-runtime | not-found) ;; "") if [ "$rc" -ne 4 ]; then echo 'could not read the nginx systemd unit state, not starting traefik'; exit 1; fi ;; *) echo 'an nginx systemd unit is enabled or in an unclear state, not starting traefik'; exit 1 ;; esac; fi
	if ! command -v ss >/dev/null 2>&1; then echo 'ss is missing, cannot prove 80/443 are free'; exit 1; fi
	ssout=$(ss -ltn) || { echo 'ss failed, cannot prove 80/443 are free'; exit 1; }
	if printf '%s\n' "$ssout" | awk 'NR>1 {print $4}' | grep -Eq ':(80|443)$'; then echo 'something listens on 80/443, not starting traefik'; exit 1; fi
	ids=$(docker ps -aq) || { echo 'docker ps failed'; exit 1; }
	if [ -n "$ids" ]; then ins=$(docker inspect --format '{{json .HostConfig.PortBindings}}' $ids) || { echo 'docker inspect failed'; exit 1; }; if printf '%s\n' "$ins" | grep -Eq '"HostPort":"(80|443)"'; then echo 'a container binds 80/443 (running or stopped), not starting traefik'; exit 1; fi; fi
	mkdir -p "$DYN" /opt/infra/traefik/acme; install -d -m 0750 /var/log/traefik
	docker run -d --name traefik --restart unless-stopped --network web --cap-drop NET_RAW --security-opt no-new-privileges -p 80:80 -p 443:443 -v /var/run/docker.sock:/var/run/docker.sock:ro -v "$DYN":/etc/traefik/dynamic:ro -v /opt/infra/traefik/acme:/acme -v /var/log/traefik:/var/log/traefik traefik:v3.6@sha256:31267173a15b4944e797a76ffd9c419707c8d8b32fe5b610f80cd0cfa05f372d --entrypoints.web.address=:80 --entrypoints.websecure.address=:443 --entrypoints.web.http.redirections.entrypoint.to=websecure --entrypoints.web.http.redirections.entrypoint.scheme=https --providers.docker=true --providers.docker.exposedbydefault=false --providers.docker.network=web --providers.file.directory=/etc/traefik/dynamic --providers.file.watch=true --certificatesresolvers.le.acme.httpchallenge=true --certificatesresolvers.le.acme.httpchallenge.entrypoint=web --certificatesresolvers.le.acme.storage=/acme/acme.json --accesslog=true --accesslog.format=json --accesslog.filepath=/var/log/traefik/access.log
)

OUT="$(powder_check)"
KV="$(printf '%s\n' "$OUT" | sed '/^===TRAEFIK_INSPECT===$/,$d')"
INSPECT="$(printf '%s\n' "$OUT" | sed '1,/^===TRAEFIK_INSPECT===$/d')"
get() { printf '%s\n' "$KV" | sed -n "s/^$1=//p" | head -n1; }

FAIL=0
line() { printf '  %-8s %-28s %s\n' "$1" "$2" "$3"; }
req() { # state label detail
	[ "$1" = ok ] || FAIL=1
	line "$1" "$2" "$3"
}
# Traefik pieces: required on traefik servers, info elsewhere.
treq() {
	if [ "$PROXY" = traefik ] || [ "$1" = ok ]; then req "$@"; else line info "$2" "$3 (not used with $PROXY)"; fi
}

echo "server check ($(hostname 2>/dev/null || echo '?'), proxy $PROXY)"
case "$(get docker)" in
present) req ok 'Docker engine' "version $(get docker_version)" ;;
unreachable) req missing 'Docker engine' 'installed, daemon not reachable for this user' ;;
*) req missing 'Docker engine' 'not installed' ;;
esac
[ "$(get compose)" = present ] && req ok 'docker compose plugin' installed || req missing 'docker compose plugin' 'not installed'
for n in web internal; do
	[ "$(get "net_$n")" = present ] && req ok "network $n" exists || req missing "network $n" missing
done
TRAEFIK="$(get traefik)"
case "$TRAEFIK" in
running) treq ok 'traefik container' running ;;
stopped) treq missing 'traefik container' 'exists but is stopped (not started or changed here)' ;;
*) treq missing 'traefik container' 'no container named traefik' ;;
esac
if [ "$TRAEFIK" != absent ]; then
	# Best effort: the dashboard parses the inspect JSON properly (and reads a
	# mounted traefik.yml); here we look for the flag and a mount of $DYN.
	if printf '%s' "$INSPECT" | grep -q 'providers.file.directory' &&
		printf '%s' "$INSPECT" | grep -q "\"Source\": \"$DYN\""; then
		treq ok 'traefik file provider' "watches $DYN"
	else
		treq missing 'traefik file provider' "no file provider on $DYN found in flags (a traefik.yml config is only checked by the dashboard)"
	fi
fi
[ "$(get apps_dir)" = present ] && req ok /opt/apps exists || req missing /opt/apps missing
[ "$(get dynamic_dir)" = present ] && treq ok "$DYN" exists || treq missing "$DYN" missing
case "$(get ufw)" in
active) line info 'firewall (ufw)' 'active: make sure 80 and 443 are allowed (never run here; Docker-published ports bypass it)' ;;
inactive) line info 'firewall (ufw)' 'installed, inactive' ;;
absent) line info 'firewall (ufw)' 'not installed' ;;
*) line info 'firewall (ufw)' 'state unknown (needs root)' ;;
esac
DISK_KB="$(get disk_free_kb)"
MEM_KB="$(get mem_total_kb)"
AVAIL_KB="$(get mem_avail_kb)"
# these come from the server's output and reach $(): digits only, else unset
# (bash arithmetic evaluates a name or an a[$(cmd)] subscript in the value).
for _v in DISK_KB MEM_KB AVAIL_KB; do case "${!_v}" in ''|*[!0-9]*) printf -v "$_v" '%s' '';; esac; done
[ -n "$DISK_KB" ] && line info 'free disk on /' "$((DISK_KB / 1024 / 1024)) GB"
[ -n "$MEM_KB" ] && line info 'memory' "$((${AVAIL_KB:-0} / 1024 / 1024)) GB free of $((MEM_KB / 1024 / 1024)) GB"

[ "$(get cmd_git)" = present ] && [ "$(get cmd_flock)" = present ] && req ok 'git and flock' installed || {
	_t=""; [ "$(get cmd_git)" = present ] || _t="$_t git"; [ "$(get cmd_flock)" = present ] || _t="$_t flock"
	req missing 'git and flock' "not installed:$_t (install with the distro's package manager: git, util-linux)"
}

# Per-server helpers (warn only, same as checkItems()): absent / outdated against
# this checkout's infra/ copy. The resource guard is optional: an info line only.
helper_state() { # key: absent | outdated | current
	[ "$(get "helper_$1")" = present ] || { echo absent; return; }
	local want have; want=$(shipped_sha "$1"); have=$(get "helper_$1_sha")
	if [ -n "$want" ] && [ -n "$have" ] && [ "$want" != "$have" ]; then echo outdated; else echo current; fi
}
HELPER_NOTES=""
HELPER_WARN=0
for _h in migrate image_prune; do
	_b="powder-$(printf '%s' "$_h" | tr _ -)"
	case "$(helper_state "$_h")" in
	absent) HELPER_WARN=1; HELPER_NOTES="$HELPER_NOTES $_b (not installed)" ;;
	outdated) HELPER_WARN=1; HELPER_NOTES="$HELPER_NOTES $_b (outdated: differs from this checkout's infra/ copy)" ;;
	esac
done
if [ "$HELPER_WARN" = 1 ]; then
	line warn 'per-server helpers' "${HELPER_NOTES# }; --apply installs a missing one, --replace-helpers also replaces an outdated one (see /docs/self-hosting#per-server-helpers)"
else
	line ok 'per-server helpers' 'powder-migrate, powder-image-prune'
fi
if [ "$(get helper_resource_guard)" = present ]; then
	line info 'powder-resource-guard' 'installed (optional; not checked for updates)'
else
	line info 'powder-resource-guard' 'optional, not installed (install by hand, see /docs/self-hosting#per-server-helpers)'
fi
PRUNE_CRON_LINE='17 * * * * root /usr/local/bin/powder-image-prune >> /var/log/powder-image-prune.log 2>&1'
case "$(get prune_cron)" in
current) line ok 'image prune cron' '/etc/cron.d/powder-image-prune: hourly at :17' ;;
absent) line warn 'image prune cron' '/etc/cron.d/powder-image-prune missing: powder-image-prune never runs (--apply adds it)' ;;
no-crond) line warn 'image prune cron' "no /etc/cron.d on this server: add this line to /etc/crontab by hand: $PRUNE_CRON_LINE" ;;
*) line info 'image prune cron' "/etc/cron.d/powder-image-prune has other content; left as is. powder's line: $PRUNE_CRON_LINE" ;;
esac
if [ "$PROXY" = traefik ]; then
	case "$(get traefik_logrotate)" in
	current) line ok 'traefik log rotation' '/etc/logrotate.d/powder-traefik: daily, 7 kept, 100 MB cap' ;;
	absent) line warn 'traefik log rotation' '/etc/logrotate.d/powder-traefik missing: /var/log/traefik/access.log grows without bound (--apply adds it)' ;;
	no-logrotate) line warn 'traefik log rotation' 'no /etc/logrotate.d on this server: /var/log/traefik/access.log is not rotated (install logrotate)' ;;
	*) line info 'traefik log rotation' '/etc/logrotate.d/powder-traefik has other content; left as is' ;;
	esac
fi

# Why Traefik must not be started here (same rules as traefikBlocker()).
traefik_blocker() {
	if [ "$PROXY" != traefik ]; then echo "this server routes with $PROXY; Traefik is only started with --proxy traefik"; return; fi
	if [ "$TRAEFIK" != absent ]; then echo 'a container named traefik exists; never changed here'; return; fi
	if [ "$(get nginx)" != absent ] || [ "$(get nginx_bin)" != absent ]; then echo 'nginx is installed on this server'; return; fi
	case "$(get nginx_unit)" in
	enabled) echo 'an nginx systemd unit is enabled'; return ;;
	absent | disabled) ;;
	*) echo 'could not read the nginx systemd unit state'; return ;;
	esac
	if [ "$(get port_80)" = unknown ] || [ "$(get port_443)" = unknown ]; then echo 'could not tell whether 80/443 are free (ss missing or failing)'; return; fi
	if [ "$(get port_80)" != free ] || [ "$(get port_443)" != free ]; then echo 'something already listens on 80/443'; return; fi
	case "$(get port_bindings)" in
	none) ;;
	bound) echo 'a container (running or stopped) binds 80/443'; return ;;
	*) echo 'could not read container port bindings'; return ;;
	esac
	case "$(get proxy_containers)" in
	absent) ;;
	present) echo 'a proxy container (nginx/traefik/caddy/haproxy/envoy) exists, running or stopped'; return ;;
	*) echo 'could not list containers'; return ;;
	esac
	if [ "$(get docker)" = unreachable ]; then echo 'docker is not usable'; return; fi
}

# Plan: same rules as planApply() in server-bootstrap.ts.
STEPS=()
SKIPPED=()
if [ "$(get uid)" != 0 ]; then
	SKIPPED+=('all: not root; rerun with sudo')
else
	DOCKER="$(get docker)"
	if [ "$DOCKER" = absent ]; then
		if [ "$DOCKER_SCRIPT" = 1 ]; then STEPS+=(install_docker_script); else STEPS+=(install_docker); fi
	fi
	[ "$DOCKER" = unreachable ] && SKIPPED+=('docker: installed but the daemon is not reachable; fix by hand')
	[ "$DOCKER" = present ] && [ "$(get compose)" = absent ] && SKIPPED+=('compose: install the docker compose plugin by hand')
	[ "$(get apps_dir)" = absent ] && STEPS+=(mkdir_apps)
	[ "$(get dynamic_dir)" = absent ] && [ "$PROXY" = traefik ] && STEPS+=(mkdir_dynamic)
	if [ "$DOCKER" != unreachable ]; then
		for n in web internal; do
			if [ "$(get "net_$n")" = absent ] || [ "$DOCKER" = absent ]; then STEPS+=("network_$n"); fi
		done
	fi
	BLOCKER="$(traefik_blocker)"
	if [ -n "$BLOCKER" ]; then SKIPPED+=("traefik: $BLOCKER"); else STEPS+=(start_traefik); fi
	[ "$(get cmd_git)" = present ] || SKIPPED+=("git: install git with the distro's package manager")
	[ "$(get cmd_flock)" = present ] || SKIPPED+=("flock: install util-linux (flock) with the distro's package manager")
	for _h in migrate image_prune; do
		_st="$(helper_state "$_h")"
		[ "$_st" = current ] && continue
		_b="powder-$(printf '%s' "$_h" | tr _ -)"
		if [ -z "$(shipped_sha "$_h")" ]; then SKIPPED+=("$_b: not in this checkout's infra/; install it by hand")
		elif [ "$_st" = absent ]; then STEPS+=("install_powder_$_h")
		elif [ "$REPLACE" = 1 ]; then STEPS+=("replace_powder_$_h")
		else SKIPPED+=("$_b: outdated, left as is; rerun with --replace-helpers to replace it"); fi
	done
	# The prune's cron, once the helper is there or about to be installed.
	case "$(get prune_cron)" in
	absent)
		if [ "$(get helper_image_prune)" = present ] || [[ " ${STEPS[*]-} " == *" install_powder_image_prune "* ]]; then STEPS+=(install_image_prune_cron)
		else SKIPPED+=('image-prune-cron: powder-image-prune is not installed; install it first'); fi
		;;
	no-crond) SKIPPED+=("image-prune-cron: no /etc/cron.d on this server; add to /etc/crontab: $PRUNE_CRON_LINE") ;;
	esac
	# Traefik's access log rotation, on traefik servers only (same as planApply()).
	if [ "$PROXY" = traefik ]; then
		case "$(get traefik_logrotate)" in
		absent) STEPS+=(install_traefik_logrotate) ;;
		no-logrotate) SKIPPED+=('traefik-logrotate: no /etc/logrotate.d on this server; install logrotate to rotate /var/log/traefik/access.log') ;;
		esac
	fi
fi

echo
if [ "$FAIL" = 0 ]; then echo 'all required pieces are there'; else echo 'some pieces are missing'; fi
for s in "${SKIPPED[@]+"${SKIPPED[@]}"}"; do echo "  not done automatically: $s"; done

if [ "${#STEPS[@]}" = 0 ]; then
	[ "$MODE" = apply ] && echo 'nothing to apply'
	exit "$FAIL"
fi

echo
echo "apply would run, in order:"
for s in "${STEPS[@]}"; do
	echo "--- $s"
	declare -f "step_$s" | sed '1,2d;$d'
	case "$s" in install_powder_* | replace_powder_*)
		_k=${s#*_powder_}
		[ "$(helper_state "$_k")" = outdated ] && echo "    (replaces the installed copy: it differs from $(helper_src "$_k"))"
		echo "    then:"; declare -f "step_body_$_k" | sed '1,2d;$d'
		;;
	esac
done
for s in "${STEPS[@]}"; do
	case "$s" in
	install_docker | install_docker_script) echo 'note: installing Docker changes iptables (Docker adds its own chains and NAT rules).' ;;
	start_traefik) echo 'note: publishing 80/443 for Traefik adds Docker iptables rules that bypass ufw.' ;;
	esac
done

if [ "$MODE" != apply ]; then
	echo
	echo 'check only; rerun with --apply to run the steps above'
	exit "$FAIL"
fi

if [ "$YES" != 1 ]; then
	printf '\nrun these steps? [y/N] '
	read -r answer
	case "$answer" in y | Y | yes) ;; *)
		echo 'aborted'
		exit 1
		;;
	esac
fi

for s in "${STEPS[@]}"; do
	echo "==> $s"
	if ! "step_$s"; then
		echo "step $s failed; stopping" >&2
		exit 1
	fi
done
echo
echo 'done; rerun without --apply to check again'
