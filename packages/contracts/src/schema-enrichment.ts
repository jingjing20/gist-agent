export interface SchemaColumnComment {
    name: string;
    type: string;
    comment: string;
}
export interface SchemaCommentSuggestion {
    column: string;
    suggestedComment: string;
    basis: 'original_metadata' | 'sample_observation';
    needsVerification: string[];
}
export interface SchemaCommentChange {
    column: string;
    originalComment: string;
    comment: string;
}
export interface SchemaEnrichmentResult {
    columns: SchemaColumnComment[];
    suggestions: SchemaCommentSuggestion[];
    prompt: { version: string; hash: string };
}
