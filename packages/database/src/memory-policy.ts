import type { DatasourceMemory, MemoryContent, RelatedMemory } from '@gist/contracts';

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const compact = (text: string) => normalize(text).replace(/[\p{P}\p{Z}]/gu, '');
function grams(text: string): Set<string> {
    const chars = [...compact(text)];
    return new Set(chars.slice(0, -1).map((c, i) => c + chars[i + 1]));
}
function similarity(a: string, b: string): number {
    const left = grams(a),
        right = grams(b);
    if (!left.size || !right.size) return 0;
    const common = [...left].filter((g) => right.has(g)).length;
    return common < 3 ? 0 : (2 * common) / (left.size + right.size);
}

export function relatedMemories(content: MemoryContent, memories: DatasourceMemory[], excludeId?: string): RelatedMemory[] {
    return memories
        .filter((m) => m.status === 'active' && m.id !== excludeId)
        .map((memory) => {
            const sameName = normalize(content.name) === normalize(memory.name);
            const sameContent = compact(content.description) === compact(memory.description);
            const score = sameName ? 3 : sameContent ? 2 : Math.max(similarity(content.description, memory.description), similarity(content.name, memory.name));
            const reason: RelatedMemory['reason'] = sameName ? 'same_name' : sameContent ? 'same_content' : 'similar_content';
            return { memory, reason, score };
        })
        .filter((match) => match.score >= 0.55)
        .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
        .slice(0, 5)
        .map(({ memory, reason }) => ({ memory, reason }));
}

export interface MemoryIntent {
    mode: 'save' | 'review';
    content?: MemoryContent;
    reason: string;
}

/** Conservative syntax boundary; ambiguous language is left to a reviewed proposal. */
export function parseMemoryIntent(message: string): MemoryIntent | null {
    const match = message.match(/^\s*(?:请|帮我|请帮我)?记住(?:这条|以下|下面)?(?:规则|口径|信息|内容)?\s*[：:，,]\s*([\s\S]+)$/);
    if (!match) return null;
    const body = match[1].trim();
    const request =
        /(?:另外|此外|然后|顺便|同时)?\s*(?:请(?:你)?|帮我|请帮我|再帮我)?\s*(?:分析一下|分析(?!口径|规则|方法)|查一下|查询(?!规则|条件)|查查|看看|看一下|看下|查下|统计一下|统计(?!口径|规则|时间|周期|范围|单位|粒度|窗口|方式)|计算一下|计算(?!口径|规则|方式|公式|方法)|算一下|画出|画一下|画图|绘制|展示|生成图表|对比一下|对比(?!口径|规则|范围)|告诉我|给我)/;
    const startsRequest = new RegExp(`^${request.source}`);
    const embeddedRequest = new RegExp(`(?:请(?:你)?|帮我|另外|此外|然后|顺便|同时|并|再)\\s*${request.source}`);
    const boundary = /[。；;\n]|[，,](?=\s*(?:另外|此外|然后|顺便|同时|请|帮我|再帮我))/g;
    let description = body;
    let mixed = false;
    for (const separator of body.matchAll(boundary)) {
        if (startsRequest.test(body.slice(separator.index! + separator[0].length).trim())) {
            description = body.slice(0, separator.index).trim();
            mixed = true;
            break;
        }
    }
    // Do not turn a question, unresolved reference or an unsplit command into knowledge.
    if (!description || /[?？]|(?:这个|那个|上述|刚才|之前)(?:规则|口径|结论|说法)?/.test(description) || startsRequest.test(description) || embeddedRequest.test(description))
        return { mode: 'review', reason: '记忆内容边界或指代不明确，需要提炼或澄清后确认。' };
    const content = { name: description.split(/\n/)[0].slice(0, 80), description };
    const modification = /修改|更正|改为|改成|替换|更新|不再|以后|今后|从现在起/.test(description);
    return {
        mode: mixed || modification ? 'review' : 'save',
        content,
        reason: mixed ? '消息同时包含记忆和分析请求，已分离记忆内容，请检查后保存。' : modification ? '这可能修改已有口径，请核对后保存。' : '',
    };
}
