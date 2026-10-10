/** Tolerate fractional pixels, but keep the jump button until the reader is at the bottom. */
export function isAtBottom(view: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
    return view.scrollHeight - view.scrollTop - view.clientHeight <= 4;
}
export function shouldPauseFollowing(top: number, previousTop: number, userIntent: boolean, layoutChanged = false): boolean {
    return userIntent || (!layoutChanged && top < previousTop - 1);
}
