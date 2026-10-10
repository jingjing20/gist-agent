# Gist Agent

An experimental data analysis agent: upload CSV / Excel files, ask questions, and inspect the SQL, results, and evidence behind its answers.

English · [简体中文](README.md)

## Architecture

Vue 3 / Pinia / ECharts frontend, NestJS API, separate BullMQ / Redis Worker, PostgreSQL storage, and an OpenAI-compatible model adapter.

The single analysis agent explicitly updates task state, reads datasource memories and schema details, executes authorized SELECT queries, streams natural-language answers and records an explicit completion status. Recoverable SQL errors return to the main loop. Charts reference stored query artifacts.

Explicit "remember" requests save datasource memories directly; model-proposed memories require user confirmation. The previous memory engine and hidden SQL repair loop are retired; old conversations and database schemas are not supported.

## Local setup

Use Node.js 22 and pnpm 9.15.9 to match the containers. The dependency containers use PostgreSQL 17 and Redis 7.

```bash
pnpm install
cp .env.example .env
```

Preserve an existing .env. Set model credentials and an available model name, database credentials, JWT secret, and AGENT_DB_USER / AGENT_DB_PASSWORD.

For containerized dependencies with applications on the host:

```bash
docker compose up -d postgres redis
```

Set DB_HOST=127.0.0.1, DB_PORT=15432, and REDIS_URL=redis://127.0.0.1:16379 in .env. Existing local services may use other ports.

```bash
pnpm --filter @gist/api... build
pnpm init-db
pnpm dev
```

Initialization writes the current schema and synthetic data. Web runs at http://localhost:5173; API at http://localhost:3000. Individual processes use dev:api, dev:worker, and dev:web.

## Documentation and validation

Detailed documentation is maintained in Chinese:

- [Deployment](DEPLOY.md)
- [Design](docs/agent-refactor/README.md)
- [Delivery and validation](docs/agent-refactor/05-delivery-and-validation.md)
- [Benchmark](benchmarks/saas-growth/README.md)
- [Acceptance walkthrough](benchmarks/saas-growth/acceptance-walkthrough.md)

Fast mock checks do not establish real-model accuracy or completed interaction acceptance. Check the validation record before treating a capability as verified.

[MIT license](LICENSE)

Prompt and schema-comment workflow: [implementation and acceptance checklist](docs/prompt-refactor.md).
