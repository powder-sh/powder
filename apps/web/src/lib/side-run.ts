// the one hardening set for every container powder starts with a plain `docker run`
// or `docker create` (outside compose): URL snapshots, the rollback and zero-downtime
// bridges, the test gate, the pg_dump / psql tool runs, powder-migrate's psql, the
// Traefik bootstrap. Docker's default capability set keeps NET_RAW, which lets a
// container forge ARP and raw packets on a shared bridge (`web`) or, with `--network
// host`, on the server itself; no-new-privileges stops a setuid binary in the image from
// gaining privileges back.
//
// Shell files that run on servers (infra/powder-migrate, bin/server-bootstrap.sh) cannot
// import this module: they carry the same flags literally. The guard test
// (__tests__/side-run-harden.test.ts) reads every `docker run` / `docker create`
// powder generates or ships and fails when one lacks a cap drop or no-new-privileges.

/** Minimum for a container that runs an app image or a server image (Traefik, a
 *  postgres server): NET_RAW dropped, no privilege gain through exec. The image may
 *  still need its other default capabilities (an entrypoint that chowns and drops to a
 *  service user). */
export const SIDE_RUN_CAPS = '--cap-drop NET_RAW --security-opt no-new-privileges'

/** A client tool run (psql, pg_dump) that needs no capability at all. */
export const TOOL_RUN_HARDEN = '--cap-drop ALL --security-opt no-new-privileges'
