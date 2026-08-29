import { getEnv } from '../../config/env.ts';
import type { VideoProvider, VoiceProvider } from './media.provider.ts';
import { MockVideoProvider, MockVoiceProvider } from './mock-media.provider.ts';

/**
 * Media provider selection (spec §91, decision D18).
 *
 * Business logic asks for a provider and never learns which it got. When
 * Twilio Programmable Video is confirmed available, adding its adapter here is
 * the whole change — see docs/phase-0-findings.md C9 for why it is not built
 * against yet.
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
      case 'twilio':
        // Failing loudly beats silently falling back to a mock, which would
        // report a consultation as connected when nothing was (spec §93).
        throw new Error(
          'VIDEO_PROVIDER=twilio is selected but the Twilio adapter is not implemented. ' +
            'Confirm Programmable Video is available before enabling it (finding C9).',
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
          'VOICE_PROVIDER=twilio is selected but the Twilio Voice adapter is not implemented (Phase 5 follow-up).',
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
