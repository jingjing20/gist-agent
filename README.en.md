# Gist Agent

Upload CSV / Excel files, analyze data with natural-language questions, and inspect query results, SQL and supporting evidence.

English · [简体中文](README.md)

## Capabilities

Datasource permissions, multi-sheet uploads, a single tool-using analysis agent, charts and tables, versioned datasource memories, schema-comment suggestions, background tasks, cancellation and SSE recovery.

The Vue 3 / Pinia / ECharts frontend connects to a NestJS API. A separate BullMQ / Redis Worker executes analysis; PostgreSQL stores application state and query artifacts. Models use an OpenAI-compatible Chat Completions endpoint with streaming and tool calls.

Datasources are logical workspaces in the same PostgreSQL database. External database connections are not implemented. Query artifacts support inspection; natural-language conclusions are not automatically checked number by number. Clear Chinese “记住：” instructions may save memories directly; model-proposed candidates require confirmation.

## Local setup

Use Node.js 22 and pnpm 9.15.9. Containers use PostgreSQL 17 and Redis 7.

```bash
pnpm install
cp .env.example .env
```

Preserve an existing `.env`. Set model credentials and an available model name, database credentials, JWT_SECRET, and AGENT_DB_USER / AGENT_DB_PASSWORD.

Start dependency containers:

```bash
docker compose up -d postgres redis
```

For applications running on the host, set DB_HOST=127.0.0.1, DB_PORT=15432 and REDIS_URL=redis://127.0.0.1:16379.

```bash
pnpm --filter @gist/api... --filter @gist/worker... build
pnpm init-db
pnpm dev
```

Initialization creates application tables, the default datasource and the configured read-only database role. It does not seed business data. Register an account, create a datasource and upload files; uploads to the default datasource are disabled.

Web runs at [localhost:5173](http://localhost:5173); API at [localhost:3000](http://localhost:3000). Both API and Worker must run to execute analysis. Use `pnpm typecheck` and `pnpm build` for static checks and compilation.

## Documentation

Detailed documentation is maintained in Chinese:

- [Project overview](docs/overview.md)
- [Product](docs/product.md)
- [System architecture](docs/architecture.md)
- [Agent, state, memory and evidence](docs/agent.md)
- [Three-turn walkthrough](docs/walkthrough.md)
- [Core contracts](docs/contracts.md)
- [Core workflows](docs/workflows.md)
- [Frontend](docs/frontend.md)
- [Backend and API](docs/backend.md)
- [Database](docs/database.md)
- [Capabilities and operating limits](docs/limitations.md)
- [Deployment](DEPLOY.md)

Password recovery uses SMTP and the configured APP_ORIGIN. Password changes require the current password and invalidate old JWT credentials on subsequent requests. Deployment settings and database state must be checked in the deployed environment.

[MIT license](LICENSE)
