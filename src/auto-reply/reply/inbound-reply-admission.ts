import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionSendPolicyDecision } from "../../sessions/send-policy.js";
import type { MsgContext } from "../templating.js";
import { isSilentUnauthorizedWholeMessageControlCommand } from "./unauthorized-control-command.js";

export type InboundReplySilentReason =
  | "send_policy_deny"
  | "unauthorized_command"
  | "echo_filtered";

export type InboundReplyAdmission = {
  sendPolicy: SessionSendPolicyDecision;
  shouldStartEarlyTyping: boolean;
  silentReason?: InboundReplySilentReason;
};

export function resolveInboundReplyAdmission(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  sendPolicy: SessionSendPolicyDecision;
  allowTextCommands: boolean;
  commandAuthorized: boolean;
  agentId?: string;
  commandBodyNormalized?: string;
  echoDetected?: boolean;
  includeDisabledCommands?: boolean;
  isAuthorizedSender?: boolean;
}): InboundReplyAdmission {
  if (params.echoDetected) {
    return {
      sendPolicy: params.sendPolicy,
      shouldStartEarlyTyping: false,
      silentReason: "echo_filtered",
    };
  }

  if (params.sendPolicy === "deny") {
    return {
      sendPolicy: params.sendPolicy,
      shouldStartEarlyTyping: false,
      silentReason: "send_policy_deny",
    };
  }

  if (
    isSilentUnauthorizedWholeMessageControlCommand({
      ctx: params.ctx,
      cfg: params.cfg,
      allowTextCommands: params.allowTextCommands,
      commandAuthorized: params.commandAuthorized,
      agentId: params.agentId,
      commandBodyNormalized: params.commandBodyNormalized,
      includeDisabledCommands: params.includeDisabledCommands,
      isAuthorizedSender: params.isAuthorizedSender,
    })
  ) {
    return {
      sendPolicy: params.sendPolicy,
      shouldStartEarlyTyping: false,
      silentReason: "unauthorized_command",
    };
  }

  return {
    sendPolicy: params.sendPolicy,
    shouldStartEarlyTyping: true,
  };
}
