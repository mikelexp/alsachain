import { describe, expect, it } from 'vitest';
import { profileSchema } from '../src/model.js';
const base = {
  id: 'usb',
  displayName: 'USB',
  pcmName: 'usb',
  target: 'plughw:CARD=TEST,DEV=0',
  channels: 2,
  enabled: true,
  bitperfect: false,
  stages: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
describe('DSP stage model', () => {
  it('accepts an ordered stage chain', () =>
    expect(
      profileSchema.safeParse({
        ...base,
        stages: [
          { id: 'eq', type: 'equalizer', ctlName: 'usb', controlsPath: '/tmp/usb.bin' },
          { id: 'crossfeed', type: 'crossfeed', settings: 'normal' },
          { id: 'gain', type: 'gain', gainDb: 6 },
        ],
      }).success,
    ).toBe(true));
  it('rejects duplicate stage types and crossfeed on non-stereo outputs', () => {
    expect(
      profileSchema.safeParse({
        ...base,
        stages: [
          { id: 'a', type: 'crossfeed', settings: 'normal' },
          { id: 'b', type: 'crossfeed', settings: 'gentle' },
        ],
      }).success,
    ).toBe(false);
    expect(
      profileSchema.safeParse({
        ...base,
        channels: 1,
        stages: [{ id: 'crossfeed', type: 'crossfeed', settings: 'normal' }],
      }).success,
    ).toBe(false);
  });
  it('limits gain to the supported amplification and attenuation range', () => {
    expect(
      profileSchema.safeParse({
        ...base,
        stages: [{ id: 'gain', type: 'gain', gainDb: 12.5 }],
      }).success,
    ).toBe(false);
    expect(
      profileSchema.safeParse({
        ...base,
        stages: [{ id: 'gain', type: 'gain', gainDb: -24 }],
      }).success,
    ).toBe(true);
  });
  it('treats a legacy null crossfeed projection as absent', () => {
    const profile = profileSchema.parse({ ...base, crossfeed: null });
    expect(profile.crossfeed).toBeUndefined();
  });
});
