# Compose safety check

powder runs every app's compose file as root on a shared server. One authority decides what a compose file may do: `apps/web/src/lib/compose-safety.ts`.

## Where it runs

- `/new` and every powder-written override (`compose-guard.ts`): on the YAML powder
  renders, parsed with YAML merge keys applied (`<<: *anchor` cannot hide a key).
- Every deploy, every layout (src/, workdir, previews; not powder's own
  self-deploy): `deploy/compose-check.ts` reads `docker compose config --format json`
  (merges, include, extends, interpolation resolved) plus `--no-interpolate` (it keeps
  the env_file paths), and the other containers on the server, then runs the authority.
  The deploy script pins the sha256 of those outputs and refuses if it changes after
  the git sync or before `compose up` (one automatic re-check, for a legit change such
  as a tracked `.env` value).
- Every recreate outside a deploy: container apply, domain apply, rollback,
  auto-rollback, snapshot rollback (`lib/recreate-guard.ts`). See "Recreates" below.

## Profiles: every service is seen

compose leaves a service whose profile is not active out of `docker compose config`,
but `up --no-deps <service>` starts it by name (the deploy's targets, rollbacks, domain
and container apply all name services). So:

- every `docker compose ... config` powder runs on an app's compose (the probe, the
  full and structural hashes, `--services` / `--images` listings, the env file and bind
  guards, the Dockerfile check, the override writer, the infra detection) passes
  `--profile '*'` (`ALL_PROFILES` in deploy/compose-hash.ts). For a compose without
  profiles the output is the same as without the flag, so stored hashes stay valid.
  powder's own self-deploy compose keeps its calls;
- `profiles` is a refused service key (code `profiles`, high, never exemptable);
- a service the `--no-interpolate` config has and the resolved one lacks is copied into
  the checked config (every rule runs on it), is a `profiles` finding, and is refused by
  the deploy check in every mode (`unresolvedServicesOf`, compose-check.ts);
- on the server, in every mode, `composeProfileGuardShell` (part of
  `onServerComposeGuardShell`: the compose check probe, the deploy's `el_guard` before the
  first `config` and every `up`, and `composeUpCommand` for every recreate) refuses when
  `config --services` differs from `--profile '*' config --services`, or when only one
  of the two listings can be read (a service that depends on a profiled one fails the
  plain listing). Both failing passes: the compose does not parse and the next compose
  step fails with compose's own error.

## Recreates

A compose a deploy refused can stay on disk (the workdir layout, an app with no
successful commit to reset to). Every path that recreates the container without a
deploy first runs the SAME decision as the deploy (`checkComposeForRecreate` calls `checkComposeForDeploy`: same
probe, server mode, exemptions, other apps, route hosts), with "approved hash" = the
`compose_config_hash` of the app's last successful deploy, after anything that changes
the config (env snapshot restore, the domain override write) and right before the `up`:

- enforce mode: any finding refuses the recreate;
- warn mode, structural hash equal to the approved one: warn lines, the recreate runs;
- warn mode, hash differs: the high-severity codes refuse the recreate;
- warn mode, no approved hash recorded yet (no successful deploy stored one): warn lines
  only, the recreate runs. That is what a deploy does without a stored hash, and that deploy's hash becomes the baseline.
- an unreadable probe: enforce refuses, warn recreates unchecked with a `WARN <app>
  probe ... UNCHECKED` line in the deploy log and in powder's own log.

The full config hash the check saw is pinned in `composeUpCommand` (which needs the
approval to build its command): the `up` is refused when the config moved in between. A
preview container is checked with exactly the preview deploy's context
(`previewGuardContext` in lib/preview-deploys.ts, shared by both: its URL host and live
preview domains may be routed, it reads `/opt/apps/<parent>.preview.env`, no stored
approval), for domain apply, container apply and rollback alike. A sidecar container
(no app_repos or preview row of its own) is checked as the app or preview whose compose
project it is in; a container no app owns has no deploy decision to repeat and keeps
only the on-server link guards. A recreate never stores a compose hash.

After a refusal, `src/` is reset to the last successful commit. In the
workdir layout every compose file the app runs with that the repo tracks, other
than the server-local `docker-compose.yml` (preserved by the sync, never the repo's), is
written back to its content at the last successful commit, and the log names it.

## include and extends: refused in every mode

A compose `include:` entry can carry its own `env_file:` or `project_directory:`. compose
then interpolates the included file with another app's env file, so its secrets land in
`environment` while the resolved config shows no include block and no foreign env_file
path. `extends:` with a `file:` pulls a service out of another app's compose. powder refuses
both outright: not a rule code, not warn-able, not
exemptable.

The check reads the RAW text of every `-f` file of the project (the user's files and
powder's override), before any `docker compose config` runs: the resolved config has
already read the included files by then. It runs as part of the env file guard
(preflight, before the release, before the swap, before every `compose up` attempt,
rollbacks, domain and container apply, the compose guard probe) and before every
`readComposeConfig` (override writer, builder, domain apply). Including is refused, so
there is nothing to recurse into.

Why a strict line check and not a YAML parser: the files live on the app's server, and a
second parser on the server or in powder could read a document differently from compose
(that difference is the attack). The check instead accepts single-line YAML only, where
every line is self-contained, and refuses every form that could produce an `include`
root key or an `extends` key without spelling it out.

- Backstops on the raw line, before any parsing, in every file (powder's own included):
  the words `extends` and `include` in any case anywhere (a comment or a value too), the
  escapes `\x`, `\u`, `\U`, `\N`, `\_`, `\L`, `\P`, a carriage return inside a line and
  any control character but tab. powder.json
  entries that would put them in a label (an HSTS `includeSubDomains` header, for
  example) are dropped with a warning when powder builds its labels, and a new app name
  may not contain the words.
- Single-line YAML: every non-blank, non-comment line must be `key:`, `key: value`,
  `- ...` or `---`. Refused, naming the line: a block scalar (`key: |`, `key: >`,
  `- |`, any indicators or comment), a quoted string that does not close on its own line
  ("a quoted string spanning lines is not supported"), a flow collection (`{` / `[`)
  that does not close on its own line, a plain value continued on the next line, a merge
  key (`<<`), an explicit `?` key, an anchor (`&a`), an alias (`*a`), and any YAML tag.
  In a flow collection a quoted node may only start after `{`, `[`, `,` or `: `; any
  other quote there is refused ("a quote inside a plain scalar"). A quote inside a
  block-context plain value (`command: sh -c "node server.js"`) is fine: that value ends
  with its line, and continuations are refused. A line indented deeper than
  the key (or the dash) of a value on the line above is refused as a continuation.
  The only tags allowed are `!override` and `!reset`, and only in a file powder generates
  itself: one under powder's compose state dir (`/var/lib/powder/compose/`, or
  `POWDER_COMPOSE_STATE_DIR`). That is decided by the `-f` path, never by the content,
  and a path with `//`, `/./` or `/../` never counts as generated.
- Root: every line that starts in column 0 must be a plain key (`services:`, `x-foo:`, a
  simply quoted `"volumes":`), `---`, a comment or blank; a flow-mapping root, an
  indented root or a `%` directive is refused, and the root key `include` is refused.
- Anywhere: the word `extends` used as a key, a double-quoted key with an escape
  (`"\x65xtends":`), an alias used as a key (`*k :`), an explicit `?` key, a binary tag
  (`!!binary`), and a lone CR, NEL, LS or PS line break. Because every line is
  self-contained, these rules skip a complete value on the line (a whole quoted string,
  or a plain one with no flow characters and no `: `) after a plain key or a sequence
  dash, so label and env values such as a Report-To JSON header or
  `connect-src wss://*.example.com:443` pass. Keys are still read as written.

The refusal names the file and line. Implementation: `COMPOSE_RAW_AWK` and
`composeRawGuardShell` in `apps/web/src/lib/deploy/fragments.ts`. powder's own
self-deploy overlays (`docker-compose.shared-db.yml`, `docker-compose.unharden.yml`, with
`!reset` / `!override`) are not app compose files and do not pass through this check.

## Env file guard: refused in every mode

`compose up` runs as root and reads every `env_file` / `label_file`. A container that can
write in a folder of the app dir could swap an env file (or a folder on its way) for a
link to `/opt/apps/<other>.env`. The env file guard (`envFileLinkGuardShell` in
`apps/web/src/lib/deploy/fragments.ts`) runs on the server wherever the include check runs
and refuses, in every mode:

- a path that is not made only of `[A-Za-z0-9._/-]`, not absolute, or has a `.` / `..`
  component. The paths come from `docker compose config --no-interpolate --format json`,
  never from YAML text (a YAML escape such as `"./x\ty.env"` would be read back wrong);
- below an app root (the compose working dir and `/opt/apps/<app>`), any path component
  that is a symlink. The roots are resolved with `readlink -f` first, so a link above them
  (on the powder server `/opt/apps` is a link to a volume) does not count. One exception: the
  final file may be a link whose `readlink -f` is the `readlink -f` of the app's own
  `/opt/apps/<app>.env` (e.g. `/opt/apps/<app>/.env -> /opt/apps/<app>.env`);
- outside the roots: a file that is a link to anything but the own env file or a file in
  the app dir, or a folder that reaches into the app dir through a link;
- an env / label file whose folder, or the folder of what it resolves to (both via
  `readlink -f`), is a folder a container can write, or inside one: the WRITABLE SET
  below. A process in that
  container could swap the file for a link between the check and compose reading it. The
  usual shape passes: `/opt/apps/<app>.env` sits in `/opt/apps`, which no app binds,
  even when the app binds `.:/app`. An app with `env_file: ./.env` AND a writable `.:/app`
  bind is refused: mount it `:ro` or move the env file to `/opt/apps/<app>.env`. A bind
  source built from a variable cannot be resolved from the uninterpolated config and is
  skipped there (a running container still reports it resolved).

### The writable set: one authority

"Which folders can a container write" is decided in one place, for every on-server guard
that compares a path with it: this env file guard (env_file / label_file) and the bind
guard below (mount sources, secrets / configs files, build paths). Shell:
`writableSetFnShell` (`pw_wset`) in `apps/web/src/lib/deploy/fragments.ts`; TypeScript
twin: `writableFoldersOf` in `compose-safety.ts`. The union of:

- (a) the config's writable service binds (not `:ro` / `read_only`);
- (b) the config's named volume `driver_opts.device` paths;
- (c) for every container of every compose project on the server, in any state (a sibling
  that is not recreated, an exited container that gets its mounts back on its next
  start): its writable bind sources AND the `device` option of every named volume it
  mounts writable. `docker inspect` shows such a mount as type `volume` with the
  volume's `_data` dir, so the volume is asked for its device (`docker volume inspect`).
  A container with no compose project label does not count;
- (d) the `device` of every named volume of the config that already exists on the server
  (compose keeps an existing volume as it is).

Any absolute `device` counts, whatever its `type` / `o` options say. Each path is
normalised like the bind guard's (a lexical prefix of the working dir, `/opt/apps/<app>`
or `/opt/apps` replaced by its `readlink -f`) and then resolved. A source built from a
variable is skipped in the env file guard (the uninterpolated config cannot resolve it;
a container reports it resolved); the bind guard reads it from the interpolated config.
Volumes count as well as binds: otherwise an old container mounting a volume bound to
`<app dir>/conf` would let a deploy read `./conf/x.env` after a swap.

The compose check refuses the same in TypeScript (code `env_file`, high): an env /
label file in a folder of `writableFoldersOf`, with part (c) from the probe's container
mounts (`docker inspect` `.Mounts` in the detail section) and the server volumes' devices.

Fail closed: when docker cannot list the containers or volumes, or read their
mounts or volume options (one retry, for a container removed in between), both guards
refuse with a message naming what failed, instead of reading "no container". The guard
test (`writable-set.test.ts`) runs both guards on the same server and asserts they get
the identical set, and that the TypeScript twin matches it.

The deploy script runs the guard in the preflight (before its first `compose config`),
before the release and the swap, and immediately before EVERY `compose up` attempt: the
infra `up --no-recreate`, the recreate, and each retry (also before a retry removes the
old container).

A missing env file (a missing `/opt/apps/<app>.env`, an optional one) passes; compose
decides what a missing file means.

## Bind and file path guard: refused in every mode

A container that can write a bind-mounted folder can plant a link there (`ln -sfn /
/data/r`); a later compose naming `.../data/r` would mount the host root. The bind guard
(`bindLinkGuardShell(cf, app, workingDir, appsBase = '/opt/apps')` in
`apps/web/src/lib/deploy/fragments.ts`) runs right after the env file guard, everywhere
that one runs (`onServerComposeGuardShell`: the compose check probe, the deploy script's
`el_guard`, and `composeUpCommand` for rollbacks, domain apply and manual apply). It reads
`docker compose config --no-interpolate --format json` (`COMPOSE_JSON_MOUNTS_AWK`): every
service bind source, build context, dockerfile and `additional_contexts` path, top-level
`secrets` / `configs` `file`, named-volume `driver_opts.device`, and build `cache_from` /
`cache_to` entries. A path built from a
variable is taken from the interpolated config instead (read only after the env file
guard passed). It refuses, in every mode:

- a compose project name other than the app name as compose writes a project name
  (lowercase, only `[a-z0-9_-]`; see "Ownership" below). Rollbacks, snapshot rollbacks,
  domain apply and the manual apply pass the app_repos container name; a recreate of a
  container with no app_repos row skips this one check;
- a path with a JSON escape or quote, a relative path, a `.` / `..` component;
- any local build cache: a `cache_from` / `cache_to` entry whose `type` is `local`
  in any case, or that has a `src=` / `dest=` key in any case (buildx lower-cases keys,
  so `TYPE=local,DEST=/etc/x` is a local cache). The build reads and writes that path as
  root. (The TS rules refuse every `cache_from` / `cache_to`, see the `build` code.)
- a bind source or driver device with any symlink component. Each path is first
  normalised: a lexical prefix of the working dir, `/opt/apps/<app>` or `/opt/apps` is
  replaced by its `readlink -f` (on the powder server `/opt/apps` is a link to a volume, which
  does not count). Then every component is walked from `/`; a missing component ends the
  walk (docker creates it), so a missing source passes;
- a build path or secret / config file through a symlink, except a link below the
  resolved app dir that resolves inside that same dir (a tracked in-repo
  `Dockerfile -> docker/Dockerfile`) and is not inside a writable bind. Such a
  link is followed one hop at a time and the walk goes on through its target, so
  every hop of a chain must pass the same test: a tracked `ctx -> data/c` with a
  planted `data/c -> ...` inside a writable `data` bind is refused at `data/c`;
- a build context, dockerfile or `additional_contexts` path whose resolved
  (`readlink -f`) path is AT or inside a writable bind (new config, or a container of
  any compose project on the server in any state). The build reads these paths later, as
  root: a container there could swap the folder, or one on its way, for a link to `/`
  after the check. A read-only bind over the context passes;
- a writable bind (new config, or a container of any compose project on the
  server in any state) whose resolved source is strictly INSIDE a build context or an
  additional context. BuildKit reads the context by path after this check, so a process
  in that container could swap a folder in there for a link and put host files into
  the image. A read-only bind inside the context passes (`./src/public:/x:ro`), and so
  does the `/new` layout's DB data: a writable bind of exactly `<build path>/pgdata` or
  `<build path>/kvdata` when the build path is the app dir itself, the app dir is the
  checkout (no `src/.git`), and `<app dir>/.dockerignore` is a regular file (not a
  link) with `pgdata/` and `kvdata/` lines that no later `!` line re-includes (powder
  writes them last). `pgdata` in any other build path is refused. The
  compose rule `build_bind` (compose-safety.ts, high, never exemptable) refuses the same
  for the binds of the compose itself;
- in the src/ layout (`<app dir>/src/.git` exists), a build context or
  additional context that resolves to the app dir itself: that dir holds `.deploy-key`,
  the compose and the data dirs, and no `.dockerignore` of powder's (the deploy's
  wrong-context preflight checked only the deployed service's context). The compose
  rule `build_bind` refuses the same when a build path of the compose is in `./src`;
- a bind source, driver device or secret / config file strictly inside ANOTHER writable
  bind (new config, or a container of any compose project on the server in any state;
  a named volume bound to a host folder counts as a writable bind of that folder, also as
  it exists on the server): a process
  there could swap a folder on the way for a link between this check and the mount. The
  same source bound twice passes; mount the outer folder `:ro` to keep the shape.
- a named volume as it EXISTS on the server. docker resolves a volume's bind `device`
  again on every container start, and compose never changes an existing volume (it would
  ask before recreating one, and keeps the old one without a TTY). For every top-level
  volume of the config (all profiles, external or not; its docker name from `name:`, else
  `<project>_<key>`), `docker volume inspect` when it exists: a `device` option that is an
  absolute path is walked and checked like a driver device above; a bind `o` with a device
  that is not absolute is refused; and for a volume that is not `external`, a driver or
  options different from the config's (`driver_opts`, compared as `key=value;` in key
  order) are refused: restore the old options or save the data and remove the volume. A
  failed inspect counts as "not created yet" only when `docker volume ls` lacks the name;
  any other failure refuses. The
  devices of the volumes this project's containers mount (any state) are walked too. The
  compose check probe also reads every volume's options, and an `external` volume whose
  server copy has a `device` is a `volume_driver` finding (its options are not in the config).
  An external volume without a `device` option passes.

## Infra containers started as they are

When the compose has infra services next to the app (`[has-infra]`), the deploy starts
them with `up -d --wait --no-recreate`, which starts an existing container, an exited one
included, with the mounts it was created with. Right before that `up` (after the guard),
`infraMountGuardShell` (deploy/fragments.ts) compares every existing container of those
services (this project, any state) with the interpolated config's mounts of its service
and refuses, naming the container, when it has a bind source or named volume the config
does not give the service, a writable mount the config makes read-only, or a mount type
other than bind, volume and tmpfs. Anonymous volumes (64-hex names, an image `VOLUME` or
`- /data`) pass when their server copy has no driver options. Fix: remove the stale
container (`docker rm <name>`) or recreate that service, then deploy. The compose
config-hash label is not used for this: an infra container's label differs from
`docker compose config --hash` (override and label files), so a hash rule would refuse
apps with infra.

`Restart` on a container refuses one that is not running (redeploy or apply it)
and, for a container of a registered app's compose project, first runs the on-server guards
a recreate runs (env file, profile, bind and volume guards). Every step is joined with `&&`: a failing running check,
`cd` into the working dir or guard stops it before `docker restart`.

## Build paths: built from the path that was checked

The bind guard checks the build paths on the server; the build reads them later. So:

- the Dockerfile check (`composeDockerfileRewriteShell`, build-cache.ts) resolves each
  build service's `build.context` and every absolute `additional_contexts` value with
  `readlink -f`, writes the resolved path into powder's override (`context:`,
  `additional_contexts: {<name>: <resolved>}`; URLs, `docker-image://` and `service:`
  entries are left as they are) and records `<path>\t<resolved>` in
  `/var/lib/powder/compose/<key>/dfr/pins` (`dfr_pin`). A path that does not resolve or
  resolves to a character outside `[A-Za-z0-9._/-]`, or an additional context name
  outside `[A-Za-z0-9._-]`, refuses the deploy;
- right before every `compose build` (the deployed service, and each sibling the image
  label step builds), the deploy re-runs `el_guard` (env file, profile and bind guards)
  and `dfr_pinchk`: every pinned path must still resolve to its pin and the pin to
  itself, or the deploy stops (`el_guard` also checks the pins before every `up`);
- the test gate copies the pinned context (`dfr_pinned`), after `dfr_pinchk`;
- a build service whose Dockerfile is missing or not a regular file refuses
  the deploy;
- the git sync's target-commit link check (rule i below) counts the build paths of the
  current and the target compose as mount sources, so a commit cannot turn a build
  context into a link.

Shapes that pass: binds inside the app dir, binds of `/opt/apps/<app>-uploads`,
`/opt/apps/<app>-data` and other folders outside the app dir that contain no link,
`/var/<x>` folders, a secret `file: /opt/apps/<app>.build-env`.

## Git sync: no symlink over a mount source

docker resolves a bind source (and a compose secret / config `file:`, and a named
volume's `device`) again every time it starts a container, a restart-policy restart
included. If a git checkout turns a bind source in the work tree, or a folder above it,
into a symlink, a container that exits before the post-checkout guards run comes back
mounting the link target: host `/` (removed by the symlink guard, but only after a window
large blobs can stretch) or the repo's own `.git` (in-repo, kept until the next
`el_guard`). So, BEFORE any checkout or reset changes the work tree,
`targetLinkGuardShell` (`apps/web/src/lib/target-links.ts`) reads the TARGET commit's
tree with the hardened git wrapper (`powder_git ls-tree -r -z`, `cat-file blob`) and
refuses the sync, leaving the work tree as it was, when the target tracks a symlink
(mode 120000):

- (i) whose path equals, or is a folder above, a mount source under the checkout. The
  sources (`targetLinkSourcesShell`, collected in the preflight before the sync): the
  bind sources of every container on the server in any state (`docker inspect`), every
  named volume's `device`, the bind / secret / config file / volume device and
  build context / dockerfile / `additional_contexts` paths of the
  app's current compose config (all profiles, uninterpolated and interpolated), and the
  target commit's copy of every compose file the app runs that lives in the checkout
  (read to a temp dir, through the raw include / extends guard first; the workdir
  layout's runtime `docker-compose.yml` is preserved by the sync, so its current copy
  counts). A source is compared both as written and as `readlink -f` resolves it, against
  the checkout root and its resolved path (`/opt/apps` is a link on the powder server).
  Because the dockerfile path counts, a commit that adds or keeps a tracked link
  AT the Dockerfile path the compose names (`Dockerfile -> docker/Dockerfile`) is
  refused at the sync: name the real file in `build.dockerfile` instead;
- (ii) whose target is absolute, or resolves (from the link's folder, following the
  target tree's other links, at most 40 hops) to the checkout root itself, outside it or
  into `.git`; or whose path or target holds a control character.

The target (`origin/<branch>`, or a pinned sha) is resolved to a commit sha once,
before the check, and the check and the checkout both use that sha (self-deploy too). The
link targets are read with one `git cat-file --batch` for the whole tree.

Where it runs: the deploy sync (src/ layout and the workdir layout, so preview
re-spins too), every repo clone (`gitCloneRepo`: preview first spin, repo connect, `/new`;
the clone in its temp dir is checked against the sources of the dir it replaces, before
the move), and, (ii) only, powder's self-deploy sync and the builder clone (no container
binds the builder dir). The post-checkout symlink guard (`repoSymlinkGuardShell`) still
runs after every checkout. Tracked links that resolve inside the repo and are no mount
source (`<app>/AGENTS.md -> ../AGENTS.md`) pass, and so does a read-only bind of a real
folder in `./src`. Residuals: the reset to the last successful commit after a compose-guard
refusal is not pre-checked (that commit was deployed, so this check passed it when it
was the target); a bind source in the target compose built from a variable
is not resolved (the uninterpolated config is read; the post-checkout bind guard still
refuses a link on the way before any `up`); a dir turned into a file is not refused.

## Ownership: the app name, never compose `name:`

Every taken, reserved and other-app name comparison for aliases, service keys and
`container_name` lowercases both sides (docker DNS answers case-insensitively).

Every ownership rule (env files, volume and network names, Traefik object names, built
image names, sibling images, the deploy's own / foreign containers) keys on the app name.
The compose `name:` is the repo's to choose, so a resolved project name other than the
app name is refused in every mode (compose check and the bind guard; `project_name` at
import). A name is the app's own by prefix (`<app>`, `<app>-...`, `<app>_...`) only when
no LONGER registered app on the server also prefixes it: `shop-api-x` belongs to the app
`shop-api`, not to `shop`. The server counts too: the compose project of every
container (any state), the `com.docker.compose.project` label of every volume and every
`/opt/apps` folder with a compose file (at its top or in `src/`) join the registered apps
in that rule (never this app's own name or project), so `shop` cannot claim
`shop-api_data` while an unregistered `shop-api` project or its volumes are on the server. A
volume of the compose that already exists with another project's label is a
`volume_name` finding, whatever its name. The compose check probe reads the `/opt/apps`
entries and the volume labels (sections 11 and 12). Residual: the container_name path trusts a
container already in the app's project, so an app that first deploys a container `<x>`
and in a later deploy adds `env_file: /opt/apps/<x>.env` for an existing file passes;
leftover env files of removed apps should be deleted from the server. `/new`, repo connect and repo import refuse an app name
whose compose project name (`Shop.com` -> `shopcom`) equals another app's on the server or
a powder container name's (`powder`, `powder-worker`, `postgres`, `powder-postgres`,
`traefik`). A project change during the git sync
(`composeProjectStableShell`) resets the checkout to the last good commit like any guard
refusal.

## Previews: branch code on the production server

A preview (opt-in per app on its Settings tab, `app_repos.previews_enabled`) builds and runs any pushed
branch on the app's server: the compose powder generates for it (`renderPreviewCompose`
in `lib/preview-deploys.ts`) joins the shared `web` network and reads only
`/opt/apps/<app>.preview.env`, never `/opt/apps/<app>.env`. Anyone who can push a
branch can read every value in that preview env file and reach what the `web` network
reaches. So with previews on, the preview env must hold no production secret (no
production `DATABASE_URL`, no live keys); a preview pointed at the production database
can read and write production data. A preview render of the env (scope `preview`) holds
only preview-scoped values, never production ones. The compose guard checks a preview like any app
(its own container name as the app name, the preview env file as its one extra
env file).

Teardown never parses the preview checkout: it removes the containers labelled
`com.docker.compose.project=<preview name>` (the rendered compose sets `name:` to it) and
the network `<preview name>_default` by name, then the checkout. `docker compose down`
read the checkout's tracked `.env`, whose `COMPOSE_PROJECT_NAME` could point the
teardown at another project. A failed first spin removes its clone (and containers)
unless the folder is a registered app's.

## powder's override: cap_drop NET_RAW

Docker's default capability set includes NET_RAW, which lets a container forge ARP and
raw packets on a shared bridge (for example between Traefik and powder on `web`). powder's
generated override (`docker-compose.powder.yml`) adds `cap_drop: ["NET_RAW"]` to every
service of the app's compose. compose unions `cap_drop` across files, so an app's own
entries stay. It applies when a deploy recreates a container; a container that runs `ping`
inside loses it.

## Side containers: one hardening set

Every container powder starts with a plain `docker run` / `docker create`, outside
compose, carries the flags of `lib/side-run.ts`:

- `SIDE_RUN_CAPS` (`--cap-drop NET_RAW --security-opt no-new-privileges`): URL snapshots,
  the rollback and zero-downtime bridges (on top of the copied app hardening), the test
  gate, the restore instructions' throwaway postgres, the Traefik bootstrap (dashboard and
  `bin/server-bootstrap.sh`).
- `TOOL_RUN_HARDEN` (`--cap-drop ALL --security-opt no-new-privileges`): the pg_dump and
  psql tool runs with `--network host`.
- `infra/powder-migrate` (a shell file, same flags written out): psql joins the app
  container's network namespace with `--cap-drop ALL --security-opt no-new-privileges
  --user 70:70 --read-only --tmpfs /tmp --pids-limit 256 --memory 512m -e HOME=/tmp` and
  runs `psql -X -v ON_ERROR_STOP=1`. **That container is the guarantee.** A program psql
  starts (a migration's `\!`, `\o |cmd`, a command built from a psql variable) runs as
  uid 70 with no capability, no privilege gain, a read-only root (only the tmpfs `/tmp` is
  writable) and pid and memory caps, inside the app container's network namespace. It
  can: reach what the app container reaches on the network (its database with the
  migration's credentials, its compose networks, `web` when the app is on it, the
  internet when the app has it). It cannot: see host files, the docker socket or other
  containers' filesystems, forge ARP or raw packets (no NET_RAW), gain a capability, or
  write anywhere but `/tmp`.
- The meta-command check is best-effort defense in depth, not a boundary. Before any
  migration runs, a pending file is refused, naming the file and line, when (1) a line
  has a meta-command that runs a program written out: `\!`, `\o |`, `\g |` (`\gx`),
  `\w |`, `\copy ... program`, `\e` / `\edit` / `\ef` / `\ev`, a backquote after a
  meta-command (the whole line: psql reads meta-commands mid-line), or (2) outside SQL
  strings (`'...'`, `E'...'`, `"..."`, `$tag$...$tag$`) and comments (`--`, `/* */`) it
  has `\set`, `\gset`, `\getenv`, `\setenv`, `\o`, `\g`, `\gx`, `\w`, `\i`, `\ir`,
  `\include`, `\copy` or `\!` (any case), or a psql variable `:name`, `:'name'`,
  `:"name"`, `:{?name}` (`::` casts pass): `\set x '|cmd'` then `\o :x` built the
  command from a variable. Drizzle `--> statement-breakpoint`, `::text` casts, `E'\\d'`
  strings and plpgsql `:=` pass. A slice `arr[lo:hi]` outside a function body is refused:
  write `arr[lo : hi]` (a space after the colon). Telling strings from the rest assumes
  standard strings (`'a\'` is a whole string); this is enforced by refusing any pending
  file that mentions `standard_conforming_strings` or `backslash_quote` (anywhere, any
  case), since turning them off makes psql read `\'` as a quote and end the string where
  the check does not.
  `bin/server-bootstrap.sh --apply` (and the dashboard's "fix missing pieces")
  installs powder-migrate when it is absent; a powder deploy does not update it.
  **Replace an outdated copy on every app server** with `bin/server-bootstrap.sh
  --apply --proxy <mode> --replace-helpers`, or tick its replace step in "fix
  missing pieces".

The guard test `side-run-harden.test.ts` reads every `docker run` / `docker create`
in the TypeScript that builds shell and in `infra/`, `bin/`, `docker/`, and fails on one
without a capability drop (ALL or NET_RAW) and no-new-privileges. Exceptions are an
allow-list with a reason (two error message strings). `docker compose run` (the release
command, the swap check) runs the service's own config with powder's override
(`cap_drop: NET_RAW`) and is not in this rule; powder's self-deploy uses compose too.

`infra/powder-resource-guard.sh` (installed by hand, **reinstall it on every server**)
caps every running container's memory except an infra image: the image reference, without
registry `docker.io`, `library/`, tag and digest, must be exactly one of its `INFRA_REPOS`
(postgres, pgvector/pgvector, redis, nginx, traefik, ...), or the container is powder's own
`postgres` / `powder-postgres`. No RepoDigest is required (a digest-pinned image can have
none locally). A container name or image that merely contains such a
word (`shop-redis-ui`, `acme/nginx`) is capped. An app cannot build or tag those repo
names (`image_name` / `image_owner`). Residual: an app service that runs an official
infra image with its own `command` stays uncapped.

## Git: one hardened wrapper

powder runs git as root in app checkouts, and a container with a writable bind of the
checkout could write `.git/config`. Every git command powder generates (deploy and
self-deploy sync, previews and clones, rollback resets, the dashboard git status, the
builder, the repo import check, the override and symlink guards, the test gate) runs
through `powder_git` / `powder_git_norepo`, defined by `gitHardenShellFunctions()`
(`lib/git-harden.ts`):

- The checkout top is found by powder (a real `.git` directory; a `.git` symlink or
  gitfile is refused, a planted `commondir` is removed), and git runs with an explicit
  `--git-dir`, `--work-tree` and `GIT_COMMON_DIR`, so `core.worktree`, a gitfile or
  `commondir` cannot point it elsewhere.
- Command-line `-c` (which wins over repo config) pins every fixed-name key that runs a
  program: `core.hooksPath=/dev/null`, `core.fsmonitor=` (empty: also safe on git <
  2.36, where the value is a hook path), `core.askPass=`, `core.sshCommand` (the global
  value or a repo value in a fixed `ssh -i <key> -o ...` form, else `ssh`),
  `core.alternateRefsCommand=true`, `core.pager=cat`, no submodule recursion, no auto gc
  or maintenance, submodules ignored by status and diff (`diff.ignoreSubmodules=all`: a populated submodule's own `.git/modules/<name>/config` is never read; powder never runs `submodule update`), and the protocol policy: https, http and ssh only (`ext::`, `file://`
  and `git://` refused; `git://` is also the only transport that reads `core.gitProxy`,
  where the first value wins and `-c` could not override a repo one).
- Keys whose name the repo chooses (`filter.<x>.*` smudge/clean, `diff.<x>.*`,
  `merge.<x>.*`, `credential.<url>.helper`, `lfs.customtransfer.*`, `include.path`,
  `includeIf.*`) cannot be pinned, so the repo-local `.git/config` is untrusted: before
  every call it is scrubbed to an allow-list of data keys (core format and checkout
  settings, extensions, remote, branch, url rewrites, http headers, lfs data). The
  stock git-lfs filter, bare `store` / `cache` credential helpers (no `--file` / `--socket`) and a plain
  `core.sshCommand` stay. Everything else is removed with a `[git-harden] removed
  repo-local git config ...` line on stderr; git does not run when a removal fails.
  The one `git diff` powder runs passes `--no-ext-diff --no-textconv`.
- Global and system config (`/root/.gitconfig`, `/etc/gitconfig`) are left as they are:
  they are root-owned host files no app can bind, and servers use them for ssh aliases and
  credential helpers. `uploadpack.packObjectsHook` is honoured only from that protected
  config and only for local upload-pack, which `file://` = never rules out.
- Residual: a container that can write `.git` could race the scrub (rewrite the config
  between the scrub and git reading it). Only an app whose compose binds the checkout
  writable can, and that bind is a high `bind` finding (see the table). A gitdir outside
  the app dir is not used: existing build contexts contain `src/.git`, and moving it
  would change unchanged apps' builds.

## Image labels and containers powder starts itself

- An image may carry only the `com.docker.compose.*` labels `docker compose build`
  writes on every image it builds: `project`, `service`, `version` (compose v2
  `getImageBuildLabels`). Any other one (`project.config_files`, `project.working_dir`,
  `oneoff`, `container-number`, ...) is container state compose sets at create; on an
  image it would place containers powder starts from it in another project or point
  powder at other compose files. Refused in every mode for the staged build image and
  every image a compose service runs (`imageLabelGuardShell`,
  `serviceImageLabelGuardShell`), and before a URL snapshot or a rollback runs an image.
- The zero-downtime bridge, URL snapshot and rollback bridge containers (plain `docker
  create` / `docker run`, outside compose) drop `NET_RAW` and set every compose label
  key powder or compose reads empty (container labels win over image labels). The
  zero-downtime bridge also copies the running container's `cap_drop`, `security_opt`,
  `read_only` and `pids_limit`; when one cannot be read (or is an inline seccomp
  profile) the bridge is skipped and the deploy goes on without it. It publishes no
  port, except in host-port mode (label `powder.bridge.host-port=<N>`), where it
  publishes `127.0.0.1:<N>` only, only when the app itself publishes exactly one
  tcp port bound to `127.0.0.1` and N is that port + 10000 (so a label cannot take
  another app's port while it is recreated). In host-port mode `extra_hosts` are
  copied and each entry must be `name:ip` or `name:host-gateway` (strict charset),
  else the bridge is skipped; traefik mode still skips on any `extra_hosts`.
- powder's override failing to MERGE with the app's compose (the app's compose parses
  on its own, the merged config does not) refuses the deploy. Other override failures
  (server I/O) go on as before with a `[compose-guard] WARN <app> override_failed` line.
- Values that end up in powder's override labels (hostnames, base domain, health_url
  path) may not contain `include` or `extends`: the raw guard above refuses those words
  anywhere in a compose file. A hostname with one is refused when it is added; a base
  domain or health path with one is treated as unset.

## The rules (allow-list)

A service key that is not on the list is refused (`unknown_key`). Refused, by code:

| code | what |
|---|---|
| profiles | a service `profiles:` key, or a service in the uninterpolated config that the resolved config lacks; never exemptable |
| pull_policy | on a service with a build section, any policy other than none, `missing`, `if_not_present`, `never` or `build` (compose would pull its `image:` with root's registry logins); never exemptable. See "Registry logins" |
| privileged | also `privileged: true` in a `post_start` / `pre_stop` hook (hook keys are allow-listed: command, user, privileged, working_dir, environment) |
| privileged, cap_add, devices, device_cgroup_rules, userns_mode, cgroup, cgroup_parent, gpus, runtime, isolation, storage_opt, blkio_config, credential_spec, use_api_socket, provider, external_links | always |
| pid, uts, ipc | any host / other-container namespace |
| network_mode | host, container:*, service:<not in this compose> |
| security_opt | anything but no-new-privileges |
| bind | bind sources outside /opt/apps/<app>, the app dir itself, anything containing a compose file / .deploy-key / the file powder renders the app's env into (also a target inside the app dir); a WRITABLE bind at or above the git metadata powder runs git on (`<workdir>/src/.git`, `<workdir>/.git`, `<compose dir>/.git`: `./src:/app`, `./.git:/x`), and a WRITABLE bind of anything inside them (`./src/.git/hooks`, `.git/modules`, `.git/info`, `.git/objects`), while `:ro` / `read_only: true` and subfolders such as `./src/public` pass; a WRITABLE bind at or above a powder-migrate candidate dir (`src/drizzle`, `drizzle`, `migrations`, `src/migrations`, `supabase/migrations`, `db/migrations` under `<workdir>/src` or `<workdir>`), `:ro` and single files pass; a named-volume bind device checked like a bind source (the app dir itself, protected paths and env files refused), where `/opt/apps/<app>-*` folders are also allowed unless a longer registered app name owns them or they are another app's dir or `.env` |
| volume, volume_name | volume types other than bind/volume/tmpfs (no `type: image`); named or external volumes of another project |
| volume_driver | a named-volume driver other than `local`; driver_opts other than a tmpfs (`type: tmpfs`, `device: tmpfs`, `o` without paths) or `type: none` with `o` bind / rbind (plus ro / rw) and an absolute device; any `o` value naming a path (`lowerdir=/`) |
| network_driver | a network driver other than bridge (macvlan, ipvlan, ...), any network driver_opts |
| network_alias | an alias with a character outside `[A-Za-z0-9._-]` (any network). An alias that is a powder name on a shared network, or a name another compose project's running container answers on that same network (container name, service name or alias, probed with `docker inspect`); on a shared network or an `external` one also, in any container state and case-insensitively, another registered app's or preview's name, its `-db`, `<other>.<x>` / `<other>_<x>`, and every container name of another project; other projects' service keys and aliases do not count on an external network that is not shared, and the powder-name check stays on shared networks; this project's own containers never count |
| network_address | a top-level network `ipam` with anything but `driver: default` (any `config` with subnet, gateway, ip_range, aux_addresses; `options`), `enable_ipv6: true`; per service network any key but `aliases`, `priority`, `gw_priority`, `interface_name` (so `ipv4_address`, `ipv6_address`, `link_local_ips`, `mac_address`, `driver_opts`); a service `mac_address` |
| ports | a published host port 22, 80 or 443 (any host_ip, ranges included), or a host port (same protocol, same host_ip or either unbound / `0.0.0.0` / `::`) that a container of another compose project on the server binds in any state (`docker inspect` HostConfig.PortBindings; containers without a compose project, such as powder's bridges, never count); an unreadable ports entry |
| ulimits | a ulimit other than nofile, nproc (each up to 1048576), core, stack, memlock (each up to 1073741824); a negative, unlimited (-1) or non-numeric value; the same for `build.ulimits` |
| oom | a negative `oom_score_adj`, `oom_kill_disable: true` |
| pids_limit | `pids_limit` or `deploy.resources.limits.pids` of 0 or less (unlimited) |
| annotations | any `annotations` |
| logging | `logging.driver` other than json-file, local, journald or none; a logging option ending in `-address`, `-url` or `-host` |
| project_name | (import) a compose `name:` other than the app name; at deploy a hard refusal, see "Ownership" |
| env_file | env_file / label_file not under the app dir and not `/opt/apps/<owner>.env` where owner is the app, `<app>-*` / `<app>_*` / `<app>.*` (unless a longer registered app owns it), or a container_name of this compose that no other registered app or preview owns (the longest registered name that equals or prefixes it with `-`, `_`, `.` must be this app or none) and that already belongs to this app's compose project (any state) or whose file does not exist on the server yet (a leftover env file of a removed app, or a copy, is not claimed by naming a container after it; when the probe could not list /opt/apps the file counts as existing); paths built from a variable (also hard-refused by the env file guard above); powder's own env file (`POWDER_ENV_FILE`), `/opt/apps/powder*.env` and anything under `/opt/apps/powder/`, for every app. The shapes `<app>.db.env`, `<app>-db.env` and a sidecar of the app's own project pass; a shared env file named after nothing in the compose stays a finding |
| build_bind | (never exemptable) a writable bind of this compose whose source is strictly inside a build context or an additional context; `:ro` / `read_only: true` passes, and so do `pgdata` / `kvdata` right in a build path that is the app dir (the `/new` layout; on the server also only with powder's `.dockerignore` there); in the src/ layout (a build path in `./src`) a build path that is the app dir itself. The on-server bind guard refuses the same for every container on the server |
| build | context/dockerfile/additional_contexts outside the app, URLs, docker-image://, ssh, network other than default/none, entitlements, any local build cache (`type=local` or a `src=` / `dest=` key, any case), any `cache_to` (a registry export pushes with root's registry logins) and any `cache_from`, `x-bake` and every `build.x-*` key; a context, dockerfile or additional context path with a character outside `[A-Za-z0-9._/-]` (the deploy preflight also refuses a resolved build.context or dockerfile outside that set in every mode, so a path can never reach generated shell as sed / awk syntax) |
| image | (a service WITHOUT a build section) an image whose repository is one another project BUILT on the server: the image of another registered app's or preview's main container (the container named after that app), or an image whose `com.docker.compose.project` label names another project; any tag, digest pin or `pull_policy`. Also a ref whose full repo or last path segment is exactly another registered app's name (`ghcr.io/<org>/<other-app>`, digest pins too); the app's own name passes. A public image several apps run (`pgvector/pgvector:pg16`, `postgres:17-alpine`) is in neither list. Also any other image a container of another compose project runs, in any state, unless it is public: another project pins its repo by registry digest, or it is a Docker Hub image (no registry host) two or more other compose projects run. This app's own project never counts toward that, and powder's own containers (postgres, traefik, ...) are left out. Residual: a library image only one other project runs is treated as that project's, and a local build two other projects both run passes as public. On docker 29 with the containerd image store a locally built image has a RepoDigest and a built image often carries no compose label, so neither alone marks a build. Also an image on a registry root is logged in to (see "Registry logins" below) that is not the app's own: its last path segment must be the app name (`ghcr.io/<org>/<app>`); a name a service of this compose builds does not count. |
| image | a built image or build.tags (the names a build writes to the server's image store) equal to an image another project's containers use in any state (refs compared canonically: `docker.io/library/postgres:16` = `postgres:16`), exactly the name of another registered app on the server (the full repo or its last path segment: `<other-app>`, `ghcr.io/<org>/<other-app>`; a shared prefix such as `<other-app>-web` is not ownership, and no own prefix is required), or tagged `:deploy-*` (powder's rollback images) |
| image_foreign | a service WITHOUT a build section whose image is a local image ID (`sha256:<id>`, a bare hex id), another project's compose-default build name (`<project>-<service>`), or named after another powder app on the server (`<other>:<tag>`, `<other>-<x>`, `<other>_<x>`; the longest matching app name decides, so app `api` cannot run `api-v2-*` images of app `api-v2`): that app's locally built image with its code and build-time secrets. A digest pin (`image@sha256:...`) or a registry image named after nobody on the server passes (see `image` below for digest pins and images other projects built) |
| image_owner | (high, never exemptable) a built image, compose default name or build.tags whose repo another compose project built or runs, that another app's Dockerfile on the server reads, or that is a Docker Hub namespace name not named after the app. See "Image ownership" |
| image_name | a built image or build.tags with an official Docker Hub name (`node:22-alpine`, `postgres`) that does not start with the app or project name; it would shadow the real image for other apps and the test gate. Also any built image under `docker/` or `moby/` (after dropping `docker.io/`, `index.docker.io/` and `library/`), such as a local `docker/dockerfile:1` that later builds would use as their `# syntax=` frontend, and a powder image name (`powder`, `powder-worker`, `powder-postgres`, `postgres`, `traefik`, `powder-*`) unless it starts with the app name |
| secret, config | top-level `file:` outside the app dir; inside it, a file that is, holds or sits inside a protected path (compose files, `.deploy-key`, git metadata); the app's own env files pass |
| scale | `scale` or `deploy.replicas` above 10, negative or not a number |
| container_name | powder's self service or container name (`POWDER_SELF_SERVICE`, `POWDER_SELF_CONTAINER`, default `powder`); a character outside `[A-Za-z0-9._-]`; powder, powder-worker, postgres, powder-postgres, traefik, or a name another project uses; another registered app's or preview's name, its `-db`, or `<other>.<x>` / `<other>_<x>` (`<other>-<x>` stays free) |
| hostname | a value with a character outside `[A-Za-z0-9._-]` |
| service_key | a service KEY equal to powder's self service or container name, on any network; a service KEY with a character outside `[A-Za-z0-9._-]` (any network); a service KEY on a shared network (web, internal, infra, plus `POWDER_SHARED_NETWORKS`) equal to one of those powder names, or a container or compose service name another project's running container answers on that network (compose makes the key a DNS alias there); on shared and `external` networks also the any-state names of `network_alias` (only those on an external network that is not shared) |
| traefik_host | (Traefik servers, and any server where the compose check probe sees a running Docker-provider proxy) router rule not made of Host() terms of the app's default host + live verified domains (AND-narrowing allowed, no `||` widening, no `!`); a `tls.domains[n].main` / `.sans` name that is not one of those hosts |
| traefik_tcp, traefik_internal | tcp/udp routers; `service=...@internal` |
| traefik_url | a Traefik service `loadbalancer` URL or address label (`traefik.http.services.<n>.loadbalancer.server.url`, the tcp/udp `address` forms): it sends the route to any host, not this container; any `traefik.http.middlewares.<n>.forwardauth.*` label (Traefik calls that address with every request's headers) |
| traefik_name | (any server) a Traefik router, service, middleware or serversTransport (`traefik.(http\|tcp\|udp).<kind>.<n>`) whose `<n>` is not the app name or `<app>-...` (a longer registered app name that also prefixes it wins); a router `middlewares=`, chain `middlewares=` or any key ending in `.service` / `.services` (any case: a router's `service=`, a middleware's `errors.service`) value naming another app's object, or a provider other than @docker/@file (Traefik merges same-named objects across containers, so another app's name rewrites its route) |
| compose_label, powder_label | `com.docker.compose.*`, powder runtime markers (powder.bridge, powder.release, powder.candidate, powder.testgate) |
| network | networks other than the app's own and the shared ones: web, internal, infra, plus any named in `POWDER_SHARED_NETWORKS` (powder.env, comma-separated) |
| include, top_key | unresolved include, unknown top-level keys (any include or extends is also refused before this, see above) |
| env_loopback | (deploy and recreate, only when the compose differs from the last successful deploy or the repo changed its structure) a service that is not on host networking whose env (env_file contents as compose inlines them, and `environment:`) tells it to connect to `127.0.0.1` (any 127.x), `localhost` or `[::1]` (or `0.0.0.0` in a URL) on a port it does not listen on itself. Only connection targets count: a URL with a backend scheme (postgres, postgresql, mysql, mariadb, redis, rediss, amqp, amqps, mongodb, nats, kafka, clickhouse, memcached) in any variable; an http(s) URL only in a variable named `*_URL`, `*_URI`, `*_HOST`, `*_ADDR`, `*_ADDRESS` or `*_ENDPOINT`; a bare `host:port` (also in a comma list) only in `*_HOST(S)`, `*_ADDR`, `*_ADDRESS`. Names with a whole `_`-separated word part ORIGIN(S), CORS, CSP, ALLOWED, TRUSTED, PUBLIC, REDIRECT(S), CALLBACK(S) or SITE(S), or ending in BASE_URL, NEXTAUTH_URL or AUTH_URL (so `DATABASE_URL` is not `BASE_URL`), or holding LISTEN / BIND never count for http or bare values. A backend scheme with a driver suffix counts too (`postgresql+asyncpg`, `mysql+pymysql`, `redis+sentinel`; also sqlserver, mssql, cockroachdb). Not judged: a split host and port pair (`DB_HOST=127.0.0.1` with `DB_PORT=5433`), since neither value alone names a host:port; a URL without an explicit port. Its own ports: `PORT`, `ports` targets, `expose`, the EXPOSE ports of the image its existing container runs (the probe's image config), a `traefik...loadbalancer.server.port` label, a loopback port its healthcheck probes. Skipped: `network_mode: host`, `container:` mode, and every service of a `network_mode: service:<x>` group of two or more (a sidecar answers on loopback there). A userinfo with `@` in the password does not hide the host. Inside a bridge container loopback is the container itself, so such a value reaches nothing (an app switched from host to bridge networking with its database on `127.0.0.1:<db port on the server>`). The finding names the variable and the host:port, never the value. Value-scoped exemption by variable name: `{"env_loopback":["DATABASE_URL"]}` |

## Traefik routes on any server, tracked .env

`servers.proxy` says how powder routes a server, not what runs there: a server marked nginx can
run its own Traefik with the Docker provider, which routes any container label. The
compose check probe (15th section, `DOCKER_PROXY_PROBE`) lists the running containers
whose image is `traefik` or whose args, entrypoint, cmd or env name `providers.docker`
(matched on the server; env values never leave it). When one runs, the app's hosts (default
host plus live verified domains) are enforced as on a server marked traefik
(`effectiveRouteHosts`, compose-check.ts; deploys and every recreate). A failed host
lookup on such a server allows no host. A Traefik configured only through a static file
with a non-traefik image is not seen.

In the workdir and preview layouts the checkout's tracked top-level `.env` is compose's
project `.env`: it is refused when it contains `COMPOSE_` or `DOCKER_` anywhere, any case
(a line-start match would miss `A="x" COMPOSE_PROJECT_NAME=victim`). A plain key that
only contains the word (`MY_DOCKER_TAG`) is refused too: rename it or set it in powder.

## Env render target

powder renders the app's env file (DB to disk) before the guard runs, to the first
`env_file:` of the app's OWN compose service (the service of the running container, or
the one named after the app; another service's `env_file` is never a candidate), else
`/opt/apps/<app>.env`. That write is contained (`apps/web/src/lib/env-target.ts`), and
the check runs only when powder is about to write: a render that is skipped (DB mode
off, no env vars in the DB) or refused by the drift guard touches nothing and is never
stopped by it.

- `/opt/apps/<app>.env`, or a file inside `/opt/apps/<app>/` (not `.deploy-key`, a
  compose file or under `.git`, no symlink on the way);
- or the app's PINNED target (`powder_meta` row `env_render_target:<serverId>:<app>`).
  A deploy creates a pin only from powder's own env snapshot of exactly that path from
  a successful deploy of this app that started before the `env_target_cutoff` row
  (written once, when migration 0057 first runs): `deploy-<id>` in the env
  state dir (the newest 5 per file, written after each successful rendering deploy),
  or an older in-place `<path>.deploy-<id>` (a regular file, never a link) whose mtime
  is before the cutoff. Nothing else counts as evidence: compose files and container
  state can be steered by a repo. A new app never gets a pin, and the dashboard
  env-file write never creates one.
- Never, pinned or not: powder's own env file (`POWDER_ENV_FILE`,
  `/opt/apps/powder*.env`, `/opt/apps/powder/`), another app's `/opt/apps/<other>.env`
  or `/opt/apps/<other>/...`, or a path another app on the server has pinned.

Any other target stops the deploy before the build with `env render REFUSED` (the
dashboard save answers 400) and leaves the file on disk as is. The message carries the
exact SQL to pin a path an operator has checked:
`INSERT INTO powder_meta (key, value) VALUES ('env_render_target:<serverId>:<app>', '<path>') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();`
(run it in powder's DB, e.g. `docker exec -i powder-postgres psql -U admin powder`).

Env copies never follow a link. A container that can write next to the env file
could swap the file itself for a link to another app's env file; a copy that followed it
would later be restored into this app. Every copy powder makes of an env file (the
pre-render copy, the deploy snapshot, the `.bak` of a write and of a restore, the restore
itself) goes through `envCopyShell` (`lib/ssh/files.ts`): only a regular file that is not
a link is copied, with `cp -P`, and the copy is checked again (a regular file, not a
link). A link at the env file stops the render before the build (`env pre-render copy
failed: ... not a regular file`) and makes the write refuse; replace the link with the
file it points to. The write of a target inside the app dir checks the FULL path for
links (the file itself too), once before and once more right before the rename.

Disconnecting an app moves `/opt/apps/<app>.env`, `<app>.preview.env` and
`<app>.db.env` into a new root-only dir `/var/lib/powder/deleted-env/<app>-<ts>/` (0700)
so a later app with that name, or anything that can read `/opt/apps`, does not find
them. It does so only when no container of the app is left on the server (its compose
project `<app>` as compose writes it, a container named `<app>`, or a preview
`pv-<app>-*`, in any state); while one exists the files stay, since recreating that
container (a reconnect, a hand-run `compose up`) reads them. When docker cannot list
the containers (daemon down, no CLI), the files stay as well. A file that belongs to
another registered app stays too (`<app>.db.env` when an app `<app>.db` is registered;
nothing when the app is `<other>.<x>`). The disconnect answer (`envArchive`) and the
log line `[deleted-env] <server>/<app>: ...` name the exact dir, or why the files
stayed. Best effort: a failure is logged and the disconnect stands. To restore before
reconnecting, as root on the app's server:
`mv /var/lib/powder/deleted-env/<app>-<ts>/* /opt/apps/`. A reconnect creates a new app
row, and the old row's env vars are not attached to it, so restore the files first: the
connect's backfill then imports them.

To see every app's target before anything changes, run `bin/self-deploy.sh --pin-report`
(same settings as a normal run). It rsyncs the committed tree into `$POWDER_SRC` on the server and builds the images under
the server build lock as `powder:pin-report` / `powder-worker:pin-report` (never
`:latest`), then prints every app whose target is outside its dir, whether it keeps
working (pinned, or a snapshot will pin it) and the SQL for each one it would refuse.
It migrates and recreates nothing. `bin/self-deploy.sh` prints the same report before
every recreate.

## Build cache isolation and Dockerfile checks

BuildKit shares `RUN --mount=type=cache` mounts by id across every build on one
daemon, and a mount without an id uses its target path (`/root/.npm`) as the id. So
before every build powder rewrites each cache mount of the Dockerfile it builds (the
repo's own or a generated one, every compose service with a `build:` section, the
dedicated builder too) to `id=<app>-<hash>`, where the hash is
`sha256(<namespace>, <original id or target>)` and the namespace comes from a random
per-app salt in powder's DB (`powder_meta` row `build_cache_salt:<serverId>:<app>`,
created on the first build, never shown in the dashboard, API or logs). A repo cannot
name another app's cache. The rewritten Dockerfile goes to a temp dir outside
the build context and the build reads it through `-f` (builder, a `/tmp/powder-dfr.*`
dir removed after the build) or a compose override (`build.dockerfile`). On the app's
server that set (the rewritten Dockerfiles, the override and the `pull_policy` pins)
lives in `/var/lib/powder/compose/<key>/dfr/` (0700, replaced as a whole on every
deploy): `compose up` records its files in the container's `config_files` label, and
rollbacks, domain apply and `powder-migrate` read that label; the repo's file is untouched, and a
`<Dockerfile>.dockerignore` is copied next to it with powder's protected entries last.
A service with `build.dockerfile_inline` gets the rewrite through `dockerfile_inline: !reset
null` in that override, which needs `docker compose` 2.24 or newer on the app's server.
A deploy that cannot read
its salt builds with a random namespace (isolated, cold) and says so in the log
(`apps/web/src/lib/build-cache.ts`).

Refused (every mode): a syntax directive (`# syntax=` or `// syntax=`, also after a
UTF-8 BOM) other than Docker's own frontend
(`docker/dockerfile[:<tag>][@sha256:<digest>]`, optionally `docker.io/`), or a
JSON-form Dockerfile (its `syntax` key picks the frontend): a custom
frontend gets the whole build context and need not honour `.dockerignore`; a
`BUILDKIT_SYNTAX` build arg (compose `build.args`, code `build`; the builder refuses
it too); a RUN `--mount=` flag with quotes, with a `type=` from a variable,
or split over a line continuation (comment lines and `--mount=` text in the command
are not flags; a cache spec there still gets its own id). `type=secret` and `type=ssh` mounts are left as
they are: BuildKit only hands a build the secrets and ssh agents its client passes
(compose `build.secrets`, `build.ssh`, both under the rules above).

The same pass checks the images the Dockerfile reads, whatever `POWDER_BUILD_PULL`
says (`FROM`, `COPY --from`, `--mount=...,from=`, ARG defaults resolved; stage names are
not images). Each ref is compared against the compose guard's image authority of
this deploy (`dockerfileImageAuthority` / `dockerfileImageForeign` in compose-safety.ts,
the awk twin `DFR_FOREIGN_AWK` in build-cache.ts, a test keeps them equal): a local image
ID; a repo another project built on the server or another project's compose-default build
name (any tag or digest); a repo whose full name or last path segment is another
registered app or preview; without a digest also `<other>-<x>` / `<other>_<x>` where the
longest app name decides. The builder gets the same lists. A local image with no registry
digest that is not the app's own stays refused too (an extra signal: on docker 29 with the
containerd store local builds have a RepoDigest, so that test alone let them through).
Enforce mode refuses, warn mode logs `[compose-guard] WARN <app> dockerfile_image ...`.
The app's own images pass (only repos the image ownership authority says the app
owns, see "Image ownership" below), as do public bases (`node:*`, `alpine/git`, ...),
which must also be powder's own pull. With `POWDER_BUILD_PULL=0` a ref with a variable that has no ARG default is
refused (enforce) or logged too; with pull on it resolves from its registry. Every
service the deploy builds (the deployed one and the siblings it builds to check their
image labels) builds with `--pull` unless `POWDER_BUILD_PULL=0`.

More refusals of the same pass (every mode, the on-server awk):

- an `ADD` source BuildKit would fetch from outside the build context, inside dockerd as
  root on the host (root's git ssh key, root's registry logins, 127.0.0.1 and the other
  bridges): a URL (`://`), a git remote (`git@...`, `user@host:path`, `github.com/...`, a
  source ending in `.git` or holding a `#ref`) or a source built from a variable (`$`),
  under `ONBUILD`, over line continuations and in JSON form too; `ADD --checksum` and
  `ADD --keep-git-dir` (they only go with such sources). BuildKit unquotes and
  unescapes a source (shlex, or a JSON string decode) before it decides, so a source
  word with a `\` or a `'` is refused, and so is a `"` outside the JSON form (where it
  only delimits the strings). `ADD <<EOF` heredoc markers pass. Twin rules:
  `addSourceRefusal` (TS) and `addsrc` (awk), one test table;
- a RUN flag between `RUN` and the command: `--network=` other than `default` / `none`,
  any `--security=`, any `--device=`. Words after the command starts are the command's
  (`yarn install ... --network-timeout 300000` passes);
- a `FROM` line inside a heredoc body; on a `RUN` / `COPY` / `ADD` line (`ONBUILD` and
  continuations included), any `<<` other than a whole-word marker `[0-9]*<<NAME`,
  `<<-NAME`, `<<"NAME"` or `<<'NAME'` (NAME: letters, digits, `_`, not starting with a
  digit) outside quotes: `<< EOF` (BuildKit reads it as `<<EOF`), `<<<`, `cat<<EOF`,
  `<<EOF>file`, `<<` inside quotes or `${...}`, an escaped blank before the marker; and on
  such a line any non-ASCII byte, an unbalanced quote or a `${...}` other than `${NAME}`
  (BuildKit then drops every marker). This parser could end those bodies elsewhere than
  BuildKit does. A body ends at the first line equal to the name (leading tabs dropped
  for `<<-`), the markers of one line in order; `<<` lines inside a body start nothing;
- a Unicode space (U+0085, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F,
  U+3000) outside quotes in an instruction (BuildKit's shell lexer splits words there);
  inside quotes and in heredoc bodies it passes;
- the name `POWDER_NS` anywhere outside comments (also over a line continuation);
- a line ending in two or more escape characters (BuildKit reads no continuation there,
  older frontends `# syntax=` may pick read one), and a `RUN` flag glued to a line
  continuation (`--mount=...\` + next line: the cache mount rewrite reads the physical
  line). `COPY` / `ADD` / `FROM` flags are read from the joined line only, so a flag glued
  to a continuation there passes and is read as BuildKit reads it (`COPY --chown=0\` +
  `  --from=<image> ...` reads `--from=<image>`). Continuations are read as
  BuildKit reads them: a line continues when its last non-blank character is the escape
  character and the one before it is not (or it stands alone on the line), a continued
  line keeps its leading whitespace, and comment and blank lines inside a continuation
  are skipped.

Image refs from variables: the build args the build passes (each compose
service's resolved `build.args`, the builder's args) override the Dockerfile's ARG
defaults before the refs are checked, as BuildKit does (`ARG BASE=alpine` + `FROM ${BASE}`
with `build.args: {BASE: ghcr.io/<org>/<other>}` is checked as the ghcr ref). A ref whose
variable resolves to nothing (`ARG BASE` + `FROM $BASE`, `COPY --from=$X`, `--mount=from=$X`)
is refused in EVERY guard mode (warn included) whenever a registry login is known,
whatever `POWDER_BUILD_PULL` says. Without a known login it is refused (enforce) or
logged (warn) only with `POWDER_BUILD_PULL=0`; with pull on, the build pulls it.

ARG scope and order: a ref is resolved AT ITS LINE with the ARGs BuildKit has in
scope there, not one global map where the last write wins. `FROM` reads the meta ARGs
(declared before the first `FROM`, a build arg overrides them); `COPY --from` and `RUN
--mount from=` read the ARGs of their stage declared above them (the map is emptied at
every `FROM`; `ARG X` without a default inherits the meta value; a build arg overrides a
declared ARG; an `ONBUILD ARG` is not in scope). An ARG default is expanded at its line;
one that does not resolve leaves the ref UNRESOLVED. An `ENV` value is
expanded at its line with the stage's ARGs and earlier ENVs (an unset name expands to
nothing, as BuildKit does), so `ENV NODE_VERSION=${NODE_VERSION}` holds `22`, not the
raw text. A form this parser cannot expand (`${P%Z}`, `${P#x}`, `${P/a/b}`, `${P:?e}`)
keeps the raw value, so a ref using that name is UNRESOLVED (refused with a registry
login); only a value that really expands to nothing is dropped. In a stage, the ENVs
above a `COPY --from` / `--mount from=` line count for it too, over an ARG of the same
name (BuildKit's precedence). Expansion matches braces: `${A:-${B}}`, `${A:+w}`, `${A-w}`, nested up to depth
8. The report line `AT <line> <ref> <resolved>` (informational) is the ref as resolved at
its line before the backstop; the tests assert it per line. As a fail-closed backstop each ref
is also checked with every value any `ARG` (anywhere), `ENV` or build arg of each name it
uses is ever given (the other names at their in-scope values); a backstop value that is
no image name (a space) is skipped. The TS twin
`dockerfileImageRefReport` (build-cache.ts) runs on one table with the awk (test
`dockerfile-arg-scope`). The registry login owner rule comes first in
`DFR_FOREIGN_AWK` / `dockerfileImageForeign`, so a login-registry ref that is also named
after another app gets the every-mode refusal.

Per-app RUN layer cache: BuildKit's cache key for a RUN does not include what a
`type=secret` mount held, so two apps with the same base and RUN line (a common
template's `RUN --mount=type=secret,id=envfile,target=/app/.env.local yarn build`) could
share a layer built with the other app's secrets. The rewrite
declares `ARG POWDER_NS_<hash>=1` right after every `FROM` (after the last line of a
continued `FROM`; every stage, `AS` or not; never inside a heredoc body), where the hash
derives from the app's salted namespace (`runNamespaceArgName`). An in-scope ARG is part
of the env of every RUN in the stage, so of its cache key: RUN layers are per app. The
value is the ARG default in powder's rewritten file, so no `--build-arg` is needed and
the compose and builder paths get it the same way. ARG only: the image's runtime env is
unchanged (the image history records the name, a salted hash, not the salt). A base
image's own `ONBUILD` triggers run before the ARG; a base with triggers is refused,
see below.
The ARG is part of every RUN's cache key, so an app's first build with it rebuilds every
RUN layer once.

Stage order: BuildKit resolves a `FROM` name only against the stages declared on
EARLIER `FROM` lines, never against its own `AS` name or a later one. So
`FROM <other-app> AS <other-app>`, or `FROM <other-app> AS build` with a later
`FROM node AS <other-app>`, reads the LOCAL image `<other-app>`. The image pass
tracks stages in order: a `FROM` ref counts as a stage only when an earlier `FROM`
declared it (a number in `FROM` is an image name), so those refs reach the image checks
above. `COPY --from` reads any stage of the file, by name or index; `RUN --mount from=`
reads a stage by name only (BuildKit's `detectRunMount` looks it up with
`findStateByName`), so a number there is an image name (`--mount=from=0` is the image `0`
and reaches the image checks). In `COPY --from` a number is a stage index only when Go's
`strconv.Atoi` parses it (up to 9 significant digits here); a longer one is a name to
BuildKit, so an image ref (`COPY --from=99999999999999999999` reaches the image checks),
and an index past the last stage (the build would fail) is refused. Twins: `ref_out` /
`isstg` (awk) and `dockerfileImageRefReport` (TS), one test table
(`dockerfile-stage-order`), run with every awk on the machine; `dockerfile-twin-parity`
runs the continuation, heredoc and ref tables and sample Dockerfiles through both and
compares their image lines and image-ref refusals.

Base images with `ONBUILD` triggers: a base image's triggers run in the child build
before anything powder inserts and are never seen by this pass. They also run for a
named build context that replaces a stage: an `additional_contexts` entry named like a
stage (`FROM base` with `additional_contexts: {base: service:<sibling>}`) makes BuildKit
read that image for the stage and run its triggers. Such a stage is no `FROM` image ref,
so the inspection below does not cover it; the compose guard allows only a directory of
the app there (no image, so no triggers) or `service:<name>` of a service of the same
compose file. One could
`COPY --from=<another app's local image>` (read as it is with `POWDER_BUILD_PULL=0`) or
use a cache mount without this app's namespace. What holds, in EVERY guard mode,
compose path and builder (`dfr_bases`, `DFR_BASES_FN` in build-cache.ts):

- the rewrite writes every `FROM` that reads an image (not an earlier stage, not
  `scratch`) back as ONE line `FROM __POWDER_BASE_<k>__ [AS <name>]` (an allowed
  `--platform=` flag is dropped, trailing blanks too) and reports the ref as BuildKit resolves it at that line (`BASE <k> <ref>`, build args
  over the meta ARGs). A `FROM` ref that does not resolve is refused (it cannot be
  inspected); the name `__POWDER_BASE_` is reserved;
- for each such base that is not this app's own build (`dfr_own`: an owned repo
  only): when `--pull` is on, or the image is not on the server, or its local copy is
  not one powder pulled (`dfr_prov`, see "Image ownership" below), it is pulled first
  (anonymously: every remote command runs without root's registry logins), else the
  local image is read; `docker image inspect` must show an empty `.Config.OnBuild`
  (refused when it has triggers or cannot be inspected);
- the token is replaced with the inspected image pinned to its registry digest (the
  `RepoDigests` entry of the same repository; a ref already written with `@sha256:` stays
  as written). A base with no digest of its repository is refused. So the build reads the
  checked image, with or without `--pull`. The app's own images are written back as they
  are (not pinned, not inspected); a token left in the file is a refusal;
- only the platform the server builds for is checked, so a `FROM --platform=` other than
  `$BUILDPLATFORM` / `${BUILDPLATFORM}` / `$TARGETPLATFORM` / `${TARGETPLATFORM}` is refused,
  and so are a compose service `platform`, `build.platforms` (code `platform`) and
  `build.pull` other than `false` (code `build_pull`, it re-resolves every `FROM` from its
  registry after the check), high and never exemptable. The written `FROM` line of an
  image drops even an allowed `--platform=` flag (the build reads the variant of the
  pinned image), and a value for one of BuildKit's automatic platform ARGs
  (`BUILDPLATFORM`, `BUILDOS`, `BUILDARCH`, `BUILDVARIANT`, `BUILDOSVERSION`,
  `TARGETPLATFORM`, `TARGETOS`, `TARGETARCH`, `TARGETVARIANT`, `TARGETOSVERSION`, any
  case) is refused: an
  `ARG` default for one (a bare `ARG TARGETARCH` passes), a compose `build.args` key
  (code `platform`) and a builder arg (the args file the check reads).
- BuildKit's automatic global args (the platform ones above and `TARGETSTAGE`, the
  last stage's name when no target is given) have values with no `ARG` line, which this
  pass cannot see. A `FROM`, `COPY --from=` or `--mount from=` ref that uses one, directly
  or through an `ARG` / `ENV` value that does (`ARG X=${TARGETSTAGE:-b}` + `FROM $X`), is
  refused, defaults (`:-`, `:+`) included; `FROM --platform=$BUILDPLATFORM <image>` (a
  flag, not the ref) passes. A `FROM` with a variable that resolves to an earlier stage or
  `scratch` is written back with that literal as `FROM [--platform=...] <stage> [AS
  <name>]` (`FROM b AS mid`; an allowed `--platform=` flag is kept, since no image is
  pinned there), so BuildKit reads the stage this pass resolved. Any other `FROM` (a
  literal earlier stage or `scratch`) stays as written.

Not covered: `COPY --from=<image>` and `RUN --mount from=<image>` refs are not inspected
for triggers (triggers run only for a `FROM` stage, or a named build context that
replaces one, see above) and not pinned; they keep the image rules
above (and the provenance rule below, with the guard mode). A digest pin fixes the
content, not the registry's later answer for the tag.

## Image ownership

The server's local image store is one trust domain shared by every app: every build writes
into it, and every build (`FROM`, `COPY --from`, `RUN --mount from=`) and the test gate
read from it (with `POWDER_BUILD_PULL=0`). Two holes follow from that unless ownership
is decided in one place: a compose could make any repo "its own" by building one tag of
it (`image: acme/jobs:mine` would make another app's `acme/jobs:latest` own, and own refs
skip the local-image rules), and a build could shadow a public base another app reads
(`image: alpine/git:latest`; on docker 29 with the containerd store the local build has a
RepoDigest, so a base check would pin the hostile digest). One authority decides,
`lib/image-ownership.ts`:

- a repo (tag and digest dropped, `docker.io/` / `index.docker.io/` /
  `registry-1.docker.io/` and `library/` dropped, lowercase) is OWNED by app X iff X's
  compose builds it and no other compose project on the server built it (an image with its
  `com.docker.compose.project` label) or runs it (a container of that project, any
  state). The compose check probe reads two more sections for it: every local image
  (`docker image ls -aq`, dangling ones too, their repos from RepoTags and RepoDigests)
  with its compose label, and every image ref the Dockerfiles under `/opt/apps` read
  (depth 2 to 4, and `<app>/src` depth 1 to 4; `node_modules`, `.git` and `*.removed*`
  skipped; links never followed), read with the deploy's own rewrite awk (ARG scope,
  stage order). Each section counts only with its end marker;
- a name a build writes (a build service's `image:`, its compose default
  `<project>-<service>`, `build.tags`) is refused, code `image_owner`, high, never
  exemptable, when another project built or runs that repo; when a Dockerfile of another
  app on the server reads it (except a name starting with the app or project name, and a
  name with a registry host this project already built or runs: another app cannot take
  an app's own image away by naming it); or when it is a Docker Hub namespace name
  (`<ns>/<name>`, no registry host) not starting with the app or project name;
- the deploy's authority carries the owned repos (`dockerfileImageAuthority(ctx,
  config).owned`, shell `DFR_OWNED`): `dfr_own` exempts a ref only when the server's build
  list names it AND it is owned. `DFR_OWNED='*'` (the build list alone) only when there is
  no authority at all (warn mode with an unreadable compose probe, already UNCHECKED);
- provenance (`dfr_prov`): an image a build reads that is not the app's own must be one
  powder pulled itself. A digest ref names content (pulled only when missing). A tag
  passes when its local image ID is in `/var/lib/powder/image-pulls` (root, 0700 dir;
  `DFR_PROV_FILE` in tests) and the image has no compose project label. Anything else is
  pulled anonymously over the tag (the registry's image replaces a shadowing local build)
  and its ID recorded; a failed pull, or a pulled image with a compose project label, is
  refused. Every `FROM` base goes through it in every guard mode; a `COPY --from` / `RUN
  --mount from=` ref with `POWDER_BUILD_PULL=0` with the guard mode (enforce refuses,
  warn logs `dockerfile_image`);
- test gate: a failed pull of the `# powder-test-image:` falls back to a local copy only
  for a digest pin whose local copy has that digest and no compose labels.

An app's built image stays its own (local names, compose default names and registry
images; a worker running its app's image in the same project passes).

Residuals: an unlabelled local image no container runs has no owner (a project that
builds it later can claim it); `COPY --from` refs are checked and pulled but not pinned,
so a re-tag between the check and the build is not caught (a `FROM` is pinned).

## Registry logins: one authority

This is the primary control for root's registry logins; the per-path rules in the next
section stay as defense in depth.

powder runs every remote command over ssh as the server's ssh user (usually root, home
/root). Without this the docker CLI would read `/root/.docker/config.json` and send root's login
with every pull, push, run, create and compose call
(X-Registry-Auth) and every build (BuildKit's session auth provider, the classic builder's
X-Registry-Config). dockerd holds no credentials of its own. The per-path rules close the
ways an app could make docker use that login for an image it does not own (`pull_policy` on a
build service, image refs in Dockerfiles, the test image, rollback pulls), but a base
image's `ONBUILD` trigger (`FROM attackerhub/base` whose `ONBUILD COPY
--from=ghcr.io/<victim>/...` runs in the app's build) cannot be closed by a rule on the
app's own files at all. So the login is taken away, in one place
(`apps/web/src/lib/docker-env.ts`):

- `sshCommand()` wraps every ssh exec powder makes: `runCommand` (every deploy, rollback,
  recreate, probe, cron and backup command), the log stream (`ssh/logs.ts`) and the
  builder's image stream (`builder.ts`, both ends). Nothing is exempt, powder's own
  self-deploy included (its images are public or pinned). It puts `NOCREDS_PREFIX` first:
  `unset DOCKER_AUTH_CONFIG`, make sure `/run/powder-docker-nocreds` is a root-owned 0755
  directory holding `config.json` (0644) with exactly `{"auths":{},"credHelpers":{}}`
  (rewritten through a temp file + `mv` when it differs), and `export
  DOCKER_CONFIG=/run/powder-docker-nocreds`. A symlinked dir or `config.json`, a
  `config.json` that is not a regular file, a dir the ssh user does not own or a write
  that fails refuses the whole command (exit 97, a `[powder] refusing to run` line on
  stderr). `/run` is root-only tmpfs, so no app can plant it; a non-root ssh user gets
  `$HOME/.powder-docker-nocreds` instead. Every docker call in the command (the CLI, the
  compose and buildx plugins, `setsid`-detached children, scripts written to disk and
  run with `bash`) inherits it. Public images still pull anonymously; a private image
  fails closed with the registry's own "unauthorized" / "denied" error.
- `withRegistryCreds(cmd, decision)` is the only producer of `DOCKER_CONFIG=/root/.docker`.
  It takes one `docker push '<ref>'` or `docker pull '<ref>'` and a decision that
  `deployPushDecision` (deploy-push-policy.ts) issued and that allows it; a literal object,
  a refusal or any other command throws. Two callers: the rollback tag push
  (`tagDeployCommand`) and the pull of a rollback target that is not on the server
  (`rollbackTargetShell`). Both already followed the rollback tag push rule (below).
- The compose check probe still reads root's login hosts for the owner rules below, from
  `/root/.docker/config.json` explicitly (`REGISTRY_LOGIN_HOSTS_SHELL`), never from
  `$DOCKER_CONFIG`.
- The snapshot and atomic-rollback `docker run` and the zero-downtime bridge's
  `docker create` pass `--pull=never` (their image is always local).

What this covers: `compose build --pull` and the label step's builds, `compose pull`
(registry mode and the label step), the release `docker run`, the swap check, every
`compose up` (deploy and `composeUpCommand`), the builder's `docker build --pull`, the
test gate's pull, base-image `ONBUILD` triggers and any other docker call, since
none of them has a login to send.

Registry mode: its `docker compose pull` runs without root's login: a private image of the app's own
fails closed (the old container keeps serving). Public images pull as usual. Give such an
app a build, or a registry the server can read without a login.

Install note: the compose and buildx plugins must live in a system plugin dir (such as
`/usr/libexec/docker/cli-plugins`) so they are found with an empty `DOCKER_CONFIG`. A
`credsStore`, `credHelpers` or `docker-credential-*` helper in root's config is not used
by the login-free config. `bin/fleet-check.sh` re-checks the helpers and the
`config.json` on every registered server.

Guard test: `lib/__tests__/docker-creds-authority.test.ts` (every ssh2 `.exec(` wraps
`sshCommand(`; the login tokens appear only in the authority, the probe and its two
users; no host command resets the environment; the wire commands of `runCommand`, the log
stream, the tag push, the rollback, the snapshot and the atomic rollback start with the
prefix and the only credentialed docker commands are the push and the rollback pull; the
deploy, builder, compose up, bridge and test gate scripts carry no creds of their own).

## Registry logins: per-path rules

(Since the authority above, builds and pulls run WITHOUT root's logins; these rules
stay as defense in depth.) Builds and pulls ran as root with root's registry logins. A private repo another project pushed elsewhere is not on this server, so no rule
above knows it, but root's login can pull it. The compose check probe reads the registry
host names root is logged in to (`REGISTRY_LOGIN_HOSTS_SHELL` in build-cache.ts: the key
names of `$DOCKER_CONFIG/config.json` or `~/.docker/config.json`, `auths` and
`credHelpers`, host-shaped names only, never a credential; Docker Hub is left out, or
every `node:*` base would be refused). Unreadable or missing: `ghcr.io`. On such a
registry an image that is pulled or read as a source (a non-build `image:`, a Dockerfile
`FROM` / `COPY --from` / `--mount from=`) must be the app's own: its last path segment is
the app name. A name a service of this compose builds does not count, and
`DFR_OWN` does not exempt a ref from this rule (it still exempts the local-image rules):
the app picks those names, so building `ghcr.io/<org>/<other>` must not license pulling
it. What a build service TAGS keeps its existing rules (`image`, `image_name`), so
builds tagged under a ghcr name other than the app name pass as before. Else a non-build `image:` is a high `image` finding, and a
`FROM` / `COPY --from` / `RUN --mount from=` ref is refused on the server in EVERY guard
mode, deploy and builder alike (`loginRegistryForeign` in compose-safety.ts, the awk twin
in `DFR_FOREIGN_AWK`). The other `dockerfile_image` findings (another app's local image)
keep enforce-refuse / warn-WARN. The build server adds the hosts its own root is logged in
to (the dedicated builder may differ from the app's server), and the builder always builds
with `--pull`. A worker service running its own app's `ghcr.io/<org>/<app>` passes. A
private Docker Hub repo root's Hub login can read is not covered (residual).

A service WITH a build section is outside that rule, and `pull_policy: always`
(or `daily`, `weekly`, `refresh`, `every_<d>`) would make compose pull its `image:` (any ghcr
repo) with root's login and run it. Three layers close that:

- compose rule `pull_policy`, high, never exemptable (`checkBuildPullPolicy`): on a
  service with a build, only no policy, `missing`, `if_not_present`, `never` or `build`
  pass. Services without a build keep `pull_policy` free (their image goes through the
  login rule above).
- deploy shell (`serviceImageLabelGuardShell`): a service the Dockerfile check lists as a
  build is never pulled. A pulling policy builds it when its image is missing and
  otherwise pins `pull_policy: missing` in `labels.yml`. Every `docker compose pull`
  powder runs (that step and registry mode) passes `--ignore-buildable`.
- recreates (`composeUpCommand`: rollbacks, domain and container apply) run
  `up --no-build`, which drops the build section, so a missing image or a pulling
  policy would make compose pull the build service's `image:`. powder's override
  (`docker-compose.powder.yml`, `renderOverride`), which every recreate and deploy reads
  (`composeFileArgs`), pins `pull_policy: never` on every service with a build
  section, except one whose own policy is `build` (rebuilt on every deploy) or `never`. Services without a build keep compose's default, so a missing public image
  (an infra db or redis pinned by digest) is still pulled. A global `up --pull never`
  is not used: an infra service whose digest-pinned image ref is not present locally
  would fail any recreate touching it. The deploy's
  label step builds a build service whose image is missing (also when its policy is
  `never`) and pins it back to `missing` in `labels.yml`, a later file. The pin reaches an
  app with its next deploy or domain apply (the override is rewritten then); until then
  a recreate uses the override it had. When the git sync changes the compose, the override is
  rendered again before the re-check, so a build service the sync added is pinned in
  the same deploy.
- a rollback whose target `<repo>:deploy-<id>` is not on the server pulls it (as
  root, with root's logins) only from a repo the app owns under the rollback tag push
  rule (`deployPushDecision`, see "Registry logins"); a local image, an unregistered
  container or a repo another app owns refuses the rollback with the reason.

powder's own `labels.yml` pins only `missing` / `never`, and its override only `never`,
so both pass the compose rule.

Dedicated builder (`builder.ts`): the build server runs build code, so what it sends
back is checked on the target. The streamed tar goes into `docker load` as root, which
applies every name in the tar: every `Loaded image:` line must be the deploy's unique
`<image>-b<id>` tag (or its `docker.io/...` form); any other name is untagged again and
the stream fails before the retag (`targetImageLoadShell`; an image such a name pointed
to before is not restored). The built commit is read only from a marker with the phase's
random nonce (`parseBuiltSha`, like the deploy's synced-sha marker). An untagged
`image:` gives the unique tag `<image>-b<id>`, which docker load reports with `:latest`;
that form is accepted too. The build facts
(image, context, dockerfile, args) come from the same compose files and override the
guard checked (`guardCf`), and a dockerfile outside the build context (absolute) or
outside the checkout (relative `../`) is refused (the deploy falls back to a local build).

The test gate's `# powder-test-image:` is pulled as root too: before the pull the
same login branch of `DFR_FOREIGN_AWK` runs on it (self = the app, the probed login hosts
plus root's own on the server), in every guard mode. A digest pin does not exempt it. A public
image such as `node:22-alpine` passes.

Rollback tag push: after a healthy deploy powder tags the image `<repo>:deploy-<id>`
and, for a registry repo, pushes it as root with root's logins. `deployPushDecision`
(deploy-push-policy.ts, history read by deploy-push.ts) allows the push only to a repo
this app pushed on a successful deploy that started before the `deploy_push_cutoff`
powder_meta row (migration 0058), unless another registered app pushed that repo more
recently (the most recent pusher owns a shared repo), or, for an app with no push history
before the cutoff, to a repo whose last path segment is the app name that no other
registered app pushed. Deploys after the cutoff are not evidence (image_tag is recorded
when the push is skipped too). Otherwise the tag stays local and the log says `WARN not
pushing ...`; the deploy succeeds. No cutoff row or a DB error: no push. An app with push
history keeps pushing to a repo named unlike the app; of two apps sharing one repo, the
one that pushed it last keeps pushing and the other one gets the WARN.

## Exemptions (operator only)

`POWDER_COMPOSE_GUARD_EXEMPT` in powder.env (worker and web), JSON keyed by
`<serverId>/<app>` or `<app>`, values are codes:

```
POWDER_COMPOSE_GUARD_EXEMPT={"db-server/billing-api":["network_mode"],"db-server/billing-worker":["network_mode"]}
```

A value may also be an object of code -> allowed values, so the exemption covers
only those: an exact value, or a prefix ending in `/` (the folder and anything inside)
or `*`. Values exist for `network_mode`, `pid`, `ipc` (the mode), `bind` (the
absolute source or volume device) and `env_loopback` (the variable name):

```
POWDER_COMPOSE_GUARD_EXEMPT={"db-server/forms":{"network_mode":["host"],"bind":["/srv/data/"]}}
```

Whatever the form, an exemption never allows: `network_mode`, `pid` or `ipc` of a
container that is not this project's (`container:<x>` with a powder name, another
project's container or an unknown one; `service:<x>` not in this compose), or a bind /
volume device of `/`, `/etc`, `/root`, `/var/run`, `/run`, `/var/lib`, `/var/spool`,
`/var/log`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, `/libx32`, `/home`, `/proc`,
`/sys`, `/dev`, `/boot`, `/opt/apps` (anything inside them, or a folder above them such
as `/var` or `/opt`), a `docker.sock`, another app's `/opt/apps/<other>...` path (the
longest registered name decides; powder's names count as others), the app dir itself,
or its compose files, `.deploy-key`, env file and git metadata (inside them or a folder
above them, so `./src` with `src/.git` too). `/srv`, `/opt/apps/<app>-*` and other
folders of the app dir stay exemptable. A bare `<app>`
key keeps working (it matches that app name on every server) and logs
`[compose-guard] WARN <app> exempt_key ...` on every deploy: prefer `<serverId>/<app>`.

The deploy log names the exempt codes on every deploy. Keep the list short; it is
the shrink-only allow-list of this guard.

## What changed: the refusal names it

A successful deploy stores, next to `deploys.compose_config_hash`, a view of the same
compose structure (`deploys.compose_config_view`, migration 0062; built by
`apps/web/src/lib/deploy/compose-diff.ts`). Per service and key it keeps the values that
are safe to print (`network_mode`, `ports`, binds, the image repo, `networks`,
`cap_add`, ...) and, for every key that can hold a secret (`labels`, `build`, `command`,
`healthcheck`, any key not on the shown list, every top-level key), only the key names
with a 12-character keyed hash of each value: HMAC-SHA256 keyed by
`POWDER_ENCRYPTION_KEY` and a random salt stored in the view, so a copy of the database
alone cannot test guesses of a label value offline. The diff hashes the probed config
with the stored view's salt. No `environment` value is ever in it.

When the probed config differs from the last successful deploy, the guard prints one
line per changed key under the finding list (and in the deploy log when it passes):

```
What changed since the last successful deploy (environment values are never shown):
  services.app.labels: added powder.bridge.enabled, powder.bridge.host-port
  services.app.network_mode: host -> (unset)
  services.app.ports: added 127.0.0.1:3004:3004
A hand edit of the compose on the server (/opt/apps/<app>/docker-compose.yml) changes it as much as a repo commit does.
```

A changed config runs every high-severity rule again, so a refusal can name an old
finding (a grandfathered bind) that the change did not touch; the list says what the
change really was. When the last successful deploy has no stored view, the refusal says
no copy is stored, and the next successful deploy records one.

## Modes (default: enforce)

- **enforce (default: `POWDER_COMPOSE_GUARD` unset, `enforce`, or any value other than
  `warn`):** findings, an unreadable config and a changed config refuse the deploy
  before anything is built (old container serves).
- **warn (`POWDER_COMPOSE_GUARD=warn`, opt-out for an existing install that is still
  collecting findings):** a compose identical to the last successful deploy's is
  never refused. Every finding is one log line `[compose-guard] WARN <app> <rule-code> <detail>`;
  an unreadable config logs `WARN <app> probe ... UNCHECKED` (also in powder's own log)
  and the deploy continues unchecked. The probe's sections are split by a random
  per-probe separator and aliases are read as JSON, so nothing a container names can
  make the probe unreadable or move a name to another container.
- **warn, repo-changed compose:** when the config hash moves during the git
  sync or before `compose up` (a tracked compose file in the workdir layout, a
  tracked env_file/include, ...), the script logs `WARN <app> config_changed ...` and
  stops before anything is built; powder re-checks the NEW config once and runs the
  script again. The re-check ENFORCES the high-severity codes only when the
  structural hash (see below) differs from the last successful deploy's, or, with no
  stored hash yet, from this deploy's first check: the tripwire hashes the full
  config, so an env value or image tag edit fires it without changing the structure,
  and such a change keeps plain warn. Every code is high
  severity except the explicit low list (`LOW_SEVERITY_CODES` in compose-safety.ts),
  which holds only `shape` (the compose or a service is not a mapping; docker compose
  refuses such a file anyway). A code added later is high by default; unknown keys
  and every `security_opt` value other than no-new-privileges are high. The second run pins the
  hash the re-check approved and refuses if it moves again.
- **warn, config differs from the last successful deploy (0056):** every successful
  deploy stores a STRUCTURAL hash of its compose config (`deploys.compose_config_hash`,
  `structuralComposeHash` in deploy/compose-check.ts). The next deploy enforces the
  high-severity codes when the probed config's structural hash differs from the stored
  one. A change cannot slip through in two pushes (the first refused, its tree left on
  disk, the second with nothing to move the in-deploy hash). No stored hash yet (no
  successful deploy stored one, e.g. a new app): warn only, and that deploy's hash becomes
  the baseline when it succeeds.
  What is hashed: the resolved `docker compose config --format json` of the app's own
  compose files with the project `.env` interpolation applied, WITHOUT powder's override
  file (`docker-compose.powder.yml`), plus the env_file / label_file paths from the
  `--no-interpolate` config, with every service's `environment` removed (env_file
  contents and inline values) and every `image` reduced to its repository (no tag, no
  digest), keys sorted. So an env var edit in powder, a new image tag or a domain label
  powder writes into its override is not a compose change; a tracked `.env` value that
  feeds an interpolation (`${DATA_DIR}:/data`), a new or moved env_file path, bind,
  capability, network, build section, label in the app's compose, secret or volume is.
  One caveat: an app whose rendered env file is the project `.env` next to its compose
  and whose compose interpolates one of those values outside `environment` (e.g.
  `ports: ["${PORT}:3000"]`) sees an edit of that value as a change. (The tripwire hash
  the deploy script pins between the check and `compose up` is a different, full
  hash: it still catches a tracked `.env` changing during the git sync.)
  After any compose-guard refusal powder resets `src/` to the last successful commit
  (workdir layout: the tracked extra compose files go back to that commit;
  the stored hash still forces the re-check, at the next deploy and every recreate). An app whose compose needs one of those codes needs an exemption, or its
  next compose change is refused, e.g. an app `forms` in the workdir layout whose repo
  tracks a `docker-compose.prod.yml` with `network_mode: host`:
  `POWDER_COMPOSE_GUARD_EXEMPT={"forms":["network_mode"]}`. Without it, a commit
  that changes that file is refused (the old container keeps serving).
- Other WARN codes in deploy logs: `tracked_compose` (workdir layout: an extra compose
  file the repo tracks; the repo copy wins), `testgate_pull`,
  `testgate_labels` (the test gate, see content/docs/deploys.md). Enforce mode
  refuses each of them. The test-gate IMAGE allow-list (`node:<tag>` or a
  digest-pinned ref) is enforced in every mode, and so is the pull fallback: when
  the pull fails, only a digest-pinned image whose local copy has exactly that digest
  and no compose labels runs; a tag is refused (a RepoDigest is no proof of a pull).

"another app's image" for a service WITHOUT a build (code `image_foreign`) only counts
images run by RUNNING containers of another compose project (`image`: the main
images and compose-built images of other projects, any state, see the table); for a name a service BUILDS
(code `image`) containers of another compose project in any state count (a stopped
app's image is still its image). Hand-started (`docker run`, no compose project)
containers never count.

## Rolling out enforce on a server with existing apps

A fresh install enforces from the start. With apps that may not pass yet:

1. Set `POWDER_COMPOSE_GUARD=warn` in powder.env. Let every app deploy once, then
   collect the lines:
   `SELECT container_name, regexp_matches(output, '\[compose-guard\] WARN [^\n]*', 'g') FROM deploys WHERE started_at > now() - interval '7 days' AND output LIKE '%[compose-guard] WARN%';`
2. Fix what can be fixed; add exemptions for the rest.
3. Remove `POWDER_COMPOSE_GUARD=warn` (enforce), self-deploy. Back to warn = set it again.

## powder's own deploy

powder's self-deploy (`runSelfDeploy`) runs none of the guards in this file. It is
chosen by identity (`selfDeployDecision` in deploy/self-deploy.ts), never by the compose
service label: the container is `POWDER_SELF_CONTAINER` (default `powder`), the server
is `POWDER_SELF_SERVER_ID`, the container's compose project is that container's project
name, its service is `POWDER_SELF_SERVICE`, and with `POWDER_SELF_SRC` or `POWDER_SRC`
set its working dir and compose file sit under that source dir's parent. Any other
container takes the normal guarded deploy. The self container with
`POWDER_SELF_SERVER_ID` unset, or with another project, service or dir, is refused. The
overlay files (`docker-compose.shared-db.yml`, `docker-compose.unharden.yml`,
`docker-compose.web-readonly.yml`) are read only from the dir of powder's compose file,
and only when each is a regular file there (a missing one or a link is refused before
anything runs). An app's service key or `container_name` equal to the self service or
container name is a high finding on any network.

## Known residual: the build override set

The per-deploy override set (`/var/lib/powder/compose/<key>/dfr/`: rewritten
Dockerfiles, their override, `labels.yml`) is installed when the Dockerfile check
passes, before the build, the test gate, the swap and the health gate. A deploy that
fails later leaves the new set in place while the running container's `config_files`
label still names that path. Moving the install to the swap gate is not a contained
change: the build, the image-label step, the hash pin and the `up` all read those
paths. The effect is limited: recreates outside a deploy run with `--no-build` (the
Dockerfile paths are not used) and re-run the compose guard on the files on disk first,
and the next deploy replaces the set.

## Backup DB container

Backups and restores use `backup_db_container`, else `<app>-db`. Only an admin browser
session sets `backup_db_*` and `has_postgres` (`PATCH /api/projects/<id>`, session-only
action `backup_db`): the container it names is dumped, downloaded and restored into. `/new`, repo connect and
import refuse a name `<other>-db` for a registered `<other>`, and `<name>` when `<name>-db`
is registered (`appNameDbClash`, lib/backup-db-owner.ts). A backup or restore with the
default `<app>-db` refuses a container whose `com.docker.compose.project` label names
another project (no label, or the app's own project, passes).
