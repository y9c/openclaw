import { isWhatsAppGroupJid } from "./normalize.js";

const WHATSAPP_ACCOUNT_SCOPE_THREAD_MARKER = ":thread:whatsapp-account-";

export function resolveWhatsAppSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}) {
  if (params.kind !== "group") {
    return null;
  }

  const rawId = params.rawId.trim();
  if (!rawId) {
    return null;
  }

  const markerIndex = rawId.lastIndexOf(WHATSAPP_ACCOUNT_SCOPE_THREAD_MARKER);
  if (markerIndex <= 0) {
    return null;
  }

  const groupId = rawId.slice(0, markerIndex).trim();
  const accountScopeId = rawId
    .slice(markerIndex + WHATSAPP_ACCOUNT_SCOPE_THREAD_MARKER.length)
    .trim();
  if (!groupId || !accountScopeId || !isWhatsAppGroupJid(groupId)) {
    return null;
  }

  return {
    id: groupId,
    baseConversationId: groupId,
    parentConversationCandidates: [groupId],
  };
}
