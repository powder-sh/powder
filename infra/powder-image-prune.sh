#!/bin/bash
# powder-image-prune - hourly disk reclaim that PRESERVES rollback targets.
#
# Build-on-server images exist nowhere else (no registry copy), so the `:deploy-*`
# tags powder rolls back to are the only rollback path for an app; a plain age-based
# `docker image prune -a` would delete them.
#
# Keeps: images used by any container (running or stopped) and the `:deploy-*`
# tags of the newest $KEEP_DEPLOY_TAGS distinct IMAGES per repository (the
# rollback targets). powder tags an image `:deploy-*` only
# AFTER the deploy passed its health gate, so every such tag is a known-good
# image and failed deploys never occupy (or evict) rollback slots. Counting
# distinct image IDs rather than tags keeps no-change redeploys (same image,
# several tags) from crowding out genuinely older good versions.
# Deploy tags BEYOND the newest $KEEP are removed regardless of age: see the
# high-churn note at the loop. Non-deploy unreferenced tags keep a 7-day age
# grace. Then dangling layers are reclaimed and build cache is capped at
# $MAX_BUILD_CACHE (LRU eviction, see below).
# Last, dangling anonymous volumes created more than $ANON_VOLUME_MAX_AGE_DAYS days ago
# (default 7) are removed; named volumes never are.
#
# Build cache is capped by SIZE, not age. On servers that build images the cache
# regenerates faster than a 7-day age filter can ever reclaim it: on a server with
# many deploys a day every cache entry stays younger than an until=168h filter,
# so the cache can grow to half the disk and stay there. A size cap keeps
# disk bounded regardless of deploy rate while preserving warm-build speed up
# to the cap. Runs hourly so a burst of deploys cannot outgrow the cap. It can
# also be run by hand or by an external disk monitor.
# The cap scales with the disk: 20 GB, or 10 GB when / is under 200 GB
# (MAX_BUILD_CACHE overrides). The flag was renamed --keep-storage -> --max-used-space in docker
# 28+, so try the new name, then the old, then fall back to the age filter.
#
# bin/server-bootstrap.sh installs it and this cron file when they are absent (so do
# bin/install.sh and "fix missing pieces" in the dashboard). By hand:
#   install -m 755 infra/powder-image-prune.sh /usr/local/bin/powder-image-prune
#   echo '17 * * * * root /usr/local/bin/powder-image-prune >> /var/log/powder-image-prune.log 2>&1' > /etc/cron.d/powder-image-prune
# Settings (environment, e.g. in the cron line): KEEP_DEPLOY_TAGS (3), MAX_BUILD_CACHE,
# ANON_VOLUME_MAX_AGE_DAYS (7, whole days). Each is a whole number of up to 6 digits.
set -uo pipefail
KEEP="${KEEP_DEPLOY_TAGS:-3}"
# A value that is not a whole number would fail the `-lt` test below and remove every
# rollback tag, so it falls back to the default. So does one longer than 6 digits:
# bash arithmetic wraps past 2^63, a huge KEEP turns negative (every rollback tag
# removed) and a huge day count overflows the volume cutoff.
case "$KEEP" in ''|*[!0-9]*|???????*) echo "$(date -u +%FT%TZ) image-prune: KEEP_DEPLOY_TAGS='$KEEP' is not a whole number of up to 6 digits, using 3"; KEEP=3 ;; esac
VOL_DAYS="${ANON_VOLUME_MAX_AGE_DAYS:-7}"
case "$VOL_DAYS" in ''|*[!0-9]*|???????*) echo "$(date -u +%FT%TZ) image-prune: ANON_VOLUME_MAX_AGE_DAYS='$VOL_DAYS' is not a whole number of days of up to 6 digits, using 7"; VOL_DAYS=7 ;; esac
# base 10: $(( )) reads a leading zero as octal (08 is an error, 010 is 8)
KEEP=$((10#$KEEP)); VOL_DAYS=$((10#$VOL_DAYS))
# Build-cache cap scales with the root filesystem: 10GB on disks under 200 GB, else 20GB.
ROOT_GB=$(df -BG --output=size / 2>/dev/null | awk 'NR==2{gsub(/G/,"",$1); print $1+0}')
if [ "${ROOT_GB:-0}" -gt 0 ] && [ "$ROOT_GB" -lt 200 ]; then DEFAULT_CAP=10GB; else DEFAULT_CAP=20GB; fi
CACHE_CAP="${MAX_BUILD_CACHE:-$DEFAULT_CAP}"
# A running image pull/build/start (a docker CLI process younger than an hour):
# the dangling-image prune below must not run then (it can delete layers being
# unpacked). Wait up to 2 min BEFORE taking the lock, so
# post-deploy prunes are not held up by our wait. Same check as
# apps/web/src/lib/deploy/prune-lock.ts (a test keeps them equal).
image_busy() { ps -C docker,docker-compose,docker-buildx -o etimes=,args= 2>/dev/null | awk -v max=3600 -v re='(^|/)docker(-compose|-buildx)?( (image|container|buildx))? (pull|run|create|build|bake|load|import|up)( |$)|compose .*(pull|run|create|build|up)( |$)' '$1 < max { $1 = ""; sub(/^ +/, ""); if ($0 ~ re) f = 1 } END { exit !f }'; }
W=0; while [ "$W" -lt 120 ] && image_busy; do sleep 5; W=$((W+5)); done
# One run at a time (hourly cron vs a self-heal run over ssh). The lock lives in /run,
# which only root can write (the cron runs as root); a run that cannot open it (not
# root) goes on without the lock, like the post-deploy prunes of a non-root ssh user.
if { exec 9>/run/powder-image-prune.lock; } 2>/dev/null; then
  flock -n 9 || { echo "$(date -u +%FT%TZ) image-prune: already running, skipped"; exit 0; }
else
  echo "$(date -u +%FT%TZ) image-prune: cannot open /run/powder-image-prune.lock (not root?), running without the lock"
fi
CUTOFF=$(( $(date +%s) - 7*24*3600 ))

USED=$(docker ps -a --format '{{.Image}}' | sort -u)

# docker images lists newest-first, so per-repo image rank == recency rank.
removed=0 kept_deploy=0
declare -A DEPLOY_SEEN DEPLOY_IDS
while IFS='|' read -r ref created id; do
  [ -z "$ref" ] && continue
  case "$ref" in *"<none>"*) continue ;; esac           # dangling — prune handles
  if printf '%s\n' "$USED" | grep -qxF "$ref"; then continue; fi
  repo="${ref%:*}" tag="${ref##*:}"
  if [[ "$tag" == deploy-* ]]; then
    ids="${DEPLOY_IDS[$repo]:-}"
    if [[ " $ids " == *" $id "* ]]; then kept_deploy=$((kept_deploy+1)); continue; fi
    n="${DEPLOY_SEEN[$repo]:-0}"
    if [ "$n" -lt "$KEEP" ]; then
      DEPLOY_SEEN[$repo]=$((n+1)); DEPLOY_IDS[$repo]="$ids $id"; kept_deploy=$((kept_deploy+1)); continue
    fi
    # Beyond the newest $KEEP rollback tags: remove regardless of age. On a
    # high-churn server that builds images, every `:deploy-*` tag is younger than the
    # 7-day cutoff, so gating removal on age would reclaim nothing and tags
    # would pile up without bound. Same reasoning as the build-cache size cap;
    # rollback only needs the newest $KEEP.
    docker rmi "$ref" >/dev/null 2>&1 && removed=$((removed+1)) || true
    continue
  fi
  # Non-deploy unreferenced tag (e.g. an orphaned :latest): keep the 7-day age
  # grace so an image mid-rollout isn't yanked out from under a container. An
  # unreadable date keeps the image (same as the volume loop below).
  epoch=$(date -d "${created% UTC}" +%s 2>/dev/null) || continue
  case "$epoch" in ''|*[!0-9]*) continue ;; esac
  if [ "$epoch" -ge "$CUTOFF" ]; then continue; fi
  docker rmi "$ref" >/dev/null 2>&1 && removed=$((removed+1)) || true
done < <(docker images --format '{{.Repository}}:{{.Tag}}|{{.CreatedAt}}|{{.ID}}')

# Dangling-image prune only while no image pull/build/start is running: on the
# containerd image store it can delete the layers of an image being unpacked
# right then. Waits up to 2 min, then skips just this
# step. The wait runs before the lock (top of the script), this is the re-check.
if image_busy; then echo "$(date -u +%FT%TZ) image-prune: an image pull/build is in progress, dangling-image prune skipped"
else docker image prune -f >/dev/null 2>&1 || true; fi
# Build cache: same busy gate. BuildKit can fail a running build whose parent
# snapshot a prune removes; the next hourly run reclaims what this one skips.
if image_busy; then echo "$(date -u +%FT%TZ) image-prune: a build is in progress, build cache prune skipped"
else
  docker builder prune -af --max-used-space "$CACHE_CAP" >/dev/null 2>&1 \
    || docker builder prune -af --keep-storage "$CACHE_CAP" >/dev/null 2>&1 \
    || docker builder prune -af --filter "until=168h" >/dev/null 2>&1 || true
fi

# Dangling ANONYMOUS volumes only (label com.docker.volume.anonymous, set by docker 23+ on
# every unnamed VOLUME, e.g. a postgres image's data dir), and only once they are older
# than $VOL_DAYS days. A container removed without -v (`docker rm`, `compose down`, an
# app deleted in the dashboard) leaves its anonymous volume behind; the age grace gives
# time to notice and copy data out before it goes. Named volumes (real data, even when
# no container uses them) never carry that label and are never removed here; never pass
# --all, and never `volume prune` (it has no age filter for volumes).
# `docker volume rm` without -f refuses a volume a container still uses.
# Same busy gate as the image prune: a container being created right now is not raced.
VOL_CUTOFF=$(( $(date +%s) - VOL_DAYS*24*3600 ))
vol_removed=0 vol_young=0
if image_busy; then echo "$(date -u +%FT%TZ) image-prune: a container start is in progress, anonymous-volume prune skipped"
else
  while IFS= read -r vol; do
    [ -n "$vol" ] || continue
    vcreated=$(docker volume inspect -f '{{.CreatedAt}}' "$vol" 2>/dev/null) || continue
    # an unreadable date keeps the volume
    vepoch=$(date -d "$vcreated" +%s 2>/dev/null) || { vol_young=$((vol_young+1)); continue; }
    case "$vepoch" in ''|*[!0-9]*) vol_young=$((vol_young+1)); continue ;; esac
    if [ "$vepoch" -ge "$VOL_CUTOFF" ]; then vol_young=$((vol_young+1)); continue; fi
    docker volume rm "$vol" >/dev/null 2>&1 && vol_removed=$((vol_removed+1)) || true
  done < <(docker volume ls -q --filter dangling=true --filter label=com.docker.volume.anonymous 2>/dev/null)
fi

cache_now=$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | awk '/Build Cache/{print $3}')
echo "$(date -u +%FT%TZ) image-prune: removed $removed old tags, protected $kept_deploy rollback tags (newest $KEEP images per app), build cache ${cache_now:-?} (cap $CACHE_CAP), removed $vol_removed dangling anonymous volumes older than $VOL_DAYS days (kept $vol_young younger), disk free: $(df -h / | awk 'NR==2{print $4}')"
