import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import { hasControlCommand } from "../command-detection.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import type { MsgContext } from "../templating.js";
import { stripMentions } from "./mentions.js";

export function isSilentUnauthorizedWholeMessageControlCommand(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  allowTextCommands: boolean;
  commandAuthorized: boolean;
  agentId?: string;
  commandBodyNormalized?: string;
  isAuthorizedSender?: boolean;
  includeDisabledCommands?: boolean;
}): boolean {
  if (!params.allowTextCommands) {
    return false;
  }

  const rawBodyTrimmed = (
    params.ctx.CommandBody ??
    params.ctx.RawBody ??
    params.ctx.Body ??
    ""
  ).trim();
  if (rawBodyTrimmed.length === 0) {
    return false;
  }

  const normalizedCommandBody =
    params.commandBodyNormalized?.trim() ??
    normalizeCommandBody(
      params.ctx.ChatType === "group"
        ? stripMentions(rawBodyTrimmed, params.ctx, params.cfg, params.agentId)
        : rawBodyTrimmed,
      { botUsername: params.ctx.BotUsername },
    ).trim();
  const isAuthorizedSender =
    params.isAuthorizedSender ??
    resolveCommandAuthorization({
      ctx: params.ctx,
      cfg: params.cfg,
      commandAuthorized: params.commandAuthorized,
    }).isAuthorizedSender;
  const isWholeMessageCommand =
    normalizedCommandBody === rawBodyTrimmed ||
    normalizedCommandBody === rawBodyTrimmed.toLowerCase();
  const isResetOrNewCommand = /^\/(new|reset)(?:\s|$)/.test(normalizedCommandBody);
  const isRecognizedControlCommand = params.includeDisabledCommands
    ? hasControlCommand(rawBodyTrimmed)
    : hasControlCommand(rawBodyTrimmed, params.cfg);

  return (
    (!params.commandAuthorized || !isAuthorizedSender) &&
    isWholeMessageCommand &&
    (isRecognizedControlCommand || isResetOrNewCommand)
  );
}
