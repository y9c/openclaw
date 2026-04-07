import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { slugifyWikiSegment } from "./markdown.js";

type ChatGptMessage = {
  role: string;
  text: string;
  sortTime: number;
};

export type ChatGptExportConversation = {
  conversationId: string;
  title: string;
  relativePath: string;
  transcriptBody: string;
  messageCount: number;
  participantRoles: string[];
  conversationCreatedAt?: string;
  conversationUpdatedAt?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeTimestamp(value: unknown): { iso?: string; sortTime: number } {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime())
      ? { sortTime: 0 }
      : { iso: date.toISOString(), sortTime: ms };
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? { sortTime: 0 }
      : { iso: date.toISOString(), sortTime: date.getTime() };
  }
  return { sortTime: 0 };
}

function normalizeRole(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim().toLowerCase();
  }
  return "unknown";
}

function formatRoleHeading(role: string): string {
  return role
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractMessageText(contentValue: unknown): string {
  const content = asRecord(contentValue);
  if (!content) {
    return "";
  }
  if (Array.isArray(content.parts)) {
    return content.parts
      .flatMap((part) => (typeof part === "string" && part.trim() ? [part.trim()] : []))
      .join("\n\n");
  }
  if (typeof content.text === "string" && content.text.trim()) {
    return content.text.trim();
  }
  if (Array.isArray(content.text)) {
    return content.text
      .flatMap((part) => (typeof part === "string" && part.trim() ? [part.trim()] : []))
      .join("\n\n");
  }
  return "";
}

function extractConversationMessages(mappingValue: unknown): ChatGptMessage[] {
  const mapping = asRecord(mappingValue);
  if (!mapping) {
    return [];
  }
  return Object.values(mapping)
    .flatMap((entry) => {
      const node = asRecord(entry);
      const message = asRecord(node?.message);
      if (!message) {
        return [];
      }
      const text = extractMessageText(message.content);
      if (!text) {
        return [];
      }
      const author = asRecord(message.author);
      const { sortTime } = normalizeTimestamp(message.create_time ?? node?.create_time);
      return [
        {
          role: normalizeRole(author?.role ?? author?.name),
          text,
          sortTime,
        },
      ];
    })
    .toSorted(
      (left, right) => left.sortTime - right.sortTime || left.role.localeCompare(right.role),
    );
}

function renderTranscriptBody(messages: ChatGptMessage[]): string {
  if (messages.length === 0) {
    return "_No readable ChatGPT transcript messages were found in this export conversation._";
  }
  return messages
    .flatMap((message) => [`### ${formatRoleHeading(message.role)}`, "", message.text, ""])
    .join("\n")
    .trim();
}

function resolveConversationRecords(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) => {
      const record = asRecord(entry);
      return record ? [record] : [];
    });
  }
  const envelope = asRecord(parsed);
  if (Array.isArray(envelope?.conversations)) {
    return envelope.conversations.flatMap((entry) => {
      const record = asRecord(entry);
      return record ? [record] : [];
    });
  }
  return [];
}

function resolveConversationId(record: Record<string, unknown>, index: number): string {
  for (const key of ["id", "conversation_id", "conversationId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return `conversation-${index + 1}`;
}

export async function parseChatGptExportFile(
  inputPath: string,
): Promise<ChatGptExportConversation[]> {
  const raw = await fs.readFile(inputPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const records = resolveConversationRecords(parsed);
  if (records.length === 0) {
    throw new Error(`No ChatGPT conversations found in export: ${inputPath}`);
  }

  return records.map((record, index) => {
    const conversationId = resolveConversationId(record, index);
    const title =
      (typeof record.title === "string" && record.title.trim()) || `Conversation ${index + 1}`;
    const created = normalizeTimestamp(record.create_time);
    const updated = normalizeTimestamp(record.update_time);
    const messages = extractConversationMessages(record.mapping);
    const participantRoles = [...new Set(messages.map((message) => message.role))].toSorted();
    const relativeSlug = slugifyWikiSegment(title);
    const idHash = createHash("sha1").update(conversationId).digest("hex").slice(0, 8);
    return {
      conversationId,
      title,
      relativePath: `${relativeSlug}-${idHash}.md`,
      transcriptBody: renderTranscriptBody(messages),
      messageCount: messages.length,
      participantRoles,
      ...(created.iso ? { conversationCreatedAt: created.iso } : {}),
      ...(updated.iso ? { conversationUpdatedAt: updated.iso } : {}),
    };
  });
}
