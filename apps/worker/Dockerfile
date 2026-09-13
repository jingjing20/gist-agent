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
RUN pnpm install --frozen-lockfile
COPY packages/ ./packages/
COPY apps/worker/ ./apps/worker/
RUN pnpm --filter @gist/worker... build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 3001
CMD ["node", "apps/worker/dist/main.js"]
