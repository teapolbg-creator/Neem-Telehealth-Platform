import { getEnv } from '../../config/env.ts';
import { errors } from '../../lib/errors.ts';
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

/**
 * The voice provider, or null when "Call Me" is switched off (D38).
 *
 * Null rather than a throw, because "off" is an ordinary state that several
 * callers need to ask about — the patient's mode list, the doctor's call
 * button, the route guard — and none of them should be reading an environment
 * variable of their own. This is the one place that decides.
 *
 * Note it consults the injected provider first. A test that injects a voice
 * provider is exercising Call Me deliberately, and gets it whatever the
 * environment says; that is why the integration tests still cover the mode
 * while it is off everywhere else.
 */
export function getVoiceProviderOrNull(): VoiceProvider | null {
  if (!voice) {
    const env = getEnv();

    switch (env.VOICE_PROVIDER) {
      case 'none':
        return null;
      case 'mock':
        voice = new MockVoiceProvider();
        break;
      default:
        throw new Error(`Unknown VOICE_PROVIDER: ${env.VOICE_PROVIDER}`);
    }
  }
  return voice;
}

/**
 * Whether a patient may choose "Call Me" at all.
 *
 * Read by the patient's mode list so a button is never offered that the server
 * would refuse, and by the routes so the refusal is real rather than a matter
 * of the UI being polite.
 */
export function isCallMeEnabled(): boolean {
  return getVoiceProviderOrNull() !== null;
}

export function getVoiceProvider(): VoiceProvider {
  const provider = getVoiceProviderOrNull();

  if (!provider) {
    throw errors.businessRule('Call Me is not available. Choose audio or video instead.');
  }

  return provider;
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
