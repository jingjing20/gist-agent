export interface MemoryContent {
    name: string;
    description: string;
}
export interface DatasourceMemory extends MemoryContent {
    id: string;
    datasourceId: number;
    version: number;
    status: 'active' | 'deleted';
    source: 'manual' | 'conversation';
    createdBy: number;
    confirmedBy: number;
    sourceMessageId: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface MemoryCandidate {
    id: string;
    datasourceId: number;
    version: number;
    content: MemoryContent;
    memoryId: string | null;
    expectedVersion: number | null;
    sourceMessageId: string;
    generationId: string;
    status: 'pending' | 'accepted' | 'rejected';
}

/** Advisory text matches, never a semantic conflict verdict. */
export interface RelatedMemory {
    memory: DatasourceMemory;
    reason: 'same_name' | 'same_content' | 'similar_content';
}

export interface MemoryNotice {
    status: 'saved' | 'pending' | 'review_required' | 'not_saved';
    datasourceId: number;
    message: string;
    memory?: DatasourceMemory;
}
