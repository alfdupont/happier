import { getOrCreateWebAudioContext } from '@/voice/output/webAudioContext';

const CHIME_TONES_HZ = [660, 880] as const;
const TONE_SECONDS = 0.14;
const PEAK_GAIN = 0.15;

/**
 * Plays a short two-tone chime through Web Audio. Browser notifications are shown silent and the
 * app owns the sound instead, because OS notification sounds for browsers are inconsistent
 * (most Linux notification daemons play none).
 */
export async function playWebNotificationChime(): Promise<void> {
    const ctx = getOrCreateWebAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
        await ctx.resume();
    }

    const startAt = ctx.currentTime;
    CHIME_TONES_HZ.forEach((frequencyHz, index) => {
        const toneStart = startAt + index * TONE_SECONDS;
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequencyHz, toneStart);
        gain.gain.setValueAtTime(0.0001, toneStart);
        gain.gain.linearRampToValueAtTime(PEAK_GAIN, toneStart + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + TONE_SECONDS);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(toneStart);
        oscillator.stop(toneStart + TONE_SECONDS);
    });
}
