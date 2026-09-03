FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

COPY .npmrc ./
RUN echo "registry=https://registry.npmmirror.com/" > .npmrc

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json ./server/
COPY web/package.json ./web/

RUN pnpm install --frozen-lockfile

COPY web/ ./web/

RUN pnpm --filter web build


FROM nginx:alpine

COPY --from=builder /app/web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
