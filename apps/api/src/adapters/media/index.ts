import { getEnv } from '../../config/env.ts';
import type { VideoProvider, VoiceProvider } from './media.provider.ts';
import { MockVideoProvider, MockVoiceProvider } from './mock-media.provider.ts';
import { WherebyVideoProvider } from './whereby-media.provider.ts';

/**
 * Media provider selection (spec §91, decision D18).
 *
 * Business logic asks for a provider and never learns which it got.
 *
 * Video is served by Whereby (decision D18). Twilio remains selectable and
 * remains unimplemented: it is kept in the enum so that choosing it fails
 * loudly rather than being silently unknown, which is the same reasoning as
 * the throw below.
 *
 * **Voice has no implementation at all.** Whereby is browser-to-browser and
 * publishes no PSTN capability, so it cannot serve Call Me — which dials both
 * parties and bridges them so neither learns the other's number (spec §33).
 * That mode still needs a telephony provider.
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
      case 'twilio':
        // Failing loudly beats silently falling back to a mock, which would
        // report a consultation as connected when nothing was (spec §93).
        throw new Error(
          'VIDEO_PROVIDER=twilio is selected but the Twilio adapter is not implemented, ' +
            'and is not planned: video is served by Whereby (D18). Use VIDEO_PROVIDER=whereby.',
        );
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
      case 'twilio':
        throw new Error(
          'VOICE_PROVIDER=twilio is selected but the Twilio Voice adapter is not implemented. ' +
            'Call Me needs a telephony provider that can dial two legs and bridge them; ' +
            'Whereby cannot, so moving video to Whereby did not solve this (spec §33).',
        );
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
