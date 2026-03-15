import type { TtsProvider } from "../config/types.tts.js";
import {
  applyExtensionHostTtsToPayload,
  buildExtensionHostTtsSystemPromptHint,
  resolveExtensionHostEdgeOutputFormat,
  resolveExtensionHostTtsModelOverridePolicy,
  resolveExtensionHostTtsOutputFormat,
  runExtensionHostTextToSpeech,
  runExtensionHostTextToSpeechTelephony,
  type ExtensionHostTtsStatusEntry,
} from "../extension-host/tts-api.js";
import {
  normalizeExtensionHostTtsConfigAutoMode,
  resolveExtensionHostTtsConfig,
  type ResolvedTtsConfig,
} from "../extension-host/tts-config.js";
import {
  getExtensionHostTtsMaxLength,
  isExtensionHostTtsEnabled,
  isExtensionHostTtsSummarizationEnabled,
  resolveExtensionHostTtsPrefsPath,
  setExtensionHostTtsAutoMode,
  setExtensionHostTtsEnabled,
  setExtensionHostTtsMaxLength,
  setExtensionHostTtsProvider,
  setExtensionHostTtsSummarizationEnabled,
} from "../extension-host/tts-preferences.js";
import {
  EXTENSION_HOST_TTS_PROVIDER_IDS,
  isExtensionHostTtsProviderConfigured,
  resolveExtensionHostTtsApiKey,
  resolveExtensionHostTtsProviderOrder,
} from "../extension-host/tts-runtime-registry.js";
import { resolveExtensionHostTtsProvider } from "../extension-host/tts-runtime-setup.js";
import {
  getExtensionHostLastTtsAttempt,
  setExtensionHostLastTtsAttempt,
} from "../extension-host/tts-status.js";
import {
  isValidOpenAIModel,
  isValidOpenAIVoice,
  isValidVoiceId,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  parseTtsDirectives,
  resolveOpenAITtsInstructions,
  summarizeText,
} from "./tts-core.js";
export { OPENAI_TTS_MODELS, OPENAI_TTS_VOICES } from "./tts-core.js";

export type TtsDirectiveOverrides = {
  ttsText?: string;
  provider?: TtsProvider;
  openai?: {
    voice?: string;
    model?: string;
  };
  elevenlabs?: {
    voiceId?: string;
    modelId?: string;
    seed?: number;
    applyTextNormalization?: "auto" | "on" | "off";
    languageCode?: string;
    voiceSettings?: Partial<ResolvedTtsConfig["elevenlabs"]["voiceSettings"]>;
  };
};

export type TtsDirectiveParseResult = {
  cleanedText: string;
  ttsText?: string;
  hasDirective: boolean;
  overrides: TtsDirectiveOverrides;
  warnings: string[];
};

export type TtsResult = {
  success: boolean;
  audioPath?: string;
  error?: string;
  latencyMs?: number;
  provider?: string;
  outputFormat?: string;
  voiceCompatible?: boolean;
};

export type TtsTelephonyResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  outputFormat?: string;
  sampleRate?: number;
};

type TtsStatusEntry = ExtensionHostTtsStatusEntry;

export const normalizeTtsAutoMode = normalizeExtensionHostTtsConfigAutoMode;

export const resolveTtsConfig = resolveExtensionHostTtsConfig;

export const resolveTtsPrefsPath = resolveExtensionHostTtsPrefsPath;

export const buildTtsSystemPromptHint = buildExtensionHostTtsSystemPromptHint;

export const isTtsEnabled = isExtensionHostTtsEnabled;

export const setTtsAutoMode = setExtensionHostTtsAutoMode;

export const setTtsEnabled = setExtensionHostTtsEnabled;

export const getTtsProvider = resolveExtensionHostTtsProvider;

export const setTtsProvider = setExtensionHostTtsProvider;

export const getTtsMaxLength = getExtensionHostTtsMaxLength;

export const setTtsMaxLength = setExtensionHostTtsMaxLength;

export const isSummarizationEnabled = isExtensionHostTtsSummarizationEnabled;

export const setSummarizationEnabled = setExtensionHostTtsSummarizationEnabled;

export function getLastTtsAttempt(): TtsStatusEntry | undefined {
  return getExtensionHostLastTtsAttempt();
}

export function setLastTtsAttempt(entry: TtsStatusEntry | undefined): void {
  setExtensionHostLastTtsAttempt(entry);
}

export const TTS_PROVIDERS = EXTENSION_HOST_TTS_PROVIDER_IDS;

export const resolveTtsApiKey = resolveExtensionHostTtsApiKey;

export const resolveTtsProviderOrder = resolveExtensionHostTtsProviderOrder;

export const isTtsProviderConfigured = isExtensionHostTtsProviderConfigured;

export const textToSpeech = runExtensionHostTextToSpeech;

export const textToSpeechTelephony = runExtensionHostTextToSpeechTelephony;

export const maybeApplyTtsToPayload = applyExtensionHostTtsToPayload;

export const _test = {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  resolveOpenAITtsInstructions,
  parseTtsDirectives,
  resolveModelOverridePolicy: resolveExtensionHostTtsModelOverridePolicy,
  summarizeText,
  resolveOutputFormat: resolveExtensionHostTtsOutputFormat,
  resolveEdgeOutputFormat: resolveExtensionHostEdgeOutputFormat,
};
