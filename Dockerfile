# Single image for web, worker and migrations.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Same npm major as development, so a lockfile written locally always installs here.
RUN npm install -g npm@11.12.1 && npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time placeholders only; real secrets come from the runtime environment.
RUN SESSION_SECRET=build-placeholder-0000000000000000000000 TOKEN_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
# Reads the General Assembly's PDFs and lists its FTP folders for the scheduled refresh.
RUN apk add --no-cache poppler-utils curl
# Owned by the runtime user so Next's cache is writable.
COPY --from=build --chown=app:app /app ./
USER app
EXPOSE 3000
# Migrations run before the server starts. The demo environment (APP_ENV=demo) also loads its
# synthetic data on first start; the seed does nothing when the demo office already exists.
# Both use MIGRATION_DATABASE_URL (the login that owns the tables) when set; the server itself
# starts without it and connects with DATABASE_URL, a login that cannot change the schema.
CMD ["sh", "-c", "DATABASE_URL=\"${MIGRATION_DATABASE_URL:-$DATABASE_URL}\" npx tsx scripts/migrate.ts && if [ \"$APP_ENV\" = demo ]; then DATABASE_URL=\"${MIGRATION_DATABASE_URL:-$DATABASE_URL}\" npx tsx scripts/seed-demo.ts; fi && exec env -u MIGRATION_DATABASE_URL npx next start -p \"${PORT:-3000}\""]
