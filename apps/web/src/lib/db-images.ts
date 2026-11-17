// ONE authority for the bundled database/cache images of new apps. Exact
// version tags AND digests: a floating tag (pg16, 16, 16-alpine, latest) moves
// under running apps and restarts every database on the next pull, and
// version tags get rebuilt too.
// Digests are the multi-arch index digests from Docker Hub. Bump deliberately;
// guarded by __tests__/db-image-pin.test.ts.
export const POSTGRES_IMAGE =
	'postgres:16.15-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab'
export const REDIS_IMAGE =
	'redis:7.4.12-alpine@sha256:8da19c7399dca900c6822a1cf30f9d2285585e2c4b457ff4095b0f4500054d3f'
