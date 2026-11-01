import { format } from 'sql-formatter';

/** Presentation only: never replace the SQL sent to the database. */
export function formatSql(content?: string): string {
    if (!content?.trim()) return '';
    try {
        return format(content, {
            language: 'postgresql',
            tabWidth: 2,
            keywordCase: 'upper',
            expressionWidth: 60,
        });
    } catch {
        // Unsupported or incomplete syntax must remain inspectable.
        return content;
    }
}
