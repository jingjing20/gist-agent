function prose(content: string): string {
    return content.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g, '');
}

export function predominantlyEnglish(content: string): boolean {
    const text = prose(content);
    const words = text.match(/\b[a-zA-Z]{2,}\b/g) ?? [];
    const chinese = text.match(/[\u4e00-\u9fff]/g) ?? [];
    return words.length >= 6 && words.join('').length > chinese.length * 3;
}

/** Hold only an undecided opening, never an entire accepted Chinese response. */
export class ResponseTextStream {
    private pending = '';
    private mode: 'pending' | 'streaming' | 'withheld';
    published = false;

    constructor(chinese: boolean) {
        this.mode = chinese ? 'pending' : 'streaming';
    }

    push(fragment: string): string {
        if (!fragment || this.mode === 'withheld') return '';
        if (this.mode === 'streaming') {
            this.published = true;
            return fragment;
        }
        this.pending += fragment;
        if (predominantlyEnglish(this.pending)) {
            this.mode = 'withheld';
            this.pending = '';
            return '';
        }
        if (/[\u4e00-\u9fff]/.test(prose(this.pending))) {
            this.mode = 'streaming';
            const text = this.pending;
            this.pending = '';
            this.published = true;
            return text;
        }
        return '';
    }

    finish(content: string): string {
        if (this.published) return '';
        this.pending = '';
        this.published = !!content;
        return content;
    }
}
