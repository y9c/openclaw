import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import type { TtsDirectiveOverrides, TtsResult, TtsTelephonyResult } from "../tts/tts.js";
import {
  resolveExtensionHostTtsConfig,
  resolveExtensionHostTtsModelOverridePolicy,
} from "./tts-config.js";
import { resolveExtensionHostTtsPayloadPlan } from "./tts-payload.js";
import {
  getExtensionHostTtsMaxLength,
  isExtensionHostTtsSummarizationEnabled,
  resolveExtensionHostTtsAutoMode,
  resolveExtensionHostTtsPrefsPath,
} from "./tts-preferences.js";
import {
  executeExtensionHostTextToSpeech,
  executeExtensionHostTextToSpeechTelephony,
  isExtensionHostTtsVoiceBubbleChannel,
  resolveExtensionHostEdgeOutputFormat,
  resolveExtensionHostTtsOutputFormat,
} from "./tts-runtime-execution.js";
import { resolveExtensionHostTtsRequestSetup } from "./tts-runtime-setup.js";
import { setExtensionHostLastTtsAttempt, type ExtensionHostTtsStatusEntry } from "./tts-status.js";

export type { ExtensionHostTtsStatusEntry };

export { resolveExtensionHostTtsModelOverridePolicy };
export { resolveExtensionHostTtsOutputFormat, resolveExtensionHostEdgeOutputFormat };

export function buildExtensionHostTtsSystemPromptHint(cfg: OpenClawConfig): string | undefined {
  const config = resolveExtensionHostTtsConfig(cfg);
  const prefsPath = resolveExtensionHostTtsPrefsPath(config);
  const autoMode = resolveExtensionHostTtsAutoMode({ config, prefsPath });
  if (autoMode === "off") {
    return undefined;
  }
  const maxLength = getExtensionHostTtsMaxLength(prefsPath);
  const summarize = isExtensionHostTtsSummarizationEnabled(prefsPath) ? "on" : "off";
  const autoHint =
    autoMode === "inbound"
      ? "Only use TTS when the user's last message includes audio/voice."
      : autoMode === "tagged"
        ? "Only use TTS when you include [[tts]] or [[tts:text]] tags."
        : undefined;
  return [
    "Voice (TTS) is enabled.",
    autoHint,
    `Keep spoken text ≤${maxLength} chars to avoid auto-summary (summary ${summarize}).`,
    "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runExtensionHostTextToSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
}): Promise<TtsResult> {
  const config = resolveExtensionHostTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveExtensionHostTtsPrefsPath(config);
  const setup = resolveExtensionHostTtsRequestSetup({
    text: params.text,
    config,
    prefsPath,
    providerOverride: params.overrides?.provider,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  return executeExtensionHostTextToSpeech({
    text: params.text,
    config: setup.config,
    providers: setup.providers,
    channel: params.channel,
    overrides: params.overrides,
  });
}

export async function runExtensionHostTextToSpeechTelephony(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
}): Promise<TtsTelephonyResult> {
  const config = resolveExtensionHostTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveExtensionHostTtsPrefsPath(config);
  const setup = resolveExtensionHostTtsRequestSetup({
    text: params.text,
    config,
    prefsPath,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  return executeExtensionHostTextToSpeechTelephony({
    text: params.text,
    config: setup.config,
    providers: setup.providers,
  });
}

export async function applyExtensionHostTtsToPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
}): Promise<ReplyPayload> {
  const config = resolveExtensionHostTtsConfig(params.cfg);
  const prefsPath = resolveExtensionHostTtsPrefsPath(config);
  const plan = await resolveExtensionHostTtsPayloadPlan({
    payload: params.payload,
    cfg: params.cfg,
    config,
    prefsPath,
    kind: params.kind,
    inboundAudio: params.inboundAudio,
    ttsAuto: params.ttsAuto,
  });
  if (plan.kind === "skip") {
    return plan.payload;
  }

  const ttsStart = Date.now();
  const result = await runExtensionHostTextToSpeech({
    text: plan.textForAudio,
    cfg: params.cfg,
    prefsPath,
    channel: params.channel,
    overrides: plan.overrides,
  });

  if (result.success && result.audioPath) {
    setExtensionHostLastTtsAttempt({
      timestamp: Date.now(),
      success: true,
      textLength: (params.payload.text ?? "").length,
      summarized: plan.wasSummarized,
      provider: result.provider,
      latencyMs: result.latencyMs,
    });

    const shouldVoice =
      isExtensionHostTtsVoiceBubbleChannel(params.channel) && result.voiceCompatible === true;
    return {
      ...plan.nextPayload,
      mediaUrl: result.audioPath,
      audioAsVoice: shouldVoice || params.payload.audioAsVoice,
    };
  }

  setExtensionHostLastTtsAttempt({
    timestamp: Date.now(),
    success: false,
    textLength: (params.payload.text ?? "").length,
    summarized: plan.wasSummarized,
    error: result.error,
  });

  const latency = Date.now() - ttsStart;
  logVerbose(`TTS: conversion failed after ${latency}ms (${result.error ?? "unknown"}).`);
  return plan.nextPayload;
}
