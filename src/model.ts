import path from 'node:path';
import { z } from 'zod';

export const alsaName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'Use a safe ALSA name');
export const crossfeedPreset = z.enum(['gentle', 'normal', 'strong']);
export type CrossfeedPreset = z.infer<typeof crossfeedPreset>;
export const crossfeedCustom = z
  .object({
    cutoff: z.number().int().min(300).max(2000),
    feed: z.number().min(1).max(15),
  })
  .strict();
export const crossfeedSchema = z.union([crossfeedPreset, crossfeedCustom]);
export type Crossfeed = z.infer<typeof crossfeedSchema>;
export const gainDb = z.number().min(-24).max(12);

const equalizerStageSchema = z
  .object({
    id: alsaName,
    type: z.literal('equalizer'),
    ctlName: alsaName,
    controlsPath: z.string().min(1),
  })
  .strict();
const crossfeedStageSchema = z
  .object({
    id: alsaName,
    type: z.literal('crossfeed'),
    settings: crossfeedSchema,
  })
  .strict();
const gainStageSchema = z
  .object({
    id: alsaName,
    type: z.literal('gain'),
    gainDb,
  })
  .strict();
export const dspStageSchema = z.discriminatedUnion('type', [
  equalizerStageSchema,
  crossfeedStageSchema,
  gainStageSchema,
]);
export type DspStage = z.infer<typeof dspStageSchema>;
export type EqualizerStage = z.infer<typeof equalizerStageSchema>;
export type CrossfeedStage = z.infer<typeof crossfeedStageSchema>;
export type GainStage = z.infer<typeof gainStageSchema>;

export const profileSchema = z
  .object({
    id: alsaName,
    displayName: z.string().trim().min(1).max(100),
    pcmName: alsaName,
    target: z.string().regex(/^plughw:CARD=[A-Za-z0-9_-]+,DEV=\d+$/),
    channels: z.number().int().min(1).max(32),
    enabled: z.boolean(),
    bitperfect: z.boolean(),
    stages: z.array(dspStageSchema),
    // Transitional UI projections; DSP stages remain authoritative.
    eqEnabled: z.boolean().optional(),
    // Older releases serialized an absent crossfeed setting as null.
    crossfeed: z.preprocess((value) => value ?? undefined, crossfeedSchema.optional()),
    ctlName: alsaName.optional(),
    controlsPath: z.string().min(1).optional(),
    internalPcmName: alsaName.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((profile, context) => {
    const ids = profile.stages.map((stage) => stage.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        message: 'DSP stage identifiers collide',
        path: ['stages'],
      });
    const types = profile.stages.map((stage) => stage.type);
    if (new Set(types).size !== types.length)
      context.addIssue({
        code: 'custom',
        message: 'A profile may contain one instance of each DSP stage type',
        path: ['stages'],
      });
    if (profile.stages.some((stage) => stage.type === 'crossfeed') && profile.channels !== 2)
      context.addIssue({
        code: 'custom',
        message: 'Crossfeed is available only for stereo profiles',
        path: ['stages'],
      });
  });
export type Profile = z.infer<typeof profileSchema>;
export const configSchema = z.object({ version: z.literal(1), profiles: z.array(profileSchema) });
export type Config = z.infer<typeof configSchema>;
export const emptyConfig = (): Config => ({ version: 1, profiles: [] });

export const isBitperfect = (profile: Profile): boolean => profile.bitperfect;
export const equalizerStage = (profile: Profile): EqualizerStage | undefined =>
  profile.stages.find((stage): stage is EqualizerStage => stage.type === 'equalizer');
export const stageLabel = (stage: DspStage): string =>
  stage.type === 'equalizer' ? 'EQ' : stage.type === 'crossfeed' ? 'Crossfeed' : 'Gain';

export function assertUniqueProfiles(profiles: Profile[]): void {
  const pcmNames = profiles.map((profile) => profile.pcmName);
  const ctlNames = profiles.flatMap((profile) =>
    profile.stages
      .filter((stage): stage is EqualizerStage => stage.type === 'equalizer')
      .map((stage) => stage.ctlName),
  );
  const ids = profiles.map((profile) => profile.id);
  if (
    new Set(pcmNames).size !== pcmNames.length ||
    new Set(ctlNames).size !== ctlNames.length ||
    new Set(ids).size !== ids.length
  )
    throw new Error('Profile ALSA names collide');
  const controls = profiles.flatMap((profile) =>
    profile.stages.filter((stage): stage is EqualizerStage => stage.type === 'equalizer'),
  );
  const controlsPaths = controls.map((stage) => path.resolve(stage.controlsPath));
  if (new Set(controlsPaths).size !== controlsPaths.length)
    throw new Error('Profiles must use separate controls files');
}
