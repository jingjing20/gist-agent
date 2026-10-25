# Local AgentScope packages

Fixed archives for reproducible installs outside local source development. SDK structured stream output is built from AgentScope c77a38b; management conversation contracts from f117987. Local development uses `pnpm agentscope:local` instead. No credentials, environment files or business data are included. Root pnpm.overrides resolves contracts to the adjacent archive. Updating either archive requires updating and verifying pnpm-lock.yaml.

SHA-256:

- agentscope-contracts-0.0.0.tgz: `58272f3eebe73e8c1d0971a56517a64100c4202a3f21c17cc8adbc4d51267c9a`
- agentscope-sdk-0.0.0.tgz: `38647ee228167d6527eef1855a58688b4dec1aa077d4bec85459f626887fb52a`
