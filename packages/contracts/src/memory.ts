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
