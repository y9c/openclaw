import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveInboundReplyAdmission } from "./inbound-reply-admission.js";

describe("resolveInboundReplyAdmission", () => {
  const cfg = {} as OpenClawConfig;
  const baseCtx = {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    ChatType: "direct",
    From: "+15550001111",
    To: "+15550002222",
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: "+15550001111",
  };

  it("allows early typing for accepted turns", () => {
    expect(
      resolveInboundReplyAdmission({
        ctx: baseCtx as never,
        cfg,
        sendPolicy: "allow",
        allowTextCommands: true,
        commandAuthorized: true,
      }),
    ).toEqual({
      sendPolicy: "allow",
      shouldStartEarlyTyping: true,
    });
  });

  it("suppresses early typing when send policy denies delivery", () => {
    expect(
      resolveInboundReplyAdmission({
        ctx: baseCtx as never,
        cfg,
        sendPolicy: "deny",
        allowTextCommands: true,
        commandAuthorized: true,
      }),
    ).toEqual({
      sendPolicy: "deny",
      shouldStartEarlyTyping: false,
      silentReason: "send_policy_deny",
    });
  });

  it("suppresses early typing for silent unauthorized commands", () => {
    expect(
      resolveInboundReplyAdmission({
        ctx: {
          ...baseCtx,
          Body: "/reset",
          RawBody: "/reset",
          CommandBody: "/reset",
        } as never,
        cfg,
        sendPolicy: "allow",
        allowTextCommands: true,
        commandAuthorized: false,
      }),
    ).toEqual({
      sendPolicy: "allow",
      shouldStartEarlyTyping: false,
      silentReason: "unauthorized_command",
    });
  });

  it("suppresses early typing for echo-filtered turns", () => {
    expect(
      resolveInboundReplyAdmission({
        ctx: baseCtx as never,
        cfg,
        sendPolicy: "allow",
        allowTextCommands: true,
        commandAuthorized: true,
        echoDetected: true,
      }),
    ).toEqual({
      sendPolicy: "allow",
      shouldStartEarlyTyping: false,
      silentReason: "echo_filtered",
    });
  });
});
