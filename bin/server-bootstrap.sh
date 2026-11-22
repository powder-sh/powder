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
#   sudo bin/server-bootstrap.sh --proxy traefik --redirects no
#
# --proxy is the server's servers.proxy and is REQUIRED with --apply.
# --redirects yes|no: is a domain redirect set up for an app on this server (the
# dashboard knows: its server check passes the same fact)? Only redirects use
# Traefik's file provider and the dynamic dir, so with no they are info lines.
# Default yes, the cautious side: both required on traefik servers.
#
# The check fails (exit 1) only on required pieces: Docker, the compose plugin,
# /opt/apps, git and flock, and on traefik servers the network Traefik routes over,
# Traefik attached to it, and (with --redirects yes) its file provider and the
# dynamic dir. The network powder routes over: Traefik's --providers.docker.network
# flag, else providers.docker.network in a mounted traefik.yml/.yaml/.toml when it
# is written in a plain form (anything else: the run says only the dashboard reads
# that config and gives no network advice), else web. A network Traefik is merely
# attached to is reported, never used. "Handled elsewhere" for the prune cron and the Traefik log rotation
# counts only files cron and logrotate load (cron.d names of [A-Za-z0-9_-] only;
# logrotate.d names without a default taboo extension; no commented-out line). A missing web is an info line
# where Traefik routes over another network, and on nginx servers (the dashboard's
# new-app flow creates it); internal is optional everywhere.
#
# apply only adds what is missing: the routing network (Traefik's, else web) and
# internal, /opt/apps, the Traefik dynamic dir (traefik servers, --redirects yes),
# Docker ONLY when docker
# is absent, and a pinned Traefik with the file provider + `le` ACME resolver
# ONLY when --proxy is traefik, there is no container named traefik, nginx is
# not installed or enabled, nothing listens on 80/443 and no container (running
# or stopped) binds them. On traefik servers it also writes
# /etc/logrotate.d/powder-traefik (daily, 7 kept, 100 MB cap, copytruncate) when
# absent and no other file under /etc/logrotate.d names /var/log/traefik; an
# existing file is never changed. An existing Traefik not attached to its network
# is reported, never changed: connect it by hand.
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
# header) when that file is absent and neither /etc/crontab nor another
# /etc/cron.d file runs powder-image-prune; an existing cron file is never changed. An
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
REDIRECTS=yes
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
	--redirects)
		REDIRECTS="${2:-}"
		shift
		;;
	--redirects=*) REDIRECTS="${1#--redirects=}" ;;
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
case "$REDIRECTS" in
yes | no) ;;
*)
	echo "--redirects must be yes or no" >&2
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
	echo "docker_networks=$(docker network ls --format '{{.Name}}:{{.Internal}}:{{.Label "com.docker.compose.project"}}' 2>/dev/null | tr '\n' ' ')"
	echo "traefik_project=$(docker inspect --type container -f '{{index .Config.Labels "com.docker.compose.project"}}' traefik 2>/dev/null)"
	echo "traefik_networks=$(docker inspect --type container -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' traefik 2>/dev/null)"
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
	o=; for f in /etc/crontab /etc/cron.d/*; do [ "$f" = '/etc/cron.d/powder-image-prune' ] && continue; case "$f" in /etc/cron.d/*) case "${f##*/}" in *[!A-Za-z0-9_-]*) continue ;; esac ;; esac; if [ -f "$f" ] && grep -Eqs '^[^#]*powder-image-prune' "$f"; then o=${f#/etc/}; break; fi; done; echo "prune_cron_other=$o"
	if [ ! -d /etc/cron.d ]; then echo prune_cron=no-crond; elif [ ! -e '/etc/cron.d/powder-image-prune' ] && [ ! -L '/etc/cron.d/powder-image-prune' ]; then echo prune_cron=absent; elif [ "$(cat '/etc/cron.d/powder-image-prune' 2>/dev/null)" = '17 * * * * root /usr/local/bin/powder-image-prune >> /var/log/powder-image-prune.log 2>&1' ]; then echo prune_cron=current; else echo prune_cron=different; fi
	if [ ! -d /etc/logrotate.d ]; then echo traefik_logrotate=no-logrotate; elif [ ! -e '/etc/logrotate.d/powder-traefik' ] && [ ! -L '/etc/logrotate.d/powder-traefik' ]; then echo traefik_logrotate=absent; elif [ "$(cat '/etc/logrotate.d/powder-traefik' 2>/dev/null)" = "$(printf '%s\n' '/var/log/traefik/*.log {' '  daily' '  maxsize 100M' '  rotate 7' '  missingok' '  notifempty' '  compress' '  delaycompress' '  copytruncate' '}')" ]; then echo traefik_logrotate=current; else echo traefik_logrotate=different; fi
	o=; if [ -d /etc/logrotate.d ]; then for f in /etc/logrotate.d/* /etc/logrotate.d/.[!.]* /etc/logrotate.d/..?*; do [ "$f" = '/etc/logrotate.d/powder-traefik' ] && continue; case "${f##*/}" in *,v | *.cfsaved | *.disabled | *.dpkg-bak | *.dpkg-del | *.dpkg-dist | *.dpkg-new | *.dpkg-old | *.dpkg-tmp | *.rhn-cfg-tmp-* | *.rpmnew | *.rpmorig | *.rpmsave | *.swp | *.ucf-dist | *.ucf-new | *.ucf-old | *~) continue ;; esac; if [ -f "$f" ] && grep -Eqs '^[^#]*/var/log/traefik' "$f"; then o=${f##*/}; break; fi; done; fi; echo "traefik_logrotate_other=$o"
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
	for f in /etc/crontab /etc/cron.d/*; do case "$f" in /etc/cron.d/*) case "${f##*/}" in *[!A-Za-z0-9_-]*) continue ;; esac ;; esac; if [ -f "$f" ] && grep -Eqs '^[^#]*powder-image-prune' "$f"; then echo "$f already runs powder-image-prune, no second line written"; exit 0; fi; done
	if [ ! -x '/usr/local/bin/powder-image-prune' ]; then echo '/usr/local/bin/powder-image-prune is not installed, no cron written'; exit 1; fi
	C=$(mktemp /etc/cron.d/.powder-image-prune.XXXXXX) || { echo 'could not create a temp file in /etc/cron.d'; exit 1; }
	printf '%s\n' '17 * * * * root /usr/local/bin/powder-image-prune >> /var/log/powder-image-prune.log 2>&1' > "$C" && chown root:root "$C" && chmod 0644 "$C" && mv -f "$C" '/etc/cron.d/powder-image-prune' || { rm -f "$C"; echo 'install failed'; exit 1; }
	echo 'installed /etc/cron.d/powder-image-prune'
)
# Same lines as installTraefikLogrotateCommand() in server-bootstrap.ts.
step_install_traefik_logrotate() (
	if [ ! -d /etc/logrotate.d ]; then echo 'no /etc/logrotate.d on this server (install logrotate); /var/log/traefik/access.log is not rotated'; exit 1; fi
	if [ -e '/etc/logrotate.d/powder-traefik' ] || [ -L '/etc/logrotate.d/powder-traefik' ]; then echo '/etc/logrotate.d/powder-traefik exists, left as is'; exit 0; fi
	for f in /etc/logrotate.d/* /etc/logrotate.d/.[!.]* /etc/logrotate.d/..?*; do case "${f##*/}" in *,v | *.cfsaved | *.disabled | *.dpkg-bak | *.dpkg-del | *.dpkg-dist | *.dpkg-new | *.dpkg-old | *.dpkg-tmp | *.rhn-cfg-tmp-* | *.rpmnew | *.rpmorig | *.rpmsave | *.swp | *.ucf-dist | *.ucf-new | *.ucf-old | *~) continue ;; esac; if [ -f "$f" ] && grep -Eqs '^[^#]*/var/log/traefik' "$f"; then echo "$f already rotates /var/log/traefik, no second file written"; exit 0; fi; done
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
# The network Traefik routes over when it is not web or internal ($TNET, validated).
step_network_traefik() (
	docker network inspect "$TNET" >/dev/null 2>&1 || docker network create "$TNET"
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
	docker run -d --name traefik --restart unless-stopped --network web --cap-drop NET_RAW --security-opt no-new-privileges -p 80:80 -p 443:443 -v /var/run/docker.sock:/var/run/docker.sock:ro -v "$DYN":/etc/traefik/dynamic:ro -v /opt/infra/traefik/acme:/acme -v /var/log/traefik:/var/log/traefik traefik:v3.6@sha256:31267173a15b4944e797a76ffd9c419707c8d8b32fe5b610f80cd0cfa05f372d --entrypoints.web.address=:80 --entrypoints.websecure.address=:443 --entrypoints.web.http.redirections.entrypoint.to=websecure --entrypoints.web.http.redirections.entrypoint.scheme=https --providers.docker=true --providers.docker.exposedbydefault=false --providers.docker.network=web --serverstransport.maxidleconnsperhost=-1 --providers.file.directory=/etc/traefik/dynamic --providers.file.watch=true --certificatesresolvers.le.acme.httpchallenge=true --certificatesresolvers.le.acme.httpchallenge.entrypoint=web --certificatesresolvers.le.acme.storage=/acme/acme.json --accesslog=true --accesslog.format=json --accesslog.filepath=/var/log/traefik/access.log
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

# The network powder routes over (same rule as traefik-network.ts routingNetwork):
# the --providers.docker.network flag (from the inspect JSON, either form), the
# operator's declaration; else web. A setting in a mounted traefik.yml is only read
# by the dashboard. A network Traefik is merely attached to is reported (TATT_PICK:
# web when it is one of them, else the first by name, leaving out bridge/host/none,
# internal networks and networks of another compose project), never used.
valid_net() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; }
net_exists() { # name
	case "$1" in
	web | internal) [ "$(get "net_$1")" = present ] ;;
	*) case " $(get docker_networks) " in *" $1:"*) return 0 ;; *) return 1 ;; esac ;;
	esac
}
TRAEFIK="$(get traefik)"
TATT="$(get traefik_networks)"
net_field() { # name field (2 internal, 3 compose project) from docker_networks
	for _t in $(get docker_networks); do case "$_t" in "$1":*) printf '%s' "$_t" | cut -d: -f"$2"; return ;; esac; done
}
# The static config file the traefik container mounts, found the way the dashboard
# finds it (traefikConfigHostPath): the --configFile argument, else a mount at exactly
# /etc/traefik/traefik.yml, .yaml or .toml, else a mounted /etc/traefik folder
# (traefik.yml in it). Mount objects are read from the inspect JSON (flat objects
# with a Destination); the host path is the longest mount covering the file.
_flat=$(printf '%s' "$INSPECT" | tr -d '\n')
cfg_mounts() {
	printf '%s' "$_flat" | grep -oE '\{[^{}]*"Destination": *"[^"]*"[^{}]*\}' | while IFS= read -r _m; do
		_s=$(printf '%s' "$_m" | sed -n 's/.*"Source": *"\([^"]*\)".*/\1/p')
		_d=$(printf '%s' "$_m" | sed -n 's/.*"Destination": *"\([^"]*\)".*/\1/p')
		[ -n "$_s" ] && [ -n "$_d" ] && printf '%s\t%s\n' "${_d%/}" "${_s%/}"
	done
}
cfg_host_of() { # container path -> host path, or nothing
	_best=; _bsrc=
	while IFS="$(printf '\t')" read -r _d _s; do
		[ -n "$_d" ] || continue
		case "$1" in "$_d" | "$_d"/*) [ "${#_d}" -gt "${#_best}" ] && { _best=$_d; _bsrc=$_s; } ;; esac
	done <<EOF
$(cfg_mounts)
EOF
	[ -n "$_best" ] && printf '%s%s' "$_bsrc" "${1#"$_best"}"
}
cfg_exact_mount() { # container path mounted at exactly that path -> host path
	while IFS="$(printf '\t')" read -r _d _s; do [ "$_d" = "$1" ] && { printf '%s' "$_s"; return; }; done <<EOF
$(cfg_mounts)
EOF
}
# providers.docker.network from that file, read only in a form that leaves no doubt.
# Prints net=<name>, none (the file never says "network") or unsure (anything else:
# anchors, aliases, merge keys, tags, tab indentation, nested flow mappings, a
# repeated key, a quoted key, a value it cannot read). Keys case-insensitive, like
# the dashboard. The dashboard's YAML/TOML parser stays the authority.
cfg_docker_network() { # file
	case "$1" in
	*.toml | *.TOML) awk '
		{ l = $0; sub(/\r$/, "", l); if (tolower(l) ~ /network/) hasnet = 1 }
		l ~ /^[ ]*(#|$)/ { next }
		{ if (l ~ /[ ]#/) { if (l ~ /#[^"'\'']*["'\'']/) bad = 1; else sub(/[ ]+#.*$/, "", l) }; sub(/^[ ]+/, "", l); sub(/[ ]+$/, "", l) }
		l ~ /^\[\[/ { tbl = "#array"; next }
		l ~ /^\[/ { if (l ~ /^\[[ ]*[A-Za-z0-9_.-]+[ ]*\]$/) { t = l; gsub(/[][ ]/, "", t); tbl = tolower(t); if (tbl == "providers.docker") nd++ } else tbl = "?"; next }
		tbl == "providers.docker" && tolower(l) ~ /^network[ ]*=/ {
			v = l; sub(/^[^=]*=[ ]*/, "", v)
			if (v ~ /^"[A-Za-z0-9][A-Za-z0-9_.-]*"$/ || v ~ /^'\''[A-Za-z0-9][A-Za-z0-9_.-]*'\''$/) { n++; found = substr(v, 2, length(v) - 2) } else bad = 1
		}
		END { if (bad || n > 1 || nd > 1) print "unsure"; else if (n == 1) print "net=" found; else if (hasnet) print "unsure"; else print "none" }
	' "$1" ;;
	*) awk '
		function ind(s) { match(s, /^ */); return RLENGTH }
		function setnet(v) { sub(/^[ ]+/, "", v); sub(/[ ]+$/, "", v); if (v ~ /^"[A-Za-z0-9][A-Za-z0-9_.-]*"$/ || v ~ /^'\''[A-Za-z0-9][A-Za-z0-9_.-]*'\''$/) v = substr(v, 2, length(v) - 2); if (v ~ /^[A-Za-z0-9][A-Za-z0-9_.-]*$/) { n++; found = v } else bad = 1 }
		{ l = $0; sub(/\r$/, "", l); if (tolower(l) ~ /network/) hasnet = 1 }
		l ~ /^[ ]*(#|$)/ { next }
		l ~ /^(---|\.\.\.)/ { if (docs++) bad = 1; next }
		l ~ /^[ ]*\t/ || l ~ /<<[ ]*:/ || l ~ /(^|[ :,[{-])[&*!][A-Za-z0-9_!<-]/ { bad = 1 }
		{ if (l ~ /[ ]#/) { if (l ~ /["'\'']/) bad = 1; else sub(/[ ]+#.*$/, "", l) } }
		{ i = ind(l); t = substr(l, i + 1); sub(/[ ]+$/, "", t) }
		!match(t, /^[A-Za-z0-9_.-]+[ ]*:([ ]|$)/) { if (t ~ /^["'\'']/) bad = 1; next }
		{ k = tolower(substr(t, 1, RLENGTH)); sub(/[ ]*:[ ]*$/, "", k); v = substr(t, RLENGTH + 1); sub(/^[ ]+/, "", v) }
		i == 0 { st = 0; if (k == "providers") { np++; if (v == "") { st = 1; ci = -1 } else if (tolower(v) ~ /network/) bad = 1 }; next }
		st == 0 { next }
		ci < 0 { ci = i }
		i < ci { bad = 1; next }
		i == ci {
			st = 1
			if (k != "docker") next
			nd++
			if (v == "") { st = 2; gi = -1; next }
			if (v ~ /^\{.*\}$/) {
				in_ = substr(v, 2, length(v) - 2)
				if (in_ ~ /[][{}]/) { bad = 1; next }
				c = split(in_, kv, ",")
				for (j = 1; j <= c; j++) { p = kv[j]; sub(/^[ ]+/, "", p); if (tolower(p) ~ /^network[ ]*:/) { sub(/^[^:]*:/, "", p); setnet(p) } }
				next
			}
			if (v ~ /^[{[]/ || tolower(v) ~ /network/) bad = 1
			next
		}
		st == 2 {
			if (gi < 0) gi = i
			if (i < gi) { bad = 1; next }
			if (i == gi && k == "network") setnet(v)
		}
		END { if (bad || np > 1 || nd > 1 || n > 1) print "unsure"; else if (n == 1) print "net=" found; else if (hasnet) print "unsure"; else print "none" }
	' "$1" ;;
	esac
}
TNET=web
TNET_WHY=
TATT_PICK=
# a mounted config the script could not read with certainty: the network items are
# informational for this run and no attach or create advice is given (CFG_UNSURE)
CFG_FILE=
CFG_UNSURE=
TPROJ="$(get traefik_project)"
if [ "$TRAEFIK" != absent ]; then
	_flag=$(printf '%s\n' "$INSPECT" | awk '
		take { if (match($0, /"[^"]*"/)) { v = substr($0, RSTART + 1, RLENGTH - 2); if (v !~ /^-/) { print v; exit } } take = 0; next }
		match($0, /"--?providers\.docker\.network=[^"]*"/) { v = substr($0, RSTART + 1, RLENGTH - 2); sub(/^--?providers\.docker\.network=/, "", v); print v; exit }
		/"--?providers\.docker\.network"/ { take = 1 }
	')
	_cfgnet=
	if ! valid_net "$_flag"; then
		_cf=$(printf '%s\n' "$INSPECT" | awk '
			take { if (match($0, /"[^"]*"/)) { v = substr($0, RSTART + 1, RLENGTH - 2); if (v !~ /^-/) { print v; exit } } take = 0; next }
			match($0, /"--?config[Ff]ile=[^"]*"/) { v = substr($0, RSTART + 1, RLENGTH - 2); sub(/^--?config[Ff]ile=/, "", v); print v; exit }
			/"--?config[Ff]ile"/ { take = 1 }
		')
		if [ -n "$_cf" ]; then
			CFG_FILE=$(cfg_host_of "$_cf")
			[ -n "$CFG_FILE" ] || { CFG_FILE="$_cf (inside the container)"; CFG_UNSURE=1; }
		else
			for _e in yml yaml toml; do
				CFG_FILE=$(cfg_exact_mount "/etc/traefik/traefik.$_e")
				[ -n "$CFG_FILE" ] && break
			done
			if [ -z "$CFG_FILE" ]; then
				# a mounted /etc/traefik folder: traefik.yml in it, as the dashboard reads
				_dir=$(cfg_host_of /etc/traefik/traefik.yml)
				if [ -n "$_dir" ]; then
					if [ -e "$_dir" ]; then CFG_FILE=$_dir
					else for _e in yaml toml; do [ -e "${_dir%.yml}.$_e" ] && { CFG_FILE="${_dir%.yml}.$_e"; CFG_UNSURE=1; }; done; fi
				fi
			fi
		fi
		if [ -n "$CFG_FILE" ] && [ -z "$CFG_UNSURE" ]; then
			if [ -r "$CFG_FILE" ] && [ -f "$CFG_FILE" ]; then
				case "$(cfg_docker_network "$CFG_FILE" 2>/dev/null)" in
				net=*) _cfgnet=$(cfg_docker_network "$CFG_FILE" 2>/dev/null); _cfgnet=${_cfgnet#net=}; valid_net "$_cfgnet" || { _cfgnet=; CFG_UNSURE=1; } ;;
				none) ;;
				*) CFG_UNSURE=1 ;;
				esac
			else
				CFG_UNSURE=1
			fi
		fi
	fi
	if valid_net "$_flag"; then
		TNET=$_flag
		TNET_WHY="its --providers.docker.network=$_flag flag"
	elif [ -n "$_cfgnet" ]; then
		TNET=$_cfgnet
		TNET_WHY="providers.docker.network in $CFG_FILE"
	elif [ -n "$CFG_UNSURE" ]; then
		:
	else
		_cands=
		for n in $TATT; do
			valid_net "$n" || continue
			case "$n" in bridge | host | none) continue ;; esac
			[ "$(net_field "$n" 2)" = true ] && continue
			_np="$(net_field "$n" 3)"
			[ -n "$_np" ] && [ "$_np" != "$TPROJ" ] && continue
			_cands="$_cands $n"
		done
		case " $_cands " in
		*" web "*) _pick=web ;;
		*) _pick=$(printf '%s\n' $_cands | LC_ALL=C sort | head -n1) ;;
		esac
		TATT_PICK=$_pick
	fi
fi

echo "server check ($(hostname 2>/dev/null || echo '?'), proxy $PROXY)"
case "$(get docker)" in
present) req ok 'Docker engine' "version $(get docker_version)" ;;
unreachable) req missing 'Docker engine' 'installed, daemon not reachable for this user' ;;
*) req missing 'Docker engine' 'not installed' ;;
esac
[ "$(get compose)" = present ] && req ok 'docker compose plugin' installed || req missing 'docker compose plugin' 'not installed'
# The Traefik network: required on traefik servers (Traefik routes over it); web is
# then an info line when it is another network. Elsewhere web is an info line, the
# new-app flow creates it. internal: optional, an info line. Same rule and text as checkItems().
if [ "$PROXY" = traefik ] && [ -n "$CFG_UNSURE" ]; then
	line info 'traefik config' "a static config file is mounted ($CFG_FILE) that only the dashboard reads fully: its check names the network powder routes over here; this run gives no network advice"
	line info 'network web' "$( [ "$(get net_web)" = present ] && echo exists || echo 'not created' ); not judged here (see traefik config)"
elif [ "$PROXY" = traefik ]; then
	if net_exists "$TNET"; then
		if [ -n "$TNET_WHY" ]; then req ok "network $TNET" "exists; Traefik routes over it ($TNET_WHY)"; else req ok "network $TNET" exists; fi
	elif [ "$TNET" = web ]; then req missing 'network web' 'missing: Traefik and the apps, previews and snapshots it routes run on it'
	else req missing "network $TNET" "missing: Traefik routes over $TNET, and the apps, previews and snapshots powder starts here join it"; fi
	if [ "$TNET" != web ]; then
		if [ "$(get net_web)" = present ]; then line info 'network web' "exists; not used for routing here: Traefik routes over $TNET"
		else line info 'network web' "not needed: Traefik here routes over $TNET, and the apps, previews and snapshots powder starts here join $TNET"; fi
	fi
	if [ -n "$TATT_PICK" ] && [ "$TATT_PICK" != web ] && [ "$TNET" = web ]; then
		line info 'traefik networks' "traefik is attached to $TATT_PICK; set providers.docker.network to let powder route apps over it (until then powder uses web)"
	fi
elif [ "$(get net_web)" = present ]; then req ok 'network web' exists
else line info 'network web' 'not created: powder creates it when the first app is created here at /new'; fi
[ "$(get net_internal)" = present ] && req ok 'network internal' exists || line info 'network internal' 'not created: optional, only apps created with "join the shared internal network" use it, and powder creates it for the first one'
case "$TRAEFIK" in
running) treq ok 'traefik container' running ;;
stopped) treq missing 'traefik container' 'exists but is stopped (not started or changed here)' ;;
*) treq missing 'traefik container' 'no container named traefik' ;;
esac
# File provider pieces: required on traefik servers only with --redirects yes.
rreq() {
	if [ "$PROXY" != traefik ] || [ "$REDIRECTS" = yes ] || [ "$1" = ok ]; then treq "$@"; else line info "$2" "$4"; fi
}
if [ "$TRAEFIK" != absent ] && [ "$PROXY" = traefik ] && [ -z "$CFG_UNSURE" ]; then
	if [ -z "$TATT" ]; then line info "traefik on $TNET" 'could not read the networks of the traefik container'
	else
		case " $TATT " in
		*" $TNET "*) req ok "traefik on $TNET" attached ;;
		*) req missing "traefik on $TNET" "missing: the traefik container is not attached to $TNET, so it cannot reach what powder starts there (connect it by hand: docker network connect $TNET traefik; powder never changes an existing Traefik)" ;;
		esac
	fi
fi
if [ "$TRAEFIK" != absent ]; then
	# Best effort: the dashboard parses the inspect JSON properly (and reads a
	# mounted traefik.yml); here we look for the flag and a mount of $DYN.
	if printf '%s' "$INSPECT" | grep -q 'providers.file.directory' &&
		printf '%s' "$INSPECT" | grep -q "\"Source\": \"$DYN\""; then
		treq ok 'traefik file provider' "watches $DYN"
	else
		rreq missing 'traefik file provider' "missing: domain redirects are set up on this server, and Traefik needs a watched file provider on $DYN to serve them (a traefik.yml config is only checked by the dashboard)" "not found in its flags: no file provider on $DYN in the traefik flags (a traefik.yml config is only checked by the dashboard); with --redirects no nothing here needs it, and domain redirects stay unavailable until Traefik has a watched file provider on $DYN"
	fi
fi
[ "$(get apps_dir)" = present ] && req ok /opt/apps exists || req missing /opt/apps missing
[ "$(get dynamic_dir)" = present ] && treq ok "$DYN" exists || rreq missing "$DYN" 'missing: domain redirects are set up on this server, and powder writes their Traefik rules here' 'not created: only domain redirects use it, and none is set up on this server; they stay unavailable here until Traefik has a file provider on it'
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
PRUNE_OTHER="$(get prune_cron_other)"
if [ -n "$PRUNE_OTHER" ]; then
	# another cron file already runs it: handled there, or twice with powder's own file
	case "$(get prune_cron)" in
	current | different) line warn 'image prune cron' "/etc/cron.d/powder-image-prune and /etc/$PRUNE_OTHER both run powder-image-prune; remove one of them by hand" ;;
	*) line ok 'image prune cron' "/etc/$PRUNE_OTHER already runs powder-image-prune; handled there, left alone (powder adds no second line)" ;;
	esac
else
	case "$(get prune_cron)" in
	current) line ok 'image prune cron' '/etc/cron.d/powder-image-prune: hourly at :17' ;;
	absent) line warn 'image prune cron' '/etc/cron.d/powder-image-prune missing: powder-image-prune never runs (--apply adds it)' ;;
	no-crond) line warn 'image prune cron' "no /etc/cron.d on this server: add this line to /etc/crontab by hand: $PRUNE_CRON_LINE" ;;
	*) line info 'image prune cron' "/etc/cron.d/powder-image-prune has other content; left as is. powder's line: $PRUNE_CRON_LINE" ;;
	esac
fi
LR_OTHER="$(get traefik_logrotate_other)"
if [ "$PROXY" = traefik ] && [ -n "$LR_OTHER" ] && [ "$(get traefik_logrotate)" != no-logrotate ]; then
	case "$(get traefik_logrotate)" in
	absent) line ok 'traefik log rotation' "/etc/logrotate.d/$LR_OTHER already rotates /var/log/traefik; handled there, left alone (powder adds no second file)" ;;
	*) line warn 'traefik log rotation' "/etc/logrotate.d/powder-traefik and /etc/logrotate.d/$LR_OTHER both rotate /var/log/traefik: logrotate reports a duplicate entry and exits non-zero; remove one of them by hand" ;;
	esac
elif [ "$PROXY" = traefik ]; then
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
	[ "$(get dynamic_dir)" = absent ] && [ "$PROXY" = traefik ] && [ "$REDIRECTS" = yes ] && STEPS+=(mkdir_dynamic)
	if [ "$DOCKER" != unreachable ]; then
		# the routing network (Traefik's on traefik servers, else web), then internal
		_route=web; [ "$PROXY" = traefik ] && _route=$TNET
		# the routing network is unknown here: create nothing for it
		[ "$PROXY" = traefik ] && [ -n "$CFG_UNSURE" ] && { _route=; SKIPPED+=('traefik-network: a mounted Traefik config only the dashboard reads names the routing network; run the check from the dashboard'); }
		for n in "$_route" internal; do
			[ -n "$n" ] || continue
			[ "$n" = internal ] && [ "$_route" = internal ] && continue
			if ! net_exists "$n" || [ "$DOCKER" = absent ]; then
				case "$n" in web | internal) STEPS+=("network_$n") ;; *) STEPS+=(network_traefik) ;; esac
			fi
		done
	fi
	if [ "$PROXY" = traefik ] && [ "$TRAEFIK" != absent ] && [ -n "$TATT" ] && [ -z "$CFG_UNSURE" ]; then
		case " $TATT " in *" $TNET "*) ;; *) SKIPPED+=("traefik-network: attach Traefik to $TNET by hand (docker network connect $TNET traefik); powder never changes an existing Traefik") ;; esac
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
		if [ -n "$PRUNE_OTHER" ]; then :
		elif [ "$(get helper_image_prune)" = present ] || [[ " ${STEPS[*]-} " == *" install_powder_image_prune "* ]]; then STEPS+=(install_image_prune_cron)
		else SKIPPED+=('image-prune-cron: powder-image-prune is not installed; install it first'); fi
		;;
	no-crond) [ -n "$PRUNE_OTHER" ] || SKIPPED+=("image-prune-cron: no /etc/cron.d on this server; add to /etc/crontab: $PRUNE_CRON_LINE") ;;
	esac
	# Traefik's access log rotation, on traefik servers only (same as planApply()).
	if [ "$PROXY" = traefik ]; then
		case "$(get traefik_logrotate)" in
		absent) [ -n "$LR_OTHER" ] || STEPS+=(install_traefik_logrotate) ;;
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
