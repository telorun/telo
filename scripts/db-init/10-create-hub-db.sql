-- Runs on the compose `db` service's FIRST init only (docker-entrypoint-initdb.d
-- is skipped once the data volume exists). The registry and the hub share one
-- Postgres server but need separate databases — both own a `modules` table.
-- On a pre-existing volume, create it manually:
--   docker compose exec db psql -U postgres -c 'CREATE DATABASE hub'
CREATE DATABASE hub;
