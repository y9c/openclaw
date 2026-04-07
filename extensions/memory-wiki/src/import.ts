import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  completePluginTaskRun,
  createPluginTaskRun,
  failPluginTaskRun,
  recordPluginTaskProgress,
} from "openclaw/plugin-sdk/core";
import { normalizeSingleOrTrimmedStringList } from "openclaw/plugin-sdk/text-runtime";
import { compileMemoryWikiVault, type CompileMemoryWikiResult } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { parseChatGptExportFile, type ChatGptExportConversation } from "./import-chatgpt.js";
import { detectChatGptExportFile } from "./import-profile-detect.js";
import { buildImportReviewBody, type ImportReviewEntry } from "./import-review.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  extractWikiLinks,
  extractTitleFromMarkdown,
  parseWikiMarkdown,
  renderMarkdownFence,
  renderWikiMarkdown,
  slugifyWikiSegment,
} from "./markdown.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { pathExists, resolveArtifactKey } from "./source-path-shared.js";
import {
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";
import { initializeMemoryWikiVault } from "./vault.js";

const DIRECTORY_TEXT_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".md",
  ".markdown",
  ".txt",
  ".yaml",
  ".yml",
]);
const MARKDOWN_VAULT_EXTENSIONS = new Set([".md", ".markdown"]);
const MARKDOWN_VAULT_MARKERS = [".obsidian", "logseq"] as const;
const IMPORT_TASK_KIND = "memory-wiki-import";
const IMPORT_OWNER_KEY = "memory-wiki:import";
const IMPORT_REVIEW_PATH = "reports/import-review.md";
const IMPORTED_OBSIDIAN_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const IMPORTED_MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g;

export const WIKI_IMPORT_PROFILE_IDS = [
  "local-file",
  "directory-text",
  "markdown-vault",
  "chatgpt-export",
] as const;

export type WikiImportProfileId = (typeof WIKI_IMPORT_PROFILE_IDS)[number];

type WikiImportArtifact = {
  absolutePath: string;
  relativePath: string;
  profileId: Exclude<WikiImportProfileId, "chatgpt-export">;
  importRootPath: string;
  sourceType: string;
};

type PreparedImportArtifact = {
  title: string;
  importedTags: string[];
  importedAliases: string[];
  importedLinkTargets: string[];
  renderedContentBody: string;
  bodyTextLength: number;
  nonEmptyLineCount: number;
  bodyFingerprint: string;
};

type WikiImportTaskContext = {
  requesterSessionKey?: string;
  ownerKey?: string;
  requesterOrigin?: Parameters<typeof createPluginTaskRun>[0]["requesterOrigin"];
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
};

export type WikiImportResult = {
  inputPath: string;
  profileId: WikiImportProfileId;
  profileResolution: "automatic" | "explicit";
  artifactCount: number;
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  removedCount: number;
  pagePaths: string[];
  reportPath: string;
  indexesRefreshed: boolean;
  indexUpdatedFiles: string[];
  indexRefreshReason: "compiled" | "auto-compile-disabled";
  taskId?: string;
  runId?: string;
};

type WikiImportProfileResolution = {
  profileId: WikiImportProfileId;
  profileResolution: "automatic" | "explicit";
};

type ImportWriteResult = {
  pagePath: string;
  changed: boolean;
  created: boolean;
  reviewEntry: ImportReviewEntry;
};

function normalizeImportProfileId(value?: string): WikiImportProfileId | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return (WIKI_IMPORT_PROFILE_IDS as readonly string[]).includes(normalized)
    ? (normalized as WikiImportProfileId)
    : undefined;
}

function detectFenceLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json" || ext === ".jsonl") {
    return "json";
  }
  if (ext === ".yaml" || ext === ".yml") {
    return "yaml";
  }
  if (ext === ".txt") {
    return "text";
  }
  return "markdown";
}

function assertUtf8Text(buffer: Buffer, sourcePath: string): string {
  const preview = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (preview.includes(0)) {
    throw new Error(`Cannot import binary file as text source: ${sourcePath}`);
  }
  return buffer.toString("utf8");
}

function humanizeImportPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\//g, " / ")
    .trim();
}

function resolveImportArtifactTitle(params: {
  relativePath: string;
  raw: string;
  profileId: WikiImportArtifact["profileId"];
  titleOverride?: string;
}): string {
  if (params.titleOverride?.trim()) {
    return params.titleOverride.trim();
  }
  if (params.profileId === "local-file") {
    return (
      extractTitleFromMarkdown(params.raw) ?? humanizeImportPath(path.basename(params.relativePath))
    );
  }
  return extractTitleFromMarkdown(params.raw) ?? humanizeImportPath(params.relativePath);
}

function normalizeImportedAliases(frontmatter: Record<string, unknown>): string[] {
  const aliases = normalizeSingleOrTrimmedStringList(frontmatter.aliases);
  if (aliases.length > 0) {
    return aliases;
  }
  return normalizeSingleOrTrimmedStringList(frontmatter.alias);
}

function renderMarkdownVaultBodyForEvidence(body: string): string {
  const withoutWikilinks = body.replace(
    IMPORTED_OBSIDIAN_LINK_PATTERN,
    (_match: string, rawTarget: string, rawLabel?: string) => {
      const target = rawTarget.trim();
      const label = rawLabel?.trim();
      return label || target;
    },
  );
  return withoutWikilinks.replace(
    IMPORTED_MARKDOWN_LINK_PATTERN,
    (match: string, label: string, rawTarget: string) => {
      const target = rawTarget.trim();
      if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target)) {
        return match;
      }
      const normalizedTarget = target.split("#")[0]?.split("?")[0]?.replace(/\\/g, "/").trim();
      return normalizedTarget ? `${label} (${normalizedTarget})` : label;
    },
  );
}

function buildImportBodyMetrics(text: string): {
  bodyTextLength: number;
  nonEmptyLineCount: number;
} {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    bodyTextLength: lines.join(" ").length,
    nonEmptyLineCount: lines.length,
  };
}

function buildImportBodyFingerprint(text: string): string {
  const normalized = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function prepareImportArtifact(params: {
  artifact: WikiImportArtifact;
  raw: string;
  titleOverride?: string;
}): PreparedImportArtifact {
  const title = resolveImportArtifactTitle({
    relativePath: params.artifact.relativePath,
    raw: params.raw,
    profileId: params.artifact.profileId,
    titleOverride: params.artifact.profileId === "local-file" ? params.titleOverride : undefined,
  });
  if (params.artifact.profileId !== "markdown-vault") {
    const metrics = buildImportBodyMetrics(params.raw);
    return {
      title,
      importedTags: [],
      importedAliases: [],
      importedLinkTargets: [],
      renderedContentBody: renderMarkdownFence(
        params.raw,
        detectFenceLanguage(params.artifact.absolutePath),
      ),
      bodyFingerprint: buildImportBodyFingerprint(params.raw),
      ...metrics,
    };
  }

  const parsed = parseWikiMarkdown(params.raw);
  const importedTags = normalizeSingleOrTrimmedStringList(parsed.frontmatter.tags);
  const importedAliases = normalizeImportedAliases(parsed.frontmatter);
  const importedLinkTargets = extractWikiLinks(parsed.body);
  const renderedContentBody = renderMarkdownVaultBodyForEvidence(parsed.body).trim();
  const metrics = buildImportBodyMetrics(renderedContentBody);

  return {
    title,
    importedTags,
    importedAliases,
    importedLinkTargets,
    renderedContentBody:
      renderedContentBody.length > 0
        ? renderedContentBody
        : "_Imported markdown note body was empty._",
    bodyFingerprint: buildImportBodyFingerprint(renderedContentBody),
    ...metrics,
  };
}

function shouldSkipMarkdownVaultDir(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized) {
    return false;
  }
  return (
    normalized === ".obsidian" ||
    normalized.startsWith(".obsidian/") ||
    normalized === "logseq" ||
    normalized.startsWith("logseq/") ||
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === "node_modules" ||
    normalized.startsWith("node_modules/") ||
    normalized === ".trash" ||
    normalized.startsWith(".trash/") ||
    normalized === ".logseq" ||
    normalized.startsWith(".logseq/")
  );
}

async function listImportFilesRecursive(params: {
  rootDir: string;
  allowedExtensions: ReadonlySet<string>;
  skipDir?: (relativePath: string) => boolean;
}): Promise<string[]> {
  async function walk(relativeDir: string): Promise<string[]> {
    const fullDir = relativeDir ? path.join(params.rootDir, relativeDir) : params.rootDir;
    const entries = await fs.readdir(fullDir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (params.skipDir?.(relativePath)) {
          continue;
        }
        files.push(...(await walk(relativePath)));
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (entry.isFile() && params.allowedExtensions.has(ext)) {
        files.push(relativePath.replace(/\\/g, "/"));
      }
    }
    return files;
  }

  return (await walk("")).toSorted((left, right) => left.localeCompare(right));
}

async function isMarkdownVaultRoot(inputPath: string): Promise<boolean> {
  for (const marker of MARKDOWN_VAULT_MARKERS) {
    if (await pathExists(path.join(inputPath, marker))) {
      return true;
    }
  }
  return false;
}

async function resolveWikiImportProfile(params: {
  inputPath: string;
  profileId?: WikiImportProfileId;
}): Promise<WikiImportProfileResolution> {
  if (params.profileId) {
    return {
      profileId: params.profileId,
      profileResolution: "explicit",
    };
  }

  const stat = await fs.stat(params.inputPath).catch(() => null);
  if (!stat) {
    throw new Error(`Import path not found: ${params.inputPath}`);
  }
  if (stat.isFile()) {
    const ext = path.extname(params.inputPath).toLowerCase();
    if (!DIRECTORY_TEXT_EXTENSIONS.has(ext)) {
      throw new Error(`Import path is not a supported text source: ${params.inputPath}`);
    }
    if (await detectChatGptExportFile(params.inputPath)) {
      return {
        profileId: "chatgpt-export",
        profileResolution: "automatic",
      };
    }
    return {
      profileId: "local-file",
      profileResolution: "automatic",
    };
  }
  if (!stat.isDirectory()) {
    throw new Error(`Import path must be a file or directory: ${params.inputPath}`);
  }
  if (await isMarkdownVaultRoot(params.inputPath)) {
    return {
      profileId: "markdown-vault",
      profileResolution: "automatic",
    };
  }
  return {
    profileId: "directory-text",
    profileResolution: "automatic",
  };
}

async function enumerateImportArtifacts(params: {
  inputPath: string;
  profileId: Exclude<WikiImportProfileId, "chatgpt-export">;
}): Promise<WikiImportArtifact[]> {
  if (params.profileId === "local-file") {
    return [
      {
        absolutePath: path.resolve(params.inputPath),
        relativePath: path.basename(params.inputPath),
        profileId: "local-file",
        importRootPath: path.dirname(path.resolve(params.inputPath)),
        sourceType: "local-file",
      },
    ];
  }

  const inputRoot = path.resolve(params.inputPath);
  const relativePaths = await listImportFilesRecursive({
    rootDir: inputRoot,
    allowedExtensions:
      params.profileId === "markdown-vault" ? MARKDOWN_VAULT_EXTENSIONS : DIRECTORY_TEXT_EXTENSIONS,
    ...(params.profileId === "markdown-vault" ? { skipDir: shouldSkipMarkdownVaultDir } : {}),
  });

  return relativePaths.map((relativePath) => ({
    absolutePath: path.join(inputRoot, relativePath),
    relativePath,
    profileId: params.profileId,
    importRootPath: inputRoot,
    sourceType: params.profileId === "markdown-vault" ? "markdown-vault" : "directory-text",
  }));
}

function resolveImportScopeKey(params: {
  inputPath: string;
  profileId: WikiImportProfileId;
}): string {
  return `${params.profileId}:${path.resolve(params.inputPath)}`;
}

function resolveImportPageIdentity(artifact: WikiImportArtifact): {
  pageId: string;
  pagePath: string;
} {
  const rootHash = createHash("sha1").update(artifact.importRootPath).digest("hex").slice(0, 8);
  const relativeHash = createHash("sha1").update(artifact.relativePath).digest("hex").slice(0, 8);
  const artifactSlug = slugifyWikiSegment(
    artifact.relativePath.replace(/\.[^.]+$/, "").replace(/[\\/]+/g, "-"),
  );
  return {
    pageId: `source.import.${artifact.profileId}.${rootHash}.${relativeHash}`,
    pagePath: path
      .join(
        "sources",
        `import-${artifact.profileId}-${rootHash}-${artifactSlug}-${relativeHash}.md`,
      )
      .replace(/\\/g, "/"),
  };
}

async function writeImportReviewReport(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  profileId: WikiImportProfileId;
  profileResolution: "automatic" | "explicit";
  artifactCount: number;
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  removedCount: number;
  pagePaths: string[];
  reviewEntries: ImportReviewEntry[];
}): Promise<string> {
  const reportPath = path.join(params.config.vault.path, IMPORT_REVIEW_PATH);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    renderWikiMarkdown({
      frontmatter: {
        pageType: "report",
        id: "report.import-review",
        title: "Import Review",
        status: "active",
        sourceType: "wiki-import-report",
        updatedAt: new Date().toISOString(),
      },
      body: buildImportReviewBody(params),
    }),
    "utf8",
  );
  return IMPORT_REVIEW_PATH;
}

async function writeImportArtifactPage(params: {
  config: ResolvedMemoryWikiConfig;
  artifact: WikiImportArtifact;
  state: Awaited<ReturnType<typeof readMemoryWikiSourceSyncState>>;
  scopeKey: string;
  titleOverride?: string;
}): Promise<ImportWriteResult> {
  const stats = await fs.stat(params.artifact.absolutePath);
  const raw = assertUtf8Text(
    await fs.readFile(params.artifact.absolutePath),
    params.artifact.absolutePath,
  );
  const prepared = prepareImportArtifact({
    artifact: params.artifact,
    raw,
    titleOverride: params.titleOverride,
  });
  const { pageId, pagePath } = resolveImportPageIdentity(params.artifact);
  const renderFingerprint = createHash("sha1")
    .update(
      JSON.stringify({
        profileId: params.artifact.profileId,
        sourceType: params.artifact.sourceType,
        importRootPath: params.artifact.importRootPath,
        relativePath: params.artifact.relativePath,
        title: prepared.title,
        importedTags: prepared.importedTags,
        importedAliases: prepared.importedAliases,
        importedLinkTargets: prepared.importedLinkTargets,
      }),
    )
    .digest("hex");

  const writeResult = await writeImportedSourcePage({
    vaultRoot: params.config.vault.path,
    syncKey: await resolveArtifactKey(params.artifact.absolutePath),
    sourcePath: params.artifact.absolutePath,
    sourceUpdatedAtMs: stats.mtimeMs,
    sourceSize: stats.size,
    renderFingerprint,
    pagePath,
    group: "import",
    scopeKey: params.scopeKey,
    state: params.state,
    buildRendered: (_existingRaw, updatedAt) =>
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: pageId,
          title: prepared.title,
          sourceType: params.artifact.sourceType,
          sourcePath: params.artifact.absolutePath,
          importProfile: params.artifact.profileId,
          importRootPath: params.artifact.importRootPath,
          importRelativePath: params.artifact.relativePath,
          ...(prepared.importedTags.length > 0 ? { importedTags: prepared.importedTags } : {}),
          ...(prepared.importedAliases.length > 0
            ? { importedAliases: prepared.importedAliases }
            : {}),
          ...(prepared.importedLinkTargets.length > 0
            ? { importedLinkTargets: prepared.importedLinkTargets }
            : {}),
          status: "active",
          updatedAt,
        },
        body: [
          `# ${prepared.title}`,
          "",
          "## Imported Source",
          `- Profile: \`${params.artifact.profileId}\``,
          `- Root: \`${params.artifact.importRootPath}\``,
          `- Relative path: \`${params.artifact.relativePath}\``,
          `- Updated: ${updatedAt}`,
          ...(prepared.importedTags.length > 0
            ? [`- Imported tags: ${prepared.importedTags.map((tag) => `\`${tag}\``).join(", ")}`]
            : []),
          ...(prepared.importedAliases.length > 0
            ? [
                `- Imported aliases: ${prepared.importedAliases
                  .map((alias) => `\`${alias}\``)
                  .join(", ")}`,
              ]
            : []),
          ...(prepared.importedLinkTargets.length > 0
            ? [
                `- Imported links: ${prepared.importedLinkTargets
                  .map((target) => `\`${target}\``)
                  .join(", ")}`,
              ]
            : []),
          "",
          params.artifact.profileId === "markdown-vault" ? "## Imported Markdown" : "## Content",
          prepared.renderedContentBody,
          "",
          "## Notes",
          "<!-- openclaw:human:start -->",
          "<!-- openclaw:human:end -->",
          "",
        ].join("\n"),
      }),
  });
  return {
    ...writeResult,
    reviewEntry: {
      title: prepared.title,
      relativePath: params.artifact.relativePath,
      pagePath,
      importedAliases: [...prepared.importedAliases],
      importedTags: [...prepared.importedTags],
      bodyTextLength: prepared.bodyTextLength,
      nonEmptyLineCount: prepared.nonEmptyLineCount,
      bodyFingerprint: prepared.bodyFingerprint,
    },
  };
}

async function writeChatGptConversationPage(params: {
  config: ResolvedMemoryWikiConfig;
  exportPath: string;
  conversation: ChatGptExportConversation;
  state: Awaited<ReturnType<typeof readMemoryWikiSourceSyncState>>;
  scopeKey: string;
}): Promise<ImportWriteResult> {
  const stats = await fs.stat(params.exportPath);
  const exportHash = createHash("sha1").update(params.exportPath).digest("hex").slice(0, 8);
  const conversationHash = createHash("sha1")
    .update(params.conversation.conversationId)
    .digest("hex")
    .slice(0, 8);
  const conversationSlug = slugifyWikiSegment(params.conversation.title);
  const pageId = `source.import.chatgpt-export.${exportHash}.${conversationHash}`;
  const pagePath = path
    .join(
      "sources",
      `import-chatgpt-export-${exportHash}-${conversationSlug}-${conversationHash}.md`,
    )
    .replace(/\\/g, "/");
  const renderFingerprint = createHash("sha1")
    .update(
      JSON.stringify({
        profileId: "chatgpt-export",
        exportPath: params.exportPath,
        conversationId: params.conversation.conversationId,
        title: params.conversation.title,
        relativePath: params.conversation.relativePath,
        transcriptBody: params.conversation.transcriptBody,
        messageCount: params.conversation.messageCount,
        participantRoles: params.conversation.participantRoles,
        conversationCreatedAt: params.conversation.conversationCreatedAt,
        conversationUpdatedAt: params.conversation.conversationUpdatedAt,
      }),
    )
    .digest("hex");
  const rendered = renderWikiMarkdown({
    frontmatter: {
      pageType: "source",
      id: pageId,
      title: params.conversation.title,
      sourceType: "chatgpt-export",
      sourcePath: params.exportPath,
      importProfile: "chatgpt-export",
      importRootPath: path.dirname(params.exportPath),
      importRelativePath: params.conversation.relativePath,
      importedTags: ["chatgpt-export"],
      importedAliases: [params.conversation.conversationId],
      status: "active",
      updatedAt: new Date(stats.mtimeMs).toISOString(),
    },
    body: [
      `# ${params.conversation.title}`,
      "",
      "## Imported Source",
      "- Profile: `chatgpt-export`",
      `- Export file: \`${params.exportPath}\``,
      `- Relative path: \`${params.conversation.relativePath}\``,
      `- Conversation id: \`${params.conversation.conversationId}\``,
      ...(params.conversation.conversationCreatedAt
        ? [`- Conversation created: ${params.conversation.conversationCreatedAt}`]
        : []),
      ...(params.conversation.conversationUpdatedAt
        ? [`- Conversation updated: ${params.conversation.conversationUpdatedAt}`]
        : []),
      `- Messages: ${params.conversation.messageCount}`,
      ...(params.conversation.participantRoles.length > 0
        ? [
            `- Participants: ${params.conversation.participantRoles
              .map((role) => `\`${role}\``)
              .join(", ")}`,
          ]
        : []),
      "",
      "## Conversation Transcript",
      params.conversation.transcriptBody,
      "",
      "## Notes",
      "<!-- openclaw:human:start -->",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n"),
  });
  const writeResult = await writeImportedSourcePage({
    vaultRoot: params.config.vault.path,
    syncKey: `chatgpt-export:${params.exportPath}#${params.conversation.conversationId}`,
    sourcePath: params.exportPath,
    sourceUpdatedAtMs: stats.mtimeMs,
    sourceSize: stats.size,
    renderFingerprint,
    pagePath,
    group: "import",
    scopeKey: params.scopeKey,
    state: params.state,
    rendered,
  });
  const bodyMetrics = buildImportBodyMetrics(params.conversation.transcriptBody);
  return {
    ...writeResult,
    reviewEntry: {
      title: params.conversation.title,
      relativePath: params.conversation.relativePath,
      pagePath,
      importedAliases: [params.conversation.conversationId],
      importedTags: ["chatgpt-export"],
      bodyFingerprint: buildImportBodyFingerprint(params.conversation.transcriptBody),
      ...bodyMetrics,
    },
  };
}

export async function importMemoryWikiInput(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  profileId?: string;
  title?: string;
  taskContext?: WikiImportTaskContext;
}): Promise<WikiImportResult> {
  await initializeMemoryWikiVault(params.config);

  const normalizedInputPath = path.resolve(params.inputPath);
  const requestedProfileId = normalizeImportProfileId(params.profileId);
  if (params.profileId && !requestedProfileId) {
    throw new Error(
      `Unknown import profile: ${params.profileId}. Expected one of: ${WIKI_IMPORT_PROFILE_IDS.join(", ")}`,
    );
  }

  const taskHandle = createPluginTaskRun({
    taskKind: IMPORT_TASK_KIND,
    sourceId: "memory-wiki:import",
    requesterSessionKey: params.taskContext?.requesterSessionKey,
    ownerKey:
      params.taskContext?.ownerKey ??
      (params.taskContext?.requesterSessionKey ? undefined : IMPORT_OWNER_KEY),
    requesterOrigin: params.taskContext?.requesterOrigin,
    parentFlowId: params.taskContext?.parentFlowId,
    parentTaskId: params.taskContext?.parentTaskId,
    agentId: params.taskContext?.agentId,
    label: "Wiki import",
    task: `Import wiki sources from ${normalizedInputPath}`,
    progressSummary: "Detecting import profile",
  });

  try {
    const profile = await resolveWikiImportProfile({
      inputPath: normalizedInputPath,
      profileId: requestedProfileId,
    });
    recordPluginTaskProgress({
      handle: taskHandle,
      progressSummary: `Enumerating ${profile.profileId} sources`,
      eventSummary: `Detected ${profile.profileId} import profile`,
    });

    const scopeKey = resolveImportScopeKey({
      inputPath: normalizedInputPath,
      profileId: profile.profileId,
    });
    const state = await readMemoryWikiSourceSyncState(params.config.vault.path);
    const activeKeys = new Set<string>();
    const results: ImportWriteResult[] = [];
    let artifactCount = 0;

    if (profile.profileId === "chatgpt-export") {
      recordPluginTaskProgress({
        handle: taskHandle,
        progressSummary: "Reading chatgpt-export conversations",
      });
      const conversations = await parseChatGptExportFile(normalizedInputPath);
      artifactCount = conversations.length;
      for (const [index, conversation] of conversations.entries()) {
        activeKeys.add(`chatgpt-export:${normalizedInputPath}#${conversation.conversationId}`);
        recordPluginTaskProgress({
          handle: taskHandle,
          progressSummary: `Importing ${index + 1}/${conversations.length} conversations`,
          eventSummary: conversation.title,
        });
        results.push(
          await writeChatGptConversationPage({
            config: params.config,
            exportPath: normalizedInputPath,
            conversation,
            state,
            scopeKey,
          }),
        );
      }
    } else {
      const artifacts = await enumerateImportArtifacts({
        inputPath: normalizedInputPath,
        profileId: profile.profileId,
      });
      if (artifacts.length === 0) {
        throw new Error(
          `No importable sources found for ${profile.profileId}: ${normalizedInputPath}`,
        );
      }
      artifactCount = artifacts.length;
      for (const [index, artifact] of artifacts.entries()) {
        activeKeys.add(await resolveArtifactKey(artifact.absolutePath));
        recordPluginTaskProgress({
          handle: taskHandle,
          progressSummary: `Importing ${index + 1}/${artifacts.length} sources`,
          eventSummary: artifact.relativePath,
        });
        results.push(
          await writeImportArtifactPage({
            config: params.config,
            artifact,
            state,
            scopeKey,
            titleOverride: params.title,
          }),
        );
      }
    }

    const removedCount = await pruneImportedSourceEntries({
      vaultRoot: params.config.vault.path,
      group: "import",
      activeKeys,
      state,
      scopeKey,
    });
    await writeMemoryWikiSourceSyncState(params.config.vault.path, state);

    const pagePaths = results
      .map((result) => result.pagePath)
      .toSorted((left, right) => left.localeCompare(right));
    const importedCount = results.filter((result) => result.changed && result.created).length;
    const updatedCount = results.filter((result) => result.changed && !result.created).length;
    const skippedCount = results.filter((result) => !result.changed).length;

    recordPluginTaskProgress({
      handle: taskHandle,
      progressSummary: "Writing import review",
    });
    const reportPath = await writeImportReviewReport({
      config: params.config,
      inputPath: normalizedInputPath,
      profileId: profile.profileId,
      profileResolution: profile.profileResolution,
      artifactCount,
      importedCount,
      updatedCount,
      skippedCount,
      removedCount,
      pagePaths,
      reviewEntries: results.map((result) => result.reviewEntry),
    });

    let compile: CompileMemoryWikiResult | null = null;
    let indexRefreshReason: WikiImportResult["indexRefreshReason"] = "auto-compile-disabled";
    if (params.config.ingest.autoCompile) {
      recordPluginTaskProgress({
        handle: taskHandle,
        progressSummary: "Compiling wiki indexes",
      });
      compile = await compileMemoryWikiVault(params.config);
      indexRefreshReason = "compiled";
    }

    await appendMemoryWikiLog(params.config.vault.path, {
      type: "ingest",
      timestamp: new Date().toISOString(),
      details: {
        sourceType: "memory-import",
        inputPath: normalizedInputPath,
        profileId: profile.profileId,
        profileResolution: profile.profileResolution,
        artifactCount,
        importedCount,
        updatedCount,
        skippedCount,
        removedCount,
        reportPath,
      },
    });

    const result: WikiImportResult = {
      inputPath: normalizedInputPath,
      profileId: profile.profileId,
      profileResolution: profile.profileResolution,
      artifactCount,
      importedCount,
      updatedCount,
      skippedCount,
      removedCount,
      pagePaths,
      reportPath,
      indexesRefreshed: compile !== null,
      indexUpdatedFiles: compile?.updatedFiles ?? [],
      indexRefreshReason,
      taskId: taskHandle.taskId,
      runId: taskHandle.runId,
    };

    completePluginTaskRun({
      handle: taskHandle,
      progressSummary: `Imported ${artifactCount} sources`,
      terminalSummary: `Imported ${artifactCount} sources via ${profile.profileId} (${importedCount} new, ${updatedCount} updated, ${skippedCount} unchanged, ${removedCount} removed).`,
    });
    return result;
  } catch (error) {
    failPluginTaskRun({
      handle: taskHandle,
      error,
      progressSummary: "Wiki import failed",
      terminalSummary: `Wiki import failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  }
}
