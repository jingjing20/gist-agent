const sensitive = (key: string) => /authorization|apikey|password|secret|cookie/.test(key.toLowerCase().replace(/[^a-z0-9]/g, '')) || /token$/.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
function clean(value: unknown, depth: number): unknown {
    if (depth > 24) return '[REDACTED_DEPTH_LIMIT]';
    if (typeof value === 'string') {
        // Tool arguments/results are often JSON strings inside message content.
        if (value.length <= 32768 && /^\s*(?:\{|\[)/.test(value)) {
            try {
                return JSON.stringify(clean(JSON.parse(value), depth + 1));
            } catch {
                /* Partial streamed arguments remain text. */
            }
        }
        return value
            .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, '[REDACTED_AUTH]')
            .replace(/\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s"'<>]+/gi, '[REDACTED_CONNECTION]')
            .replace(
                /((?:api[_-]?key|password|authorization|client[_-]?secret|(?:access|refresh|session|writer|id)[_-]?token|cookie)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"'<>}]+)/gi,
                '$1[REDACTED]'
            )
            .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]');
    }
    if (Array.isArray(value)) return value.map((child) => clean(child, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sensitive(key) ? '[REDACTED]' : clean(child, depth + 1)]));
    return value;
}
// SDK snapshots and filters objects before this bounded additional text/JSON redactor.
export function redactText(value: unknown): unknown {
    return clean(value, 0);
}
