import { getEnv } from '../../config/env.ts';
import type { VideoProvider, VoiceProvider } from './media.provider.ts';
import { MockVideoProvider, MockVoiceProvider } from './mock-media.provider.ts';
import { WherebyVideoProvider } from './whereby-media.provider.ts';

/**
 * Media provider selection (spec §91, decision D18).
 *
 * Business logic asks for a provider and never learns which it got.
 *
 * Video is served by Whereby (decisions D18, D35).
 *
 * **Voice has no implementation at all.** Whereby is browser-to-browser and
 * publishes no PSTN capability, so it cannot serve Call Me — which dials both
 * parties and bridges them so neither learns the other's number (spec §33).
 * Twilio was removed entirely in D36, so `mock` is the only value the enum
 * offers: a provider name that throws at boot is worse than no name at all,
 * because it reads as a capability that merely needs configuring.
 */
let video: VideoProvider | undefined;
let voice: VoiceProvider | undefined;

export function getVideoProvider(): VideoProvider {
  if (!video) {
    const env = getEnv();

    switch (env.VIDEO_PROVIDER) {
      case 'mock':
        video = new MockVideoProvider();
        break;
      case 'whereby':
        video = new WherebyVideoProvider();
        break;
      default:
        throw new Error(`Unknown VIDEO_PROVIDER: ${env.VIDEO_PROVIDER}`);
    }
  }
  return video;
}

export function getVoiceProvider(): VoiceProvider {
  if (!voice) {
    const env = getEnv();

    switch (env.VOICE_PROVIDER) {
      case 'mock':
        voice = new MockVoiceProvider();
        break;
      default:
        throw new Error(`Unknown VOICE_PROVIDER: ${env.VOICE_PROVIDER}`);
    }
  }
  return voice;
}

export function setMediaProvidersForTesting(
  next: { video?: VideoProvider; voice?: VoiceProvider } = {},
): void {
  video = next.video;
  voice = next.voice;
}

export * from './media.provider.ts';
export { MockVideoProvider, MockVoiceProvider } from './mock-media.provider.ts';
export { WherebyVideoProvider } from './whereby-media.provider.ts';
