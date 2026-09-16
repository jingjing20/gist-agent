import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AGENT_RUNTIME_VERSIONS, GENERATION_ERROR_CODES } = require('../packages/contracts/dist/index.js');
const { GenerationExecutionError, normalizeGenerationError } = require('../apps/worker/dist/chat/generation-errors.js');

for (const [component, version] of Object.entries(AGENT_RUNTIME_VERSIONS)) {
  assert.match(version, /^[a-z][a-z-]+-v\d+$/, `${component} must use a stable version identifier`);
}
assert.equal(new Set(GENERATION_ERROR_CODES).size, GENERATION_ERROR_CODES.length, 'generation error codes must be unique');

const timeout = normalizeGenerationError(
  new GenerationExecutionError('ANALYSIS_TIMEOUT', 'analysis timed out'),
  { ownershipLost: false, aborted: false },
);
assert.equal(timeout.code, 'ANALYSIS_TIMEOUT');
assert.equal(timeout.message, 'analysis timed out');

const ownership = normalizeGenerationError(new Error('transport failed'), { ownershipLost: true, aborted: true });
assert.equal(ownership.code, 'WRITER_OWNERSHIP_LOST');

const cancellation = normalizeGenerationError(new Error('aborted'), { ownershipLost: false, aborted: true });
assert.equal(cancellation.code, 'CANCELLED');

const unknown = normalizeGenerationError(new Error('unexpected'), { ownershipLost: false, aborted: false });
assert.equal(unknown.code, 'INTERNAL_ERROR');
assert.equal(unknown.message, 'unexpected');

console.log('generation baseline regression: PASS');
