-- Runs on the compose `db` service's FIRST init only (docker-entrypoint-initdb.d
-- is skipped once the data volume exists). The hub needs its own database on the
-- shared Postgres server.
-- On a pre-existing volume, create it manually:
--   docker compose exec db psql -U postgres -c 'CREATE DATABASE hub'
CREATE DATABASE hub;
