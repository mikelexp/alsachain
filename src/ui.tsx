import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import { StatusMessage } from '@inkjs/ui';
import type { Device, PlaybackState } from './alsa.js';
import { hasChannelAdaptation } from './alsa.js';
import type { DependencyReport } from './deps.js';
import { EqualizerScreen } from './equalizer-ui.js';
import { equalizerBarRows, equalizerCutBarRows, type EqualizerBand } from './equalizer.js';
import {
  isBitperfect,
  stageLabel,
  type Crossfeed,
  type CrossfeedPreset,
  type DspStage,
  type Profile,
} from './model.js';
import type { ALSAChainService } from './service.js';

type Screen =
  | 'list'
  | 'detail'
  | 'equalizer'
  | 'crossfeed'
  | 'crossfeed-custom'
  | 'gain'
  | 'help'
  | 'diagnostics'
  | 'new'
  | 'edit'
  | 'delete'
  | 'stage-catalog'
  | 'stage-manager';
type Color =
  | 'green'
  | 'yellow'
  | 'red'
  | 'gray'
  | 'magenta'
  | 'white'
  | '#315BEF'
  | '#6f8fff'
  | '#171a21'
  | '#252a33'
  | '#2d3850'
  | '#203b2c'
  | '#d7dce5'
  | '#8f98a8';

const ACCENT: Color = '#315BEF';
const ACCENT_BRIGHT: Color = '#6f8fff';
const SURFACE: Color = '#252a33';
const SURFACE_DEEP: Color = '#171a21';
const TEXT: Color = '#d7dce5';
const MUTED: Color = '#8f98a8';

function useLastRawInput() {
  const { stdin } = useStdin();
  const lastInput = useRef('');

  useEffect(() => {
    const captureInput = (data: Buffer) => {
      lastInput.current = data.toString();
    };
    // Ink classifies DEL (the usual terminal Backspace sequence) as Delete.
    stdin.prependListener('data', captureInput);
    return () => {
      stdin.removeListener('data', captureInput);
    };
  }, [stdin]);

  return lastInput;
}

const statusColor = (state: PlaybackState['state'] | undefined, label?: string): Color =>
  label === 'Connected'
    ? 'green'
    : label === 'Not found' || state === 'Unavailable'
      ? 'red'
      : state === 'Playing'
        ? 'green'
        : state === 'XRUN'
          ? 'yellow'
          : 'gray';

const statusLabel = (state: PlaybackState | undefined, device?: Device) => {
  if (device && state?.state === 'Unavailable') return 'Connected';
  if (state?.state === 'Unknown' || (device && !state)) return undefined;
  return state?.state ?? 'Not found';
};

export function App({ service, report }: { service: ALSAChainService; report: DependencyReport }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState({
    width: stdout.columns ?? 80,
    height: stdout.rows ?? 24,
  });
  const [screen, setScreen] = useState<Screen>(
    report.dependencies
      .filter((dependency) => dependency.required !== false)
      .every((dependency) => dependency.ok)
      ? 'list'
      : 'diagnostics',
  );
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selection, setSelection] = useState(0);
  const [states, setStates] = useState<Record<string, PlaybackState>>({});
  const [equalizers, setEqualizers] = useState<Record<string, EqualizerBand[]>>({});
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [stageSelection, setStageSelection] = useState(0);

  const refreshEqualizers = async (sourceProfiles?: Profile[]) => {
    const candidates = sourceProfiles ?? (await service.list());
    const activeProfiles = candidates.filter(
      (candidate) => candidate.enabled && candidate.eqEnabled !== false && !isBitperfect(candidate),
    );
    const snapshots = await Promise.all(
      activeProfiles.map(async (candidate) => {
        try {
          return [candidate.id, await service.equalizerBands(candidate)] as const;
        } catch {
          return [candidate.id, null] as const;
        }
      }),
    );
    setEqualizers((current) =>
      Object.fromEntries(
        snapshots
          .map(([id, bands]) => [id, bands ?? current[id]] as const)
          .filter((entry): entry is readonly [string, EqualizerBand[]] => Boolean(entry[1])),
      ),
    );
  };

  const refresh = async (includeEqualizers = false) => {
    const [nextProfiles, nextDevices] = await Promise.all([service.list(), service.devices()]);
    setProfiles(nextProfiles);
    setDevices(nextDevices);
    const mapped = await Promise.all(
      nextProfiles.map(async (profile) => {
        return [profile.id, await service.playbackStatus(profile)] as const;
      }),
    );
    setStates(Object.fromEntries(mapped));
    if (includeEqualizers) await refreshEqualizers(nextProfiles);
  };

  useEffect(() => {
    void refresh(true);
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (screen !== 'list') return;
    const timer = setInterval(() => void refreshEqualizers(), 5000);
    return () => clearInterval(timer);
  }, [screen]);

  useEffect(() => {
    const updateTerminalSize = () =>
      setTerminalSize({ width: stdout.columns ?? 80, height: stdout.rows ?? 24 });
    stdout.on('resize', updateTerminalSize);
    return () => {
      stdout.off('resize', updateTerminalSize);
    };
  }, [stdout]);

  const toggleBitperfect = (profile: Profile) => {
    void service
      .setBitperfect(profile.id, !isBitperfect(profile))
      .then(() => refresh(true))
      .catch((error: Error) =>
        setFeedback({
          variant: 'error',
          title: 'PLAYBACK MODE CHANGE FAILED',
          message: error.message,
        }),
      );
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
    if (feedback) return;
    if (screen === 'list') {
      if (input === 'q') exit();
      if (key.downArrow)
        setSelection((value) => Math.min(value + 1, Math.max(0, profiles.length - 1)));
      if (key.upArrow) setSelection((value) => Math.max(0, value - 1));
      if (key.return && profiles[selection]) setScreen('detail');
      if (input === 'n') setScreen('new');
      if (input === 'e' && profiles[selection]) setScreen('edit');
      if (input === 'r') void refresh(true);
      if (input === '?') setScreen('help');
      if (input === 'd' && profiles[selection]) setScreen('delete');
      if (input === 'i') setScreen('diagnostics');
      if (input === 'b' && profiles[selection]) toggleBitperfect(profiles[selection]);
      if (input === 's' && profiles[selection]) setScreen('stage-manager');
    } else if (screen === 'detail') {
      if (key.escape) setScreen('list');
      if (input === 'e' && profile) setScreen('edit');
      if (input === 'b' && profile) toggleBitperfect(profile);
      if (input === 'd' && profile) setScreen('delete');
      if (input === 's' && profile) setScreen('stage-manager');
    } else if (
      !['equalizer', 'crossfeed', 'crossfeed-custom', 'gain'].includes(screen) &&
      key.escape
    )
      setScreen('list');
  });

  const profile = profiles[selection];
  return (
    <Box
      flexDirection="column"
      width={terminalSize.width}
      minHeight={terminalSize.height}
      position="relative"
      backgroundColor={SURFACE_DEEP}
      paddingX={1}
      paddingY={1}
    >
      <Header report={report} />
      {screen === 'list' && (
        <List
          profiles={profiles}
          selection={selection}
          states={states}
          devices={devices}
          equalizers={equalizers}
          width={terminalSize.width}
          height={terminalSize.height}
        />
      )}
      {screen === 'detail' && profile && <Details profile={profile} state={states[profile.id]} />}
      {screen === 'equalizer' && profile && (
        <EqualizerScreen
          service={service}
          profile={profile}
          width={terminalSize.width}
          height={terminalSize.height}
          active={!feedback}
          onBack={() => {
            setScreen('list');
            void refreshEqualizers(profiles);
          }}
          onRemove={() =>
            service.setEqEnabled(profile.id, false).then(() => {
              setScreen('list');
              return refresh(true);
            })
          }
          onError={(message) =>
            setFeedback({ variant: 'error', title: 'EQ UPDATE FAILED', message })
          }
          onBandsChange={(bands) =>
            setEqualizers((current) => ({ ...current, [profile.id]: bands }))
          }
        />
      )}
      {screen === 'crossfeed' && profile && (
        <CrossfeedScreen
          profile={profile}
          onSave={(preset) =>
            service
              .setCrossfeed(profile.id, preset)
              .then(() => {
                setScreen('list');
                void refresh(true);
              })
              .catch((error: Error) =>
                setFeedback({
                  variant: 'error',
                  title: 'CROSSFEED CHANGE FAILED',
                  message: error.message,
                }),
              )
          }
          onCustom={() => setScreen('crossfeed-custom')}
          onBack={() => setScreen('list')}
        />
      )}
      {screen === 'crossfeed-custom' && profile && (
        <CrossfeedCustomScreen
          profile={profile}
          onSave={(crossfeed) =>
            service
              .setCrossfeed(profile.id, crossfeed)
              .then(() => {
                setScreen('list');
                void refresh(true);
              })
              .catch((error: Error) =>
                setFeedback({
                  variant: 'error',
                  title: 'CROSSFEED CHANGE FAILED',
                  message: error.message,
                }),
              )
          }
          onBack={() => setScreen('crossfeed')}
        />
      )}
      {screen === 'gain' && profile && (
        <GainScreen
          profile={profile}
          onSave={(value) =>
            service
              .setGain(profile.id, value)
              .then(() => {
                setScreen('list');
                void refresh(true);
              })
              .catch((error: Error) =>
                setFeedback({
                  variant: 'error',
                  title: 'GAIN CHANGE FAILED',
                  message: error.message,
                }),
              )
          }
          onBack={() => setScreen('list')}
        />
      )}
      {screen === 'help' && <Help />}
      {screen === 'stage-catalog' && profile && (
        <StageCatalog
          profile={profile}
          report={report}
          onBack={() => setScreen('list')}
          onAdd={(type) =>
            service
              .addStage(profile.id, type)
              .then(async () => {
                await refresh(true);
                setStageSelection(profile.stages.length);
                setScreen(
                  type === 'equalizer' ? 'equalizer' : type === 'crossfeed' ? 'crossfeed' : 'gain',
                );
              })
              .catch((error: Error) =>
                setFeedback({
                  variant: 'error',
                  title: 'DSP STAGE FAILED',
                  message: error.message,
                }),
              )
          }
        />
      )}
      {screen === 'stage-manager' && profile && (
        <StageManager
          profile={profile}
          height={terminalSize.height}
          selection={stageSelection}
          onBack={() => setScreen('list')}
          onSelect={setStageSelection}
          onMove={(direction) => {
            const stage = profile.stages[stageSelection];
            const nextSelection = stageSelection + direction;
            if (!stage || nextSelection < 0 || nextSelection >= profile.stages.length) return;
            void service.moveStage(profile.id, stage.id, direction).then(async () => {
              setStageSelection(nextSelection);
              await refresh(true);
            });
          }}
          onConfigure={() => {
            const stage = profile.stages[stageSelection];
            if (stage)
              setScreen(
                stage.type === 'equalizer'
                  ? 'equalizer'
                  : stage.type === 'crossfeed'
                    ? 'crossfeed'
                    : 'gain',
              );
          }}
          onRemove={() => {
            const stage = profile.stages[stageSelection];
            if (!stage) return;
            void service.removeStage(profile.id, stage.id).then(() => {
              setStageSelection((value) => Math.max(0, value - 1));
              return refresh(true);
            });
          }}
          onAdd={() => setScreen('stage-catalog')}
        />
      )}
      {screen === 'diagnostics' && <Diagnostics report={report} />}
      {screen === 'new' && (
        <NewProfile
          service={service}
          devices={devices}
          onDone={() => {
            setScreen('list');
            void refresh(true);
          }}
        />
      )}
      {screen === 'edit' && profile && (
        <NewProfile
          service={service}
          devices={devices}
          existing={profile}
          onDone={() => {
            setScreen('list');
            void refresh(true);
          }}
        />
      )}
      {screen === 'delete' && profile && (
        <DeleteProfile
          service={service}
          profile={profile}
          width={Math.max(1, Math.min(72, terminalSize.width - 6))}
          onDone={() => {
            setScreen('list');
            void refresh(true);
          }}
        />
      )}
      <Box flexGrow={1} />
      {screen === 'list' ? (
        <Navigation />
      ) : screen === 'detail' ? (
        <DetailNavigation />
      ) : screen === 'equalizer' ? (
        <EqualizerNavigation />
      ) : screen === 'crossfeed' ? (
        <CrossfeedNavigation />
      ) : screen === 'crossfeed-custom' ? (
        <CrossfeedCustomNavigation />
      ) : screen === 'gain' ? (
        <GainNavigation />
      ) : screen === 'stage-manager' ? (
        <Box marginTop={1} gap={2} flexWrap="wrap">
          <KeyHint keyName="↑ / ↓" label="select stage" />
          <KeyHint keyName="shift + ↑ / ↓" label="move stage" />
          <KeyHint keyName="enter" label="configure" />
          <KeyHint keyName="d" label="remove" />
          <KeyHint keyName="a" label="add stage" />
          <KeyHint keyName="esc" label="back" />
        </Box>
      ) : (
        <Text color={MUTED}>esc back</Text>
      )}
      {feedback && (
        <FeedbackModal
          feedback={feedback}
          onClose={() => setFeedback(null)}
          width={Math.max(1, Math.min(58, terminalSize.width - 6))}
        />
      )}
    </Box>
  );
}

type FeedbackVariant = 'info' | 'success' | 'error' | 'warning';
type FeedbackState = { variant: FeedbackVariant; title: string; message: string };

function FeedbackModal({
  feedback,
  onClose,
  width,
}: {
  feedback: FeedbackState;
  onClose: () => void;
  width: number;
}) {
  useInput((input, key) => {
    if (key.return || key.escape) onClose();
  });

  return (
    <Box position="absolute" width="100%" height="100%" alignItems="center" justifyContent="center">
      <Box
        width={width}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        backgroundColor={SURFACE}
        borderStyle="bold"
        borderLeft
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={feedback.variant === 'error' ? 'red' : ACCENT}
      >
        <StatusMessage variant={feedback.variant}>{feedback.title}</StatusMessage>
        <Text color={TEXT}>{feedback.message}</Text>
        <Text color={MUTED}>enter to continue, esc to close</Text>
      </Box>
    </Box>
  );
}

function Header({ report }: { report: DependencyReport }) {
  const healthy = report.dependencies
    .filter((dependency) => dependency.required !== false)
    .every((dependency) => dependency.ok);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold color={ACCENT_BRIGHT}>
          ALSA <Text color="white">CHAIN</Text>
        </Text>
        <Text color={healthy ? 'green' : 'yellow'}>
          {healthy ? '[ SYSTEM READY ]' : '[ CHECK REQUIRED ]'}
        </Text>
      </Box>
      <Text color={MUTED}>safe alsaequal profile manager / live hardware monitor</Text>
    </Box>
  );
}

function Panel({
  title,
  children,
  color = ACCENT,
}: {
  title: string;
  children: React.ReactNode;
  color?: Color;
}) {
  return (
    <Box
      flexDirection="column"
      backgroundColor={SURFACE}
      borderStyle="bold"
      borderLeft
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={color}
      paddingX={2}
      paddingY={1}
    >
      <Text bold color={color}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

function Badge({ label, color }: { label: string; color: Color }) {
  return (
    <Text color={color} bold>
      [{label}]
    </Text>
  );
}

function KeyHint({ keyName, label }: { keyName: string; label: string }) {
  return (
    <Text>
      <Text color={ACCENT} bold>
        {keyName}
      </Text>
      <Text color={MUTED}> {label}</Text>
    </Text>
  );
}

function Navigation() {
  return (
    <>
      <Box marginTop={1} gap={2} flexWrap="wrap">
        <KeyHint keyName="enter" label="details" />
        <KeyHint keyName="n" label="new" />
        <KeyHint keyName="e" label="edit" />
        <KeyHint keyName="d" label="delete" />
        <KeyHint keyName="b" label="switch BITPERFECT / PROCESSED" />
        <KeyHint keyName="s" label="manage stages" />
      </Box>
      <Box gap={2} flexWrap="wrap">
        <KeyHint keyName="r" label="refresh" />
        <KeyHint keyName="i" label="diagnostics" />
        <KeyHint keyName="?" label="help" />
        <KeyHint keyName="q" label="exit" />
      </Box>
    </>
  );
}

function DetailNavigation() {
  return (
    <Box marginTop={1} gap={2} flexWrap="wrap">
      <KeyHint keyName="e" label="edit interface" />
      <KeyHint keyName="b" label="switch BITPERFECT / PROCESSED" />
      <KeyHint keyName="s" label="manage stages" />
      <KeyHint keyName="d" label="delete interface" />
      <KeyHint keyName="esc" label="back" />
    </Box>
  );
}

function EqualizerNavigation() {
  return (
    <Box marginTop={1} gap={2} flexWrap="wrap">
      <KeyHint keyName="← / →" label="select band" />
      <KeyHint keyName="↑ / ↓" label="adjust" />
      <KeyHint keyName="shift" label="step 5" />
      <KeyHint keyName="r" label="reload" />
      <KeyHint keyName="esc" label="back" />
    </Box>
  );
}

const crossfeedChoices: {
  value?: CrossfeedPreset;
  custom?: true;
  label: string;
  detail: string;
}[] = [
  { label: 'Remove crossfeed', detail: 'Remove this DSP stage from the profile.' },
  { value: 'gentle', label: 'Gentle', detail: '700 Hz / 4.5 dB · the bs2b default.' },
  { value: 'normal', label: 'Normal', detail: '700 Hz / 6 dB · Chu Moy-style crossfeed.' },
  { value: 'strong', label: 'Strong', detail: '650 Hz / 9.5 dB · Jan Meier-style crossfeed.' },
  { custom: true, label: 'Custom', detail: 'Choose the cutoff frequency and crossfeed level.' },
];

function CrossfeedScreen({
  profile,
  onSave,
  onCustom,
  onBack,
}: {
  profile: Profile;
  onSave: (preset?: Crossfeed) => void;
  onCustom: () => void;
  onBack: () => void;
}) {
  const initial = Math.max(
    0,
    crossfeedChoices.findIndex(
      (choice) =>
        choice.value === profile.crossfeed ||
        (choice.custom && typeof profile.crossfeed !== 'string'),
    ),
  );
  const [selection, setSelection] = useState(initial);
  const [busy, setBusy] = useState(false);
  useInput((input, key) => {
    if (busy) return;
    if (key.escape) onBack();
    if (key.upArrow) setSelection((current) => Math.max(0, current - 1));
    if (key.downArrow)
      setSelection((current) => Math.min(crossfeedChoices.length - 1, current + 1));
    if (key.return) {
      setBusy(true);
      if (crossfeedChoices[selection]?.custom) onCustom();
      else onSave(crossfeedChoices[selection]?.value);
    }
  });
  return (
    <Box flexDirection="column" gap={1}>
      <Panel title="HEADPHONE CROSSFEED" color={ACCENT}>
        <Box flexDirection="column" paddingY={1} gap={1}>
          <Text color={TEXT}>
            Mixes a small, delayed part of each channel into the other to make headphones feel less
            hard-panned. It is DSP and is never bit-perfect.
          </Text>
          <Text color={MUTED}>Choose the lowest strength that feels natural for this profile.</Text>
        </Box>
      </Panel>
      <Panel title={profile.displayName.toUpperCase()} color="magenta">
        <Box flexDirection="column" paddingY={1}>
          {crossfeedChoices.map((choice, index) => (
            <Box
              key={choice.label}
              flexDirection="column"
              marginBottom={index === selection ? 1 : 0}
            >
              <Text color={index === selection ? ACCENT_BRIGHT : TEXT} bold={index === selection}>
                {index === selection ? '> ' : '  '}
                {choice.label}
              </Text>
              {index === selection && <Text color={MUTED}> {choice.detail}</Text>}
            </Box>
          ))}
        </Box>
      </Panel>
      <Text color={MUTED}>
        Requires the optional bs2b LADSPA plugin when enabling crossfeed. The EQ stage is kept
        before crossfeed.
      </Text>
    </Box>
  );
}

function CrossfeedCustomScreen({
  profile,
  onSave,
  onBack,
}: {
  profile: Profile;
  onSave: (crossfeed: Crossfeed) => void;
  onBack: () => void;
}) {
  const existing = typeof profile.crossfeed === 'object' ? profile.crossfeed : undefined;
  const [cutoff, setCutoff] = useState(String(existing?.cutoff ?? 700));
  const [feed, setFeed] = useState(String(existing?.feed ?? 4.5));
  const [field, setField] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useInput((input, key) => {
    if (busy) return;
    const value = field === 0 ? cutoff : feed;
    const setValue = field === 0 ? setCutoff : setFeed;
    const editing = field < 2;
    const backspace = key.backspace || input === '\b' || input === '\x7f';
    if (key.escape) onBack();
    else if (key.tab) {
      const next = (field + (key.shift ? -1 : 1) + 3) % 3;
      setField(next);
      setCursor(next === 0 ? cutoff.length : next === 1 ? feed.length : 0);
    } else if (key.ctrl && input === 'a' && editing) setCursor(0);
    else if (key.ctrl && input === 'e' && editing) setCursor(value.length);
    else if (key.ctrl && input === 'u' && editing) {
      setValue('');
      setCursor(0);
    } else if (key.leftArrow && editing) setCursor((position) => Math.max(0, position - 1));
    else if (key.rightArrow && editing)
      setCursor((position) => Math.min(value.length, position + 1));
    else if (key.home && editing) setCursor(0);
    else if (key.end && editing) setCursor(value.length);
    else if (backspace && editing && cursor > 0) {
      const nextCursor = cursor - 1;
      setValue((current) => current.slice(0, nextCursor) + current.slice(cursor));
      setCursor(nextCursor);
    } else if (key.delete && editing) {
      setValue((current) => current.slice(0, cursor) + current.slice(cursor + 1));
    } else if (key.upArrow && editing) {
      const step = field === 0 ? 25 : 0.5;
      setValue(String(Number(value || 0) + step));
    } else if (key.downArrow && editing) {
      const step = field === 0 ? 25 : 0.5;
      setValue(String(Number(value || 0) - step));
    } else if (key.return && field < 2) {
      const next = field + 1;
      setField(next);
      setCursor(next === 1 ? feed.length : 0);
    } else if (key.return) {
      const settings = { cutoff: Number(cutoff), feed: Number(feed) };
      if (!Number.isInteger(settings.cutoff) || settings.cutoff < 300 || settings.cutoff > 2000)
        return setError('Cutoff must be a whole number from 300 to 2000 Hz');
      if (!Number.isFinite(settings.feed) || settings.feed < 1 || settings.feed > 15)
        return setError('Level must be from 1 to 15 dB');
      setBusy(true);
      onSave(settings);
    } else if (input && !key.ctrl && !key.meta && editing && /^[0-9.]$/.test(input)) {
      if (input !== '.' || !value.includes('.')) {
        setValue((current) => current.slice(0, cursor) + input + current.slice(cursor));
        setCursor((position) => position + 1);
      }
    }
  });
  const fieldRow = (label: string, value: string, index: number, suffix: string) => (
    <Box>
      <Text color={field === index ? ACCENT : 'gray'} bold>
        {field === index ? '> ' : '  '}
      </Text>
      <Text color={field === index ? 'white' : undefined}>{label.padEnd(12)}</Text>
      {field === index ? (
        <Text color="white">
          {value.slice(0, cursor)}
          <Text inverse color={ACCENT_BRIGHT}>
            {value[cursor] ?? ' '}
          </Text>
          {value.slice(cursor + 1)}
        </Text>
      ) : (
        <Text>{value}</Text>
      )}
      <Text color={MUTED}> {suffix}</Text>
    </Box>
  );
  return (
    <Box flexDirection="column" gap={1}>
      <Panel title="CUSTOM CROSSFEED" color={ACCENT}>
        <Box flexDirection="column" paddingY={1}>
          {fieldRow('Cutoff', cutoff, 0, 'Hz · 300–2000')}
          {fieldRow('Level', feed, 1, 'dB · 1–15')}
        </Box>
      </Panel>
      <Panel title="TUNING GUIDE" color="magenta">
        <Box flexDirection="column" paddingY={1}>
          <Text color={TEXT}>
            Start at 700 Hz and 4.5 dB. Increase level gradually; use the lowest natural setting.
          </Text>
          <Text color={MUTED}>
            Up/down adjust in 25 Hz or 0.5 dB steps. Values are validated before applying.
          </Text>
        </Box>
      </Panel>
      <Box backgroundColor={field === 2 ? '#203b2c' : SURFACE} paddingX={2} paddingY={1}>
        <Text color={field === 2 ? 'green' : 'gray'} bold>
          {field === 2 ? '> ' : '  '}
        </Text>
        <Text color={field === 2 ? 'green' : undefined}>[ Apply custom crossfeed ]</Text>
      </Box>
      {error && <Text color="red">! {error}</Text>}
    </Box>
  );
}

function CrossfeedNavigation() {
  return (
    <Box marginTop={1} gap={2} flexWrap="wrap">
      <KeyHint keyName="↑ / ↓" label="choose strength" />
      <KeyHint keyName="enter" label="apply" />
      <KeyHint keyName="esc" label="cancel" />
    </Box>
  );
}

function CrossfeedCustomNavigation() {
  return (
    <Box marginTop={1} gap={2} flexWrap="wrap">
      <KeyHint keyName="tab" label="next field" />
      <KeyHint keyName="↑ / ↓" label="adjust value" />
      <KeyHint keyName="enter" label="next / apply" />
      <KeyHint keyName="esc" label="back" />
    </Box>
  );
}

function GainScreen({
  profile,
  onSave,
  onBack,
}: {
  profile: Profile;
  onSave: (value: number) => void;
  onBack: () => void;
}) {
  const existing = profile.stages.find((stage) => stage.type === 'gain');
  const [value, setValue] = useState(String(existing?.type === 'gain' ? existing.gainDb : 0));
  const [field, setField] = useState(0);
  const [cursor, setCursor] = useState(value.length);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useInput((input, key) => {
    if (busy) return;
    const editing = field === 0;
    const backspace = key.backspace || input === '\b' || input === '\x7f';
    if (key.escape) onBack();
    else if (key.tab) {
      setField((current) => (current + (key.shift ? -1 : 1) + 2) % 2);
      setCursor(0);
    } else if (key.leftArrow && editing) setCursor((position) => Math.max(0, position - 1));
    else if (key.rightArrow && editing)
      setCursor((position) => Math.min(value.length, position + 1));
    else if (key.home && editing) setCursor(0);
    else if (key.end && editing) setCursor(value.length);
    else if (backspace && editing && cursor > 0) {
      const nextCursor = cursor - 1;
      setValue((current) => current.slice(0, nextCursor) + current.slice(cursor));
      setCursor(nextCursor);
    } else if (key.delete && editing) {
      setValue((current) => current.slice(0, cursor) + current.slice(cursor + 1));
    } else if (key.upArrow && editing) {
      setValue(String(Math.min(12, Number(value || 0) + 0.5)));
    } else if (key.downArrow && editing) {
      setValue(String(Math.max(-24, Number(value || 0) - 0.5)));
    } else if (key.return && field === 0) {
      setField(1);
      setCursor(0);
    } else if (key.return) {
      const gain = Number(value);
      if (!Number.isFinite(gain) || gain < -24 || gain > 12)
        return setError('Gain must be from -24 to +12 dB');
      setBusy(true);
      onSave(gain);
    } else if (input && !key.ctrl && !key.meta && editing && /^[0-9.+-]$/.test(input)) {
      if ((input !== '.' || !value.includes('.')) && (input !== '-' || cursor === 0)) {
        setValue((current) => current.slice(0, cursor) + input + current.slice(cursor));
        setCursor((position) => position + 1);
      }
    }
  });
  return (
    <Box flexDirection="column" gap={1}>
      <Panel title="GAIN" color={ACCENT}>
        <Box flexDirection="column" paddingY={1}>
          <Text color={TEXT}>
            Amplifies or attenuates the complete signal before the next DSP stage.
          </Text>
          <Text color={MUTED}>
            Positive values amplify. Use negative values to compensate for EQ boosts.
          </Text>
        </Box>
      </Panel>
      <Panel title={profile.displayName.toUpperCase()} color="magenta">
        <Box flexDirection="column" paddingY={1}>
          <Box>
            <Text color={field === 0 ? ACCENT : 'gray'} bold>
              {field === 0 ? '> ' : '  '}
            </Text>
            <Text color={field === 0 ? 'white' : undefined}>Gain </Text>
            {field === 0 ? (
              <Text color="white">
                {value.slice(0, cursor)}
                <Text inverse color={ACCENT_BRIGHT}>
                  {value[cursor] ?? ' '}
                </Text>
                {value.slice(cursor + 1)}
              </Text>
            ) : (
              <Text>{value}</Text>
            )}
            <Text color={MUTED}> dB · -24 to +12</Text>
          </Box>
          <Box
            marginTop={1}
            backgroundColor={field === 1 ? '#203b2c' : SURFACE}
            paddingX={2}
            paddingY={1}
          >
            <Text color={field === 1 ? 'green' : 'gray'} bold>
              {field === 1 ? '> ' : '  '}
            </Text>
            <Text color={field === 1 ? 'green' : undefined}>[ Apply gain ]</Text>
          </Box>
        </Box>
      </Panel>
      {error && <Text color="red">! {error}</Text>}
    </Box>
  );
}

function GainNavigation() {
  return (
    <Box marginTop={1} gap={2} flexWrap="wrap">
      <KeyHint keyName="↑ / ↓" label="adjust 0.5 dB" />
      <KeyHint keyName="tab" label="apply" />
      <KeyHint keyName="enter" label="next / apply" />
      <KeyHint keyName="esc" label="cancel" />
    </Box>
  );
}

function List({
  profiles,
  selection,
  states,
  devices,
  equalizers,
  width,
  height,
}: {
  profiles: Profile[];
  selection: number;
  states: Record<string, PlaybackState>;
  devices: Device[];
  equalizers: Record<string, EqualizerBand[]>;
  width: number;
  height: number;
}) {
  // Reserve the application chrome and navigation so every rendered row fits the viewport.
  const visibleCount = Math.max(1, Math.floor((height - 10) / 6));
  const start = Math.max(
    0,
    Math.min(selection - Math.floor(visibleCount / 2), Math.max(0, profiles.length - visibleCount)),
  );
  const visibleProfiles = profiles.slice(start, start + visibleCount);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="white">
          OUTPUT PROFILES
        </Text>
        <Text color={MUTED}>
          {' '}
          {profiles.length} managed interface{profiles.length === 1 ? '' : 's'}
          {visibleProfiles.length < profiles.length &&
            ` (${start + 1}-${start + visibleProfiles.length} shown)`}
        </Text>
      </Box>
      {profiles.length === 0 ? (
        <Panel title="NO PROFILES YET" color="magenta">
          <Box flexDirection="column" paddingY={1}>
            <Text color="white">Create a profile to expose an equalized ALSA output.</Text>
            <Text color={MUTED}>press n to select a physical playback device.</Text>
          </Box>
        </Panel>
      ) : (
        <Box flexDirection="column">
          {visibleProfiles.map((profile, index) => {
            const profileIndex = start + index;
            const device = devices.find((candidate) => candidate.target === profile.target);
            const state = states[profile.id];
            const status = statusLabel(state, device);
            return (
              <React.Fragment key={profile.id}>
                <ProfileRow
                  profile={profile}
                  state={state}
                  device={device}
                  status={status}
                  selected={profileIndex === selection}
                  equalizer={equalizers[profile.id]}
                  width={width}
                />
                {index < visibleProfiles.length - 1 && <Box height={1} />}
              </React.Fragment>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

function ProfileRow({
  profile,
  state,
  device,
  status,
  selected,
  equalizer,
  width,
}: {
  profile: Profile;
  state?: PlaybackState;
  device?: Device;
  status?: string;
  selected: boolean;
  equalizer?: EqualizerBand[];
  width: number;
}) {
  const audioDetails = state?.rate && state.format ? `${state.rate} ${state.format}` : 'idle';
  const equalizerWidth = Math.max(16, Math.min(42, Math.floor(width * 0.4)));
  const hasEqualizer = profile.stages.some((stage) => stage.type === 'equalizer');
  const stageChain = profile.stages.map(stageLabel).join(' → ');
  const channelAdapted = hasChannelAdaptation(profile.channels, state);
  return (
    <Box
      minHeight={5}
      backgroundColor={selected ? '#2d3850' : SURFACE}
      borderStyle="bold"
      borderLeft
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={selected ? ACCENT : 'gray'}
      paddingX={2}
    >
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        justifyContent="flex-start"
        paddingTop={1}
      >
        <Box>
          <Text bold color={selected ? 'white' : TEXT}>
            {profile.displayName}
          </Text>
          <Text color={MUTED}> {profile.pcmName}</Text>
        </Box>
        <Box>
          <Text color="magenta">audio</Text>
          <Text> {audioDetails}</Text>
          <Text color={MUTED}>
            {' '}
            {'->'} {device?.cardName ?? profile.target}
          </Text>
        </Box>
        <Box>
          <Text color={ACCENT}>stages</Text>
          <Text color={MUTED} wrap="truncate">
            {' '}
            {stageChain || 'none'}
            {isBitperfect(profile) && stageChain ? ' · inactive in BITPERFECT' : ''}
          </Text>
        </Box>
      </Box>
      {profile.enabled && hasEqualizer && !isBitperfect(profile) && (
        <ProfileEqualizer bands={equalizer} width={equalizerWidth} selected={selected} />
      )}
      <Box
        width={23}
        flexDirection="column"
        alignItems="flex-end"
        justifyContent="center"
        paddingLeft={1}
      >
        {!profile.enabled && <Badge label="OFF" color="gray" />}
        {profile.enabled && (
          <Badge
            label={
              isBitperfect(profile)
                ? channelAdapted
                  ? 'EFFECTIVE BITPERFECT'
                  : 'BITPERFECT'
                : 'PROCESSED'
            }
            color={isBitperfect(profile) ? 'green' : 'yellow'}
          />
        )}
        {status && <Badge label={status.toUpperCase()} color={statusColor(state?.state, status)} />}
      </Box>
    </Box>
  );
}

function ProfileEqualizer({
  bands,
  width,
  selected,
}: {
  bands?: EqualizerBand[];
  width: number;
  selected: boolean;
}) {
  const graphWidth = Math.max(1, width - 4);
  const boostRows = bands ? equalizerBarRows(bands, 2, graphWidth) : [];
  const cutRows = bands ? equalizerCutBarRows(bands, 1, graphWidth) : [];
  const zeroLine = '─'.repeat(graphWidth);
  return (
    <Box
      width={width}
      height="100%"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderColor={selected ? ACCENT : '#2d3850'}
      paddingX={1}
    >
      <Text bold color={selected ? ACCENT_BRIGHT : ACCENT}>
        EQ{bands ? ` · ${bands.length} bands` : ' · reading CTL'}
      </Text>
      {boostRows.map((row, index) => (
        <Text key={index} color={selected ? ACCENT_BRIGHT : TEXT} wrap="truncate">
          {row}
        </Text>
      ))}
      {bands && <Text color={selected ? ACCENT : MUTED}>{zeroLine}</Text>}
      {cutRows.map((row, index) => (
        <Text key={`cut-${index}`} color={selected ? ACCENT_BRIGHT : TEXT} wrap="truncate">
          {Array.from(row).map((cell, cellIndex) => {
            const partial = cell !== '·' && cell !== '█' && cell !== ' ';
            return (
              <Text
                key={cellIndex}
                color={partial ? SURFACE : undefined}
                backgroundColor={partial ? (selected ? ACCENT_BRIGHT : TEXT) : undefined}
              >
                {cell}
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}

function Details({ profile, state }: { profile: Profile; state?: PlaybackState }) {
  const color = statusColor(state?.state);
  const channelAdapted = hasChannelAdaptation(profile.channels, state);
  return (
    <Box flexDirection="column" gap={1}>
      <Panel title={profile.displayName} color={ACCENT}>
        <Box flexDirection="column" paddingY={1}>
          <InfoRow label="Status" value={state?.state ?? 'Unavailable'} valueColor={color} />
          <InfoRow label="Public PCM" value={profile.pcmName} />
          <InfoRow label="CTL" value={profile.ctlName ?? '-'} />
          <InfoRow label="Target" value={profile.target} />
        </Box>
      </Panel>
      <Panel title="PLAYBACK" color="magenta">
        <Box flexDirection="column" paddingY={1}>
          <InfoRow
            label="Physical"
            value={
              state?.rate && state.format ? `${state.rate} ${state.format}` : 'No active stream'
            }
          />
          <InfoRow
            label="Channels"
            value={
              state?.channels
                ? `${state.channels} channels`
                : state?.hardwareChannels
                  ? `${state.hardwareChannels} physical channels`
                  : 'Not available'
            }
          />
          <InfoRow
            label="Processing"
            value={
              isBitperfect(profile)
                ? channelAdapted
                  ? 'EFFECTIVE BITPERFECT - stereo preserved; ALSA pads physical channels'
                  : 'BITPERFECT - no DSP; format/rate adaptation is not observable here'
                : profile.eqEnabled === false
                  ? profile.crossfeed
                    ? `CROSSFEED - ${profile.crossfeed} / DSP active`
                    : 'PROCESSED - no DSP stage configured'
                  : profile.crossfeed
                    ? `EQ + CROSSFEED - ${profile.crossfeed} / DSP active`
                    : 'EQ - alsaequal active'
            }
            valueColor={isBitperfect(profile) && !channelAdapted ? 'green' : 'yellow'}
          />
        </Box>
      </Panel>
      <Panel title="PERSISTENCE" color="gray">
        <Box flexDirection="column" paddingY={1}>
          <InfoRow label="Controls" value={profile.controlsPath ?? '-'} />
          <Text color={MUTED}>Changes to a target affect new ALSA connections only.</Text>
          <Text color={MUTED}>
            b switches BITPERFECT / PROCESSED; s opens DSP stage management. Restart playback after
            changes.
          </Text>
        </Box>
      </Panel>
    </Box>
  );
}

function InfoRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: Color;
}) {
  return (
    <Box>
      <Text color={MUTED}>{label.padEnd(14)}</Text>
      <Text color={valueColor}>{value}</Text>
    </Box>
  );
}

function Help() {
  return (
    <Panel title="KEYBOARD" color={ACCENT}>
      <Box flexDirection="column" paddingY={1} gap={1}>
        <Text>
          <Text color={ACCENT} bold>
            up / down arrows
          </Text>{' '}
          select profiles
        </Text>
        <Text>
          <Text color={ACCENT} bold>
            enter
          </Text>{' '}
          open details{' '}
          <Text color={ACCENT} bold>
            n
          </Text>{' '}
          new{' '}
          <Text color={ACCENT} bold>
            e
          </Text>{' '}
          edit
        </Text>
        <Text>
          <Text color={ACCENT} bold>
            d
          </Text>{' '}
          delete{' '}
          <Text color={ACCENT} bold>
            b
          </Text>{' '}
          switch BITPERFECT / PROCESSED{' '}
          <Text color={ACCENT} bold>
            s
          </Text>{' '}
          manage DSP stages{' '}
          <Text color={ACCENT} bold>
            r
          </Text>{' '}
          refresh
        </Text>
        <Text>
          <Text color={ACCENT} bold>
            i
          </Text>{' '}
          diagnostics{' '}
          <Text color={ACCENT} bold>
            q
          </Text>{' '}
          exit
        </Text>
        <Text color={MUTED}>
          esc goes back or cancels. ctrl-c exits immediately. ALSA configuration is never written on
          startup.
        </Text>
      </Box>
    </Panel>
  );
}

function Diagnostics({ report }: { report: DependencyReport }) {
  const healthy = report.dependencies
    .filter((dependency) => dependency.required !== false)
    .every((dependency) => dependency.ok);
  return (
    <Box flexDirection="column" gap={1}>
      <Panel
        title={healthy ? 'SYSTEM DIAGNOSTICS' : 'ACTION REQUIRED'}
        color={healthy ? 'green' : 'yellow'}
      >
        <Box flexDirection="column" paddingY={1}>
          {report.dependencies.map((dependency) => (
            <Box key={dependency.name}>
              <Text
                color={dependency.ok ? 'green' : dependency.required === false ? 'gray' : 'red'}
                bold
              >
                {dependency.ok ? '[OK]  ' : dependency.required === false ? '[OPT] ' : '[FAIL]'}
              </Text>
              <Text bold>{dependency.name.padEnd(14)}</Text>
              <Text color={MUTED}> {dependency.detail || dependency.purpose}</Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text color="gray">LADSPA_PATH </Text>
            <Text>{report.ladspaPath}</Text>
          </Box>
        </Box>
      </Panel>
      {report.dependencies.some((dependency) => !dependency.ok) && (
        <Panel title="SUGGESTED INSTALLATION" color="yellow">
          <Box flexDirection="column" paddingY={1}>
            {report.installCommands.map((command) => (
              <Text key={command} color="yellow">
                $ {command}
              </Text>
            ))}
          </Box>
        </Panel>
      )}
    </Box>
  );
}

function StageCatalog({
  profile,
  report,
  onAdd,
  onBack,
}: {
  profile: Profile;
  report: DependencyReport;
  onAdd: (type: DspStage['type']) => void;
  onBack: () => void;
}) {
  const entries: { type: DspStage['type']; title: string; detail: string; unavailable?: string }[] =
    [
      {
        type: 'equalizer',
        title: 'Graphic equalizer',
        detail: 'CAPS Eq10 with ALSA-discovered controls.',
        unavailable: profile.stages.some((stage) => stage.type === 'equalizer')
          ? 'Already in this chain'
          : report.capsPath
            ? undefined
            : 'caps.so is unavailable',
      },
      {
        type: 'crossfeed',
        title: 'Headphone crossfeed',
        detail: 'bs2b stereo crossfeed.',
        unavailable: profile.stages.some((stage) => stage.type === 'crossfeed')
          ? 'Already in this chain'
          : profile.channels !== 2
            ? 'Requires stereo'
            : report.crossfeedPath
              ? undefined
              : 'Install ladspa-bs2b first',
      },
      {
        type: 'gain',
        title: 'Gain',
        detail: 'Amplify or attenuate the complete signal from -24 to +12 dB.',
        unavailable: profile.stages.some((stage) => stage.type === 'gain')
          ? 'Already in this chain'
          : undefined,
      },
    ];
  const [selection, setSelection] = useState(0);
  useInput((input, key) => {
    if (key.escape) onBack();
    if (key.upArrow) setSelection((value) => Math.max(0, value - 1));
    if (key.downArrow) setSelection((value) => Math.min(entries.length - 1, value + 1));
    if (key.return) {
      const entry = entries[selection];
      if (entry && !entry.unavailable) onAdd(entry.type);
    }
  });
  return (
    <Panel title="ADD DSP STAGE">
      <Box flexDirection="column" paddingY={1}>
        {entries.map((entry, index) => (
          <Box key={entry.type} flexDirection="column" marginBottom={1}>
            <Text
              bold
              color={index === selection ? ACCENT_BRIGHT : entry.unavailable ? 'gray' : TEXT}
            >
              {index === selection ? '> ' : '  '}
              {entry.title}
            </Text>
            <Text color={MUTED}> {entry.unavailable ?? entry.detail}</Text>
          </Box>
        ))}
      </Box>
      <Text color={MUTED}>↑/↓ select · enter add & configure · esc cancel</Text>
    </Panel>
  );
}

function StageManager({
  profile,
  height,
  selection,
  onBack,
  onSelect,
  onMove,
  onConfigure,
  onRemove,
  onAdd,
}: {
  profile: Profile;
  height: number;
  selection: number;
  onBack: () => void;
  onSelect: (value: number) => void;
  onMove: (direction: -1 | 1) => void;
  onConfigure: () => void;
  onRemove: () => void;
  onAdd: () => void;
}) {
  useInput((input, key) => {
    if (key.escape) onBack();
    if (key.shift && key.upArrow) onMove(-1);
    else if (key.shift && key.downArrow) onMove(1);
    else if (key.upArrow) onSelect(Math.max(0, selection - 1));
    else if (key.downArrow) onSelect(Math.min(profile.stages.length - 1, selection + 1));
    if (input === '[') onMove(-1);
    if (input === ']') onMove(1);
    if (key.return) onConfigure();
    if (input === 'd') onRemove();
    if (input === 'a') onAdd();
  });
  const visible = Math.max(3, height - 13);
  const start = Math.max(
    0,
    Math.min(Math.max(0, profile.stages.length - visible), selection - Math.floor(visible / 2)),
  );
  return (
    <Box flexDirection="column" gap={1}>
      <Panel title="MANAGE DSP STAGES">
        <Text color={MUTED}>
          Hardware → {profile.stages.map(stageLabel).join(' → ') || 'no DSP stages'} → Public PCM
        </Text>
      </Panel>
      <Panel title={`${profile.stages.length} STAGES`} color="magenta">
        <Box flexDirection="column" paddingY={1}>
          {profile.stages.length === 0 ? (
            <Text color={MUTED}>No DSP stages yet. Press a to add one.</Text>
          ) : (
            profile.stages.slice(start, start + visible).map((stage, index) => {
              const absolute = start + index;
              return (
                <Text
                  key={stage.id}
                  bold={absolute === selection}
                  color={absolute === selection ? ACCENT_BRIGHT : TEXT}
                >
                  {absolute === selection ? '> ' : '  '}
                  {String(absolute + 1).padStart(2, '0')} · {stageLabel(stage)}
                  <Text color={MUTED}>
                    {stage.type === 'crossfeed'
                      ? ` · ${typeof stage.settings === 'string' ? stage.settings : 'custom'}`
                      : stage.type === 'gain'
                        ? ` · ${stage.gainDb >= 0 ? '+' : ''}${stage.gainDb} dB`
                        : ' · CAPS Eq10'}
                  </Text>
                </Text>
              );
            })
          )}
        </Box>
      </Panel>
      <Text color={MUTED}>
        ↑/↓ select · shift+↑/↓ move stage · enter configure · d remove · a add · esc back
      </Text>
    </Box>
  );
}

function NewProfile({
  service,
  devices,
  existing,
  onDone,
}: {
  service: ALSAChainService;
  devices: Device[];
  existing?: Profile;
  onDone: () => void;
}) {
  const [id, setId] = useState(existing?.id ?? '');
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [device, setDevice] = useState(() =>
    Math.max(
      0,
      devices.findIndex((candidate) => candidate.target === existing?.target),
    ),
  );
  const [field, setField] = useState(0);
  const [cursor, setCursor] = useState(existing?.id.length ?? 0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const rawInput = useLastRawInput();

  useInput((input, key) => {
    const value = field === 0 ? id : displayName;
    const setValue = field === 0 ? setId : setDisplayName;
    const isTextField = field < 2;
    const isBackspace =
      key.backspace ||
      rawInput.current === '\x7f' ||
      input === '\b' ||
      input === '\x7f' ||
      input === '\x1b[8~' ||
      input === '\x1b[127~';
    const isDelete = (key.delete && !isBackspace) || input === '\x1b[3~';

    if (key.tab) {
      const nextField = (field + (key.shift ? -1 : 1) + 4) % 4;
      setField(nextField);
      setCursor(nextField === 0 ? id.length : nextField === 1 ? displayName.length : 0);
    } else if (key.ctrl && input === 'a' && isTextField) {
      setCursor(0);
    } else if (key.ctrl && input === 'e' && isTextField) {
      setCursor(value.length);
    } else if (key.ctrl && input === 'u' && isTextField) {
      setValue('');
      setCursor(0);
    } else if (key.leftArrow && isTextField) {
      setCursor((position) => Math.max(0, position - 1));
    } else if (key.rightArrow && isTextField) {
      setCursor((position) => Math.min(value.length, position + 1));
    } else if (key.home && isTextField) {
      setCursor(0);
    } else if (key.end && isTextField) {
      setCursor(value.length);
    } else if (isBackspace && isTextField) {
      if (cursor > 0) {
        const nextCursor = cursor - 1;
        setValue((current) => current.slice(0, nextCursor) + current.slice(cursor));
        setCursor(nextCursor);
      }
    } else if (isDelete && isTextField) {
      setValue((current) => current.slice(0, cursor) + current.slice(cursor + 1));
    } else if (key.upArrow && field === 2) {
      setDevice((current) => Math.max(0, current - 1));
    } else if (key.downArrow && field === 2) {
      setDevice((current) => Math.min(devices.length - 1, current + 1));
    } else if (key.return && field < 3) {
      const nextField = field + 1;
      setField(nextField);
      setCursor(nextField === 1 ? displayName.length : 0);
    } else if (key.return) {
      const selected = devices[device];
      if (!selected) return setError('Select a playback device');
      if (!id) return setError('Identifier is required');
      if (busy) return;
      setBusy(true);
      void (async () => {
        try {
          const config = await service.store.load();
          const generatedProfile = service.createProfile({
            id,
            displayName: displayName || id,
            target: selected.target,
            channels: 2,
          });
          const profile = existing
            ? {
                ...generatedProfile,
                createdAt: existing.createdAt,
                eqEnabled: existing.eqEnabled,
                bitperfect: existing.bitperfect,
                crossfeed: existing.crossfeed,
              }
            : generatedProfile;
          const existingIndex = existing
            ? config.profiles.findIndex((candidate) => candidate.id === existing.id)
            : -1;
          if (
            config.profiles.some(
              (candidate) => candidate.id !== existing?.id && candidate.id === profile.id,
            )
          ) {
            setError(`Identifier ${profile.id} already exists`);
            return;
          }
          if (existingIndex >= 0) config.profiles[existingIndex] = profile;
          else config.profiles.push(profile);
          await service.applyConfig(config);
          await service.store.save(config);
          onDone();
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      })();
    } else if (input && !key.ctrl && !key.meta && isTextField) {
      const valid = field === 0 ? /^[A-Za-z0-9_-]+$/.test(input) : !/[\r\n]/.test(input);
      if (valid) {
        setValue((current) => current.slice(0, cursor) + input + current.slice(cursor));
        setCursor((position) => position + input.length);
      }
    }
  });

  const renderInput = (label: string, value: string, active: boolean) => (
    <Box>
      <Text color={active ? ACCENT : 'gray'} bold>
        {active ? '> ' : '  '}
      </Text>
      <Text color={active ? 'white' : undefined}>{label.padEnd(15)}</Text>
      {active ? (
        <Text color="white">
          {value.slice(0, cursor)}
          <Text inverse color={ACCENT_BRIGHT}>
            {value[cursor] ?? ' '}
          </Text>
          {value.slice(cursor + 1)}
        </Text>
      ) : (
        <Text>{value}</Text>
      )}
    </Box>
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Panel title={existing ? `EDIT ${existing.displayName.toUpperCase()}` : 'NEW OUTPUT PROFILE'}>
        <Box flexDirection="column" paddingY={1}>
          {renderInput('Identifier', id, field === 0)}
          {renderInput('Visible name', displayName, field === 1)}
          <Box>
            <Text color={field === 2 ? ACCENT : 'gray'} bold>
              {field === 2 ? '> ' : '  '}
            </Text>
            <Text color={field === 2 ? 'white' : undefined}>{'Target'.padEnd(15)}</Text>
            <Text>{devices[device]?.target ?? 'No playback hardware'}</Text>
          </Box>
        </Box>
      </Panel>
      <Panel title="PLAYBACK DEVICES" color="magenta">
        <Box flexDirection="column" paddingY={1}>
          {devices.length === 0 ? (
            <Text color="yellow">No playback hardware detected.</Text>
          ) : (
            devices.map((candidate, index) => (
              <Text key={candidate.target}>
                <Text color={index === device ? 'magenta' : 'gray'} bold>
                  {index === device ? '> ' : '  '}
                </Text>
                <Text color={index === device ? 'white' : undefined}>
                  {candidate.cardName} <Text color={MUTED}>{candidate.description}</Text>
                </Text>
              </Text>
            ))
          )}
        </Box>
      </Panel>
      <Box
        backgroundColor={field === 3 ? '#203b2c' : SURFACE}
        borderStyle="bold"
        borderLeft
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={field === 3 ? 'green' : 'gray'}
        paddingX={2}
        paddingY={1}
      >
        <Text color={field === 3 ? 'green' : 'gray'} bold>
          {field === 3 ? '> ' : '  '}
        </Text>
        <Text color={field === 3 ? 'green' : undefined}>[ Save profile ]</Text>
      </Box>
      <Text color={MUTED}>
        tab/enter advances, shift-tab goes back, arrows choose target, esc cancels
      </Text>
      {error && <Text color="red">! {error}</Text>}
    </Box>
  );
}

function DeleteProfile({
  service,
  profile,
  width,
  onDone,
}: {
  service: ALSAChainService;
  profile: Profile;
  width: number;
  onDone: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const remove = (deleteControls: boolean) => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        const config = await service.store.load();
        const next = {
          ...config,
          profiles: config.profiles.filter((candidate) => candidate.id !== profile.id),
        };
        await service.applyConfig(next);
        await service.store.save(next);
        if (deleteControls && profile.controlsPath)
          await service.store.deleteControlsFile(profile.controlsPath);
        onDone();
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  useInput((input) => {
    if (input === 'k') remove(false);
    if (input === 'd') remove(true);
  });

  return (
    <Box position="absolute" width="100%" height="100%" alignItems="center" justifyContent="center">
      <Box width={width}>
        <Panel title={`REMOVE ${profile.displayName.toUpperCase()}?`} color="red">
          <Box flexDirection="column" paddingY={1} gap={1}>
            <Text>This removes only the managed definition for {profile.pcmName}.</Text>
            <Text>
              <Text color="yellow" bold>
                k
              </Text>{' '}
              remove interface, keep controls
            </Text>
            <Text>
              <Text color="red" bold>
                d
              </Text>{' '}
              remove interface and delete controls file
            </Text>
            <Text color={MUTED}>esc cancel</Text>
            {error && <Text color="red">! {error}</Text>}
          </Box>
        </Panel>
      </Box>
    </Box>
  );
}
