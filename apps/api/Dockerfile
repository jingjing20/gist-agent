# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY packages/config/package.json ./packages/config/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/database/package.json ./packages/database/
COPY packages/llm/package.json ./packages/llm/
RUN --mount=type=cache,id=gist-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
COPY scripts/ ./scripts/
RUN pnpm --filter @gist/api... build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
