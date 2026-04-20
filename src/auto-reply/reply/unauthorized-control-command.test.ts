import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildTestCtx } from "./test-ctx.js";
import { isSilentUnauthorizedWholeMessageControlCommand } from "./unauthorized-control-command.js";

describe("isSilentUnauthorizedWholeMessageControlCommand", () => {
  it("keeps disabled privileged commands config-aware by default", () => {
    const ctx = buildTestCtx({
      CommandBody: "/config show",
      RawBody: "/config show",
      Body: "/config show",
      CommandSource: "native",
      Provider: "telegram",
      Surface: "telegram",
    });

    expect(
      isSilentUnauthorizedWholeMessageControlCommand({
        ctx,
        cfg: {
          commands: {
            config: false,
            text: true,
          },
        } as OpenClawConfig,
        allowTextCommands: true,
        commandAuthorized: false,
      }),
    ).toBe(false);
  });

  it("can opt into disabled privileged commands for eager typing suppression", () => {
    const ctx = buildTestCtx({
      CommandBody: "/config show",
      RawBody: "/config show",
      Body: "/config show",
      Provider: "whatsapp",
      Surface: "whatsapp",
    });

    expect(
      isSilentUnauthorizedWholeMessageControlCommand({
        ctx,
        cfg: {
          commands: {
            config: false,
            text: true,
          },
        } as OpenClawConfig,
        allowTextCommands: true,
        commandAuthorized: false,
        includeDisabledCommands: true,
      }),
    ).toBe(true);
  });
});
