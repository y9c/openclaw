import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyExtensionHostTtsToPayload,
  buildExtensionHostTtsSystemPromptHint,
  runExtensionHostTextToSpeech,
} from "./tts-api.js";

vi.mock("./tts-config.js", () => ({
  normalizeExtensionHostTtsConfigAutoMode: vi.fn(),
  resolveExtensionHostTtsConfig: vi.fn(),
  resolveExtensionHostTtsModelOverridePolicy: vi.fn(),
}));

vi.mock("./tts-preferences.js", () => ({
  getExtensionHostTtsMaxLength: vi.fn(),
  isExtensionHostTtsSummarizationEnabled: vi.fn(),
  resolveExtensionHostTtsAutoMode: vi.fn(),
  resolveExtensionHostTtsPrefsPath: vi.fn(),
}));

vi.mock("./tts-payload.js", () => ({
  resolveExtensionHostTtsPayloadPlan: vi.fn(),
}));

vi.mock("./tts-runtime-setup.js", () => ({
  resolveExtensionHostTtsRequestSetup: vi.fn(),
}));

vi.mock("./tts-runtime-execution.js", () => ({
  executeExtensionHostTextToSpeech: vi.fn(),
  executeExtensionHostTextToSpeechTelephony: vi.fn(),
  isExtensionHostTtsVoiceBubbleChannel: vi.fn(() => false),
  resolveExtensionHostEdgeOutputFormat: vi.fn(() => "audio-24khz-48kbitrate-mono-mp3"),
  resolveExtensionHostTtsOutputFormat: vi.fn(() => ({
    openai: "mp3",
    elevenlabs: "mp3_44100_128",
    extension: ".mp3",
    voiceCompatible: false,
  })),
}));

vi.mock("./tts-status.js", () => ({
  getExtensionHostLastTtsAttempt: vi.fn(),
  setExtensionHostLastTtsAttempt: vi.fn(),
}));

describe("tts-api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the remaining system prompt hint through host-owned preferences", async () => {
    const configModule = await import("./tts-config.js");
    const prefsModule = await import("./tts-preferences.js");

    vi.mocked(configModule.resolveExtensionHostTtsConfig).mockReturnValue({} as never);
    vi.mocked(prefsModule.resolveExtensionHostTtsPrefsPath).mockReturnValue("/tmp/tts.json");
    vi.mocked(prefsModule.resolveExtensionHostTtsAutoMode).mockReturnValue("inbound");
    vi.mocked(prefsModule.getExtensionHostTtsMaxLength).mockReturnValue(900);
    vi.mocked(prefsModule.isExtensionHostTtsSummarizationEnabled).mockReturnValue(false);

    const hint = buildExtensionHostTtsSystemPromptHint({} as never);

    expect(hint).toContain("Voice (TTS) is enabled.");
    expect(hint).toContain("Only use TTS when the user's last message includes audio/voice.");
    expect(hint).toContain("Keep spoken text ≤900 chars");
    expect(hint).toContain("summary off");
  });

  it("returns setup validation errors through the host-owned TTS API", async () => {
    const configModule = await import("./tts-config.js");
    const prefsModule = await import("./tts-preferences.js");
    const setupModule = await import("./tts-runtime-setup.js");

    vi.mocked(configModule.resolveExtensionHostTtsConfig).mockReturnValue({} as never);
    vi.mocked(prefsModule.resolveExtensionHostTtsPrefsPath).mockReturnValue("/tmp/tts.json");
    vi.mocked(setupModule.resolveExtensionHostTtsRequestSetup).mockReturnValue({
      error: "Text too long (5000 chars, max 4096)",
    });

    await expect(
      runExtensionHostTextToSpeech({
        text: "x".repeat(5000),
        cfg: {} as never,
      }),
    ).resolves.toEqual({
      success: false,
      error: "Text too long (5000 chars, max 4096)",
    });
  });

  it("returns the planned payload when TTS conversion fails", async () => {
    const configModule = await import("./tts-config.js");
    const prefsModule = await import("./tts-preferences.js");
    const payloadModule = await import("./tts-payload.js");
    const setupModule = await import("./tts-runtime-setup.js");
    const executionModule = await import("./tts-runtime-execution.js");
    const statusModule = await import("./tts-status.js");

    vi.mocked(configModule.resolveExtensionHostTtsConfig).mockReturnValue({} as never);
    vi.mocked(prefsModule.resolveExtensionHostTtsPrefsPath).mockReturnValue("/tmp/tts.json");
    vi.mocked(payloadModule.resolveExtensionHostTtsPayloadPlan).mockResolvedValue({
      kind: "ready",
      nextPayload: { text: "cleaned" },
      textForAudio: "speak this",
      wasSummarized: true,
      overrides: {},
    });
    vi.mocked(setupModule.resolveExtensionHostTtsRequestSetup).mockReturnValue({
      config: {} as never,
      providers: ["openai"],
    });
    vi.mocked(executionModule.executeExtensionHostTextToSpeech).mockResolvedValue({
      success: false,
      error: "provider failed",
    });

    const result = await applyExtensionHostTtsToPayload({
      payload: { text: "original" },
      cfg: {} as never,
      channel: "telegram",
      kind: "final",
    });

    expect(result).toEqual({ text: "cleaned" });
    expect(statusModule.setExtensionHostLastTtsAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        textLength: "original".length,
        summarized: true,
        error: "provider failed",
      }),
    );
  });
});
