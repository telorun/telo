# The WEB build of Telo Studio as a static-file image (`ghcr.io/telorun/studio-web`).
# Build context: the repository root (`docker build -f apps/studio/Dockerfile .`).
# The desktop build is not made here — see `.github/workflows/studio-release.yml`.

FROM node:24-slim AS build

WORKDIR /telo

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile --filter "@telorun/studio..."
# Studio's own build imports the built output of its workspace dependencies.
RUN pnpm --filter "@telorun/studio..." build

# Unprivileged: listens on 8080 and runs as a non-root user out of the box.
FROM nginxinc/nginx-unprivileged:stable-alpine AS production

COPY apps/studio/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY apps/studio/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /telo/apps/studio/dist /usr/share/nginx/html

EXPOSE 8080
