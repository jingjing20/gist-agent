export interface ModelCapability {
    contextWindow: number;
    responseReserve: number;
}

const MODEL_CAPABILITIES: Array<{ pattern: RegExp; capability: ModelCapability }> = [
    { pattern: /gpt-4o|gpt-4\.1|gpt-5/i, capability: { contextWindow: 128_000, responseReserve: 8_000 } },
    { pattern: /deepseek/i, capability: { contextWindow: 64_000, responseReserve: 8_000 } },
    { pattern: /moonshot|kimi/i, capability: { contextWindow: 128_000, responseReserve: 8_000 } },
];

export function resolveModelCapability(model = process.env.OPENAI_MODEL || 'gpt-4o', overrides: { contextWindow?: number; responseReserve?: number } = {}): ModelCapability {
    const known = MODEL_CAPABILITIES.find((entry) => entry.pattern.test(model))?.capability ?? { contextWindow: 32_000, responseReserve: 4_000 };
    const configuredContext = Number(process.env.MAX_CONTEXT_TOKENS);
    const configuredResponse = Number(process.env.RESPONSE_RESERVE_TOKENS);
    return {
        contextWindow: positiveInteger(overrides.contextWindow) ?? positiveInteger(configuredContext) ?? known.contextWindow,
        responseReserve: positiveInteger(overrides.responseReserve) ?? positiveInteger(configuredResponse) ?? known.responseReserve,
    };
}

function positiveInteger(value: number | undefined): number | undefined {
    return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : undefined;
}
