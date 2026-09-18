import assert from 'node:assert/strict';

export function stableValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (value instanceof Date) return value.toISOString();
    return value;
}

export function stableRows(rows) {
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, stableValue(value)])));
}

function containsTable(sql, table) {
    return new RegExp(`(?:^|[^a-zA-Z0-9_])${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-zA-Z0-9_])`, 'i').test(sql);
}

function expectedValues(expected) {
    return expected.rows.flatMap((row) => Object.values(row)).filter((value) => value !== null && String(value).length > 1);
}

export function scoreAgentCase(testCase, evidence) {
    const completed = evidence.status === 'completed';
    const answer = String(evidence.answer ?? '');
    const artifacts = evidence.artifacts ?? [];
    if (testCase.type === 'semantic') {
        const required = testCase.expected.must_include_concepts;
        const forbidden = testCase.expected.must_not_claim;
        const included = required.filter((concept) => answer.includes(concept)).length;
        const forbiddenHits = forbidden.filter((claim) => answer.includes(claim));
        const correctness = required.length ? included / required.length : 1;
        return {
            id: testCase.id,
            passed: completed && correctness === 1 && forbiddenHits.length === 0,
            score: Math.round((completed ? 20 : 0) + correctness * 60 + (forbiddenHits.length === 0 ? 20 : 0)),
            checks: { completed, requiredConceptRecall: correctness, forbiddenHits },
        };
    }

    const exactArtifact = artifacts.find((artifact) => {
        try {
            assert.deepEqual(stableRows(artifact.rows), testCase.expected.rows);
            return true;
        } catch {
            return false;
        }
    });
    const sqlText = artifacts.map((artifact) => artifact.originalSql ?? '').join('\n');
    const tablesFound = testCase.tables.filter((table) => containsTable(sqlText, table));
    const tableRecall = testCase.tables.length ? tablesFound.length / testCase.tables.length : 1;
    const values = expectedValues(testCase.expected);
    const answerValueRecall = values.length ? values.filter((value) => answer.includes(String(value))).length / values.length : 1;
    const dimensions = {
        sqlExecution: completed && artifacts.length > 0 ? 15 : 0,
        tableAndJoinSelection: 20 * tableRecall,
        metricDefinition: exactArtifact ? 25 : 0,
        numericAccuracy: exactArtifact ? 25 : 0,
        conclusionAndCaveats: 15 * Math.min(1, answerValueRecall),
    };
    const score = Math.round(Object.values(dimensions).reduce((sum, value) => sum + value, 0));
    return { id: testCase.id, passed: score >= 80 && Boolean(exactArtifact), score, checks: { completed, tableRecall, exactResult: Boolean(exactArtifact), answerValueRecall }, dimensions };
}

export function summarizeReport(results, thresholds) {
    const overallScore = results.length ? results.reduce((sum, item) => sum + item.score, 0) / results.length : 0;
    const passRate = results.length ? results.filter((item) => item.passed).length / results.length : 0;
    const summary = { cases: results.length, passed: results.filter((item) => item.passed).length, overallScore: Number(overallScore.toFixed(2)), passRate: Number(passRate.toFixed(4)) };
    return { summary, gate: { passed: overallScore >= thresholds.minimumOverallScore && passRate >= thresholds.minimumPassRate, thresholds } };
}
