export interface BusinessDefinitionContent {
    type: 'metric' | 'term' | 'relationship';
    name: string;
    description: string;
    aliases?: string[];
    relatedFields?: string[];
    metric?: Partial<Record<'numerator' | 'denominator' | 'entityGrain' | 'timeWindow' | 'timezone' | 'unit' | 'conditions', string>>;
    relationship?: { leftField: string; rightField: string; cardinality: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'; explanation: string };
}
export interface BusinessDefinition extends BusinessDefinitionContent {
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
    needsReview: boolean;
}
export interface BusinessDefinitionCandidate {
    id: string;
    datasourceId: number;
    version: number;
    content: BusinessDefinitionContent;
    definitionId: string | null;
    expectedVersion: number | null;
    sourceMessageId: string;
    generationId: string;
    status: 'pending' | 'accepted' | 'rejected';
}
