import type { InjectionKey } from 'vue';

/** All Markdown renderers within one message, including nested reports. */
export const textPlaybackKey: InjectionKey<{ setPlaying(token: symbol, playing: boolean): void }> = Symbol('message-text-playback');
