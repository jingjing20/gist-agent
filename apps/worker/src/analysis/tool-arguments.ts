export function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('必须提供对象');
    return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
    const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unexpected.length) throw new Error(`存在不允许的字段：${unexpected.join('、')}；只允许字段：${allowed.join('、')}。请删除多余字段后重试。`);
}
