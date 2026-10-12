import type { InjectionKey, ComputedRef } from 'vue';

/** All Markdown renderers within one message, including nested reports. */
export const textPlaybackKey: InjectionKey<{ isPlaying?: ComputedRef<boolean>; setPlaying(token: symbol, playing: boolean): void }> = Symbol('message-text-playback');
