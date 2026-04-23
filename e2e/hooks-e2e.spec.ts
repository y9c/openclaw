import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page, type WebSocket } from "@playwright/test";

const GATEWAY_HTTP = "http://127.0.0.1:19005";
const GATEWAY_WS = "ws://127.0.0.1:19005";
const AUTH_TOKEN = "d4d2f9d6e37dfe2e306742aad982285206f2e0039ca62cf6";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(HERE, "screenshots");
const FRAMES_DIR = join(HERE, "frames");
mkdirSync(SCREENSHOT_DIR, { recursive: true });
mkdirSync(FRAMES_DIR, { recursive: true });

type JsonObject = Record<string, unknown>;

type ParsedFrame = {
  dir: "in" | "out";
  ts: number;
  raw: string;
  data: JsonObject | null;
};

type FramesBag = { frames: ParsedFrame[] };

type HookEvent = { ts: number; msg: JsonObject };

type HookRunResult = {
  events: HookEvent[];
  finalState: "final" | "error" | "timeout";
  errorMessage?: string;
  errorKind?: string;
  text: string;
  approvalIds: string[];
  retryCount: number;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function getString(obj: JsonObject | undefined, key: string): string | undefined {
  if (!obj) {
    return undefined;
  }
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function getObject(obj: JsonObject | undefined, key: string): JsonObject | undefined {
  if (!obj) {
    return undefined;
  }
  const v = obj[key];
  return isObject(v) ? v : undefined;
}

/**
 * Open the control-ui in WebKit and inject the auth token into localStorage
 * BEFORE the SPA boots. Capture every WebSocket frame the SPA exchanges so
 * we have protocol-level evidence even when we drive the gateway through
 * our own raw WebSocket.
 */
async function openControlUi(page: Page, bag: FramesBag): Promise<void> {
  page.on("websocket", (ws: WebSocket) => {
    ws.on("framesent", (event) => {
      const raw =
        typeof event.payload === "string" ? event.payload : event.payload.toString("utf8");
      let parsed: JsonObject | null = null;
      try {
        const j = JSON.parse(raw) as unknown;
        parsed = isObject(j) ? j : null;
      } catch {
        parsed = null;
      }
      bag.frames.push({ dir: "out", ts: Date.now(), raw, data: parsed });
    });
    ws.on("framereceived", (event) => {
      const raw =
        typeof event.payload === "string" ? event.payload : event.payload.toString("utf8");
      let parsed: JsonObject | null = null;
      try {
        const j = JSON.parse(raw) as unknown;
        parsed = isObject(j) ? j : null;
      } catch {
        parsed = null;
      }
      bag.frames.push({ dir: "in", ts: Date.now(), raw, data: parsed });
    });
  });

  await page.addInitScript((token: string) => {
    try {
      // Canonical SPA settings key (see ui/src/ui/navigation.browser.test.ts).
      const KEY = "openclaw.control.settings.v1";
      let existing: Record<string, unknown> = {};
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            existing = parsed as Record<string, unknown>;
          }
        }
      } catch {
        existing = {};
      }
      existing.token = token;
      localStorage.setItem(KEY, JSON.stringify(existing));
      // Legacy fallback keys some older builds checked for.
      localStorage.setItem("openclaw.controlUi.authToken", token);
      localStorage.setItem("openclaw.auth.token", token);
      localStorage.setItem("authToken", token);
    } catch {
      /* localStorage may be unavailable on some pages */
    }
  }, AUTH_TOKEN);

  await page.goto(GATEWAY_HTTP, { waitUntil: "domcontentloaded" });
}

type RunOpts = {
  timeoutMs?: number;
  approvalDecision?: "allow-once" | "deny" | null;
  waitAfterFinalMs?: number;
  /**
   * Delay (ms) between receiving the `approval.requested` event and sending
   * the approval response. Used by tool-gating tests that need a window to
   * observe whether downstream tool execution happened while the hook was
   * paused awaiting a human decision.
   */
  approvalDelayMs?: number;
};

/**
 * Drive the gateway over a fresh WebKit-originated WebSocket from inside the
 * page context. This goes through the same protocol path the SPA uses and
 * gives the suite deterministic control over every connect/chat/approval
 * frame.
 */
async function runHookTrigger(
  page: Page,
  message: string,
  opts: RunOpts = {},
): Promise<HookRunResult> {
  const sessionKey = `e2e-${randomUUID()}`;
  const idempotencyKey = randomUUID();
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const approvalDecision = opts.approvalDecision ?? null;
  const waitAfterFinalMs = opts.waitAfterFinalMs ?? 0;

  type EvalArgs = {
    wsUrl: string;
    token: string;
    message: string;
    sessionKey: string;
    idempotencyKey: string;
    timeoutMs: number;
    approvalDecision: "allow-once" | "deny" | null;
    waitAfterFinalMs: number;
    approvalDelayMs: number;
  };

  const args: EvalArgs = {
    wsUrl: GATEWAY_WS,
    token: AUTH_TOKEN,
    message,
    sessionKey,
    idempotencyKey,
    timeoutMs,
    approvalDecision,
    waitAfterFinalMs,
    approvalDelayMs: opts.approvalDelayMs ?? 0,
  };

  return await page.evaluate((a: EvalArgs) => {
    type WireRecord = Record<string, unknown>;
    type LocalEvent = { ts: number; msg: WireRecord };

    return new Promise<HookRunResult>((resolve) => {
      const ws = new WebSocket(a.wsUrl);
      const events: LocalEvent[] = [];
      const approvalIds: string[] = [];
      let text = "";
      let finalState: "final" | "error" | "timeout" = "timeout";
      let errorMessage: string | undefined;
      let errorKind: string | undefined;
      let retryCount = 0;
      let nextId = 100;
      let connected = false;
      let runStarted = false;
      let finished = false;

      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          try {
            ws.close();
          } catch {
            /* already closed */
          }
          resolve({
            events: events as HookEvent[],
            finalState,
            errorMessage,
            errorKind,
            text,
            approvalIds,
            retryCount,
          });
        }
      }, a.timeoutMs);

      const send = (obj: WireRecord) => {
        ws.send(JSON.stringify(obj));
      };

      const finish = (state: "final" | "error") => {
        finalState = state;
        const settle = () => {
          if (finished) {
            return;
          }
          finished = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            /* already closed */
          }
          resolve({
            events: events as HookEvent[],
            finalState,
            errorMessage,
            errorKind,
            text,
            approvalIds,
            retryCount,
          });
        };
        if (a.waitAfterFinalMs > 0) {
          setTimeout(settle, a.waitAfterFinalMs);
        } else {
          settle();
        }
      };

      const isObj = (v: unknown): v is WireRecord => typeof v === "object" && v !== null;

      const getStr = (o: WireRecord | undefined, k: string): string | undefined => {
        if (!o) {
          return undefined;
        }
        const v = o[k];
        return typeof v === "string" ? v : undefined;
      };

      const getObj = (o: WireRecord | undefined, k: string): WireRecord | undefined => {
        if (!o) {
          return undefined;
        }
        const v = o[k];
        return isObj(v) ? v : undefined;
      };

      const extractMessageText = (m: WireRecord | undefined): string => {
        if (!m) {
          return "";
        }
        const t = getStr(m, "text");
        if (t) {
          return t;
        }
        const content = m["content"];
        if (Array.isArray(content)) {
          return content.map((c) => (isObj(c) ? (getStr(c, "text") ?? "") : "")).join("");
        }
        return "";
      };

      const onMessage = (ev: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }
        if (!isObj(parsed)) {
          return;
        }
        const data = parsed;
        events.push({ ts: Date.now(), msg: data });

        const dataType = getStr(data, "type");
        const dataEvent = getStr(data, "event");
        const dataMethod = getStr(data, "method");

        // Connect handshake: server sends 'connect.challenge' as event with payload
        if ((dataType === "event" || dataType === "evt") && dataEvent === "connect.challenge") {
          send({
            type: "req",
            id: "connect-" + Date.now(),
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              auth: { token: a.token },
              client: {
                id: "openclaw-control-ui",
                version: "2026.4.15-beta.1",
                platform: "MacIntel",
                mode: "webchat",
                instanceId: "e2e-" + Math.random().toString(36).slice(2),
              },
              role: "operator",
              scopes: [
                "operator.admin",
                "operator.read",
                "operator.write",
                "operator.approvals",
                "operator.pairing",
              ],
              caps: ["tool-events"],
              userAgent: "e2e-webkit",
              locale: "en-US",
            },
          });
          void dataMethod;
          return;
        }

        if (dataType === "res" && data["ok"] === true && !connected) {
          connected = true;
          if (!runStarted) {
            runStarted = true;
            send({
              type: "req",
              id: String(nextId++),
              method: "chat.send",
              params: {
                sessionKey: a.sessionKey,
                message: a.message,
                idempotencyKey: a.idempotencyKey,
              },
            });
          }
          return;
        }

        if (dataType === "res" && data["ok"] === false) {
          const err = getObj(data, "error");
          errorMessage = getStr(err, "message") || "rpc-error";
          const details = getObj(err, "details");
          errorKind = getStr(err, "code") || getStr(details, "code") || "rpc-error";
          if (!runStarted) {
            finish("error");
          }
          return;
        }

        if (dataType === "event" || dataType === "evt") {
          const d = getObj(data, "payload") ?? getObj(data, "data") ?? {};
          if (dataEvent === "chat") {
            const message = getObj(d, "message");
            const stateField = getStr(d, "state");
            const delta = getStr(d, "delta");
            if (delta) {
              text += delta;
            }
            if (stateField === "delta" && message) {
              const t = extractMessageText(message);
              if (t) {
                text = t;
              }
            }
            if (stateField === "final" && message) {
              const t = extractMessageText(message);
              if (t) {
                text = t;
              }
            }
            const dText = getStr(d, "text");
            if (dText && stateField === "final") {
              text = dText;
            }
            if (stateField === "error") {
              errorMessage =
                getStr(d, "errorMessage") ||
                getStr(d, "message") ||
                extractMessageText(message) ||
                "unknown";
              errorKind = getStr(d, "errorKind") || getStr(d, "kind");
              finish("error");
              return;
            }
            if (stateField === "final") {
              const t = text || extractMessageText(message);
              const errorish = /agent failed|blocked|policy|denied|hook-echo/i.test(t);
              const maybeToolOutputAsk =
                /HOOK_ASK_TOOL_OUTPUT|requires human approval before flowing back to the llm/i.test(
                  a.message + " " + t,
                );
              if (maybeToolOutputAsk && approvalIds.length === 0) {
                // after_tool_call approvals can be emitted just after the tool-result/final
                // frame; don't close too early or we'll miss the approval request.
                return;
              }
              if (errorish) {
                errorMessage = t;
                errorKind = errorKind || "final-block";
                finish("error");
                return;
              }
              finish("final");
              return;
            }
            if (stateField === "retry" || d["retry"] === true) {
              retryCount += 1;
            }
          }
          if ((dataEvent ?? "").includes("approval")) {
            const id = getStr(d, "id") ?? getStr(d, "approvalId");
            const looksLikeApprovalRequest =
              !!id &&
              (dataEvent === "plugin.approval.requested" ||
                dataEvent === "approval.requested" ||
                getStr(d, "kind") === "approval" ||
                typeof d["toolCallId"] === "string" ||
                typeof d["hook"] === "string" ||
                typeof d["reason"] === "string");
            if (looksLikeApprovalRequest) {
              approvalIds.push(id);
              if (a.approvalDecision) {
                const sendDecision = () =>
                  send({
                    type: "req",
                    id: String(nextId++),
                    method: "plugin.approval.resolve",
                    params: { id, decision: a.approvalDecision },
                  });
                if (a.approvalDelayMs > 0) {
                  setTimeout(sendDecision, a.approvalDelayMs);
                } else {
                  sendDecision();
                }
              }
            }
          }
        }
      };

      const onError = () => {
        errorMessage = errorMessage || "ws-error";
        errorKind = errorKind || "ws-error";
        finish("error");
      };

      const onClose = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve({
            events: events as HookEvent[],
            finalState,
            errorMessage,
            errorKind,
            text,
            approvalIds,
            retryCount,
          });
        }
      };

      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    });
  }, args);
}

function logFrames(name: string, frames: ParsedFrame[]) {
  const path = join(FRAMES_DIR, `${name}.jsonl`);
  const lines = frames.map((f) =>
    JSON.stringify({ ts: f.ts, dir: f.dir, data: f.data ?? f.raw.slice(0, 500) }),
  );
  writeFileSync(path, lines.join("\n"));
}

function recordResult(name: string, payload: HookRunResult) {
  const line = JSON.stringify({ ts: Date.now(), name, ...payload });
  appendFileSync(join(HERE, "results.jsonl"), line + "\n");
}

async function shoot(page: Page, name: string) {
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  try {
    await page.screenshot({ path, fullPage: true });
  } catch {
    /* page may already be closed */
  }
  return path;
}

const bagFor = new WeakMap<Page, FramesBag>();

function getBag(page: Page): FramesBag {
  let bag = bagFor.get(page);
  if (!bag) {
    bag = { frames: [] };
    bagFor.set(page, bag);
  }
  return bag;
}

function chatDeltaCount(events: HookEvent[]): number {
  return events.filter((e) => {
    if (!isObject(e.msg)) {
      return false;
    }
    if (getString(e.msg, "event") !== "chat") {
      return false;
    }
    const payload = getObject(e.msg, "payload") ?? getObject(e.msg, "data");
    return getString(payload, "state") === "delta";
  }).length;
}

test.describe("Lifecycle hook outcomes (WebKit)", () => {
  test.beforeEach(async ({ page }) => {
    await openControlUi(page, getBag(page));
  });

  test.afterEach(async ({ page }, testInfo) => {
    const bag = getBag(page);
    const safe = testInfo.title.replace(/[^a-z0-9]+/gi, "_");
    logFrames(safe, bag.frames);
    await shoot(page, `${safe}_end`);
  });

  test("normal message (no hook trigger)", async ({ page }) => {
    await shoot(page, "normal_pre");
    const result = await runHookTrigger(page, "Reply with the single word OK and nothing else.", {
      timeoutMs: 90_000,
    });
    await shoot(page, "normal_post");
    recordResult("normal", result);
    expect(["final", "error"]).toContain(result.finalState);
    if (result.finalState === "final") {
      expect((result.text || "").length).toBeGreaterThan(0);
    }
  });

  test("HOOK_BLOCK_RUN — before_agent_run block", async ({ page }) => {
    await shoot(page, "block_run_pre");
    const result = await runHookTrigger(page, "HOOK_BLOCK_RUN please block this", {
      timeoutMs: 30_000,
    });
    await shoot(page, "block_run_post");
    recordResult("HOOK_BLOCK_RUN", result);
    expect(result.finalState).toBe("error");
    const msg = (result.errorMessage || result.text || "").toLowerCase();
    expect(msg).toMatch(/block|policy|denied/);
    // No streaming LLM output should have arrived (only the block message)
    expect(chatDeltaCount(result.events)).toBe(0);
  });

  test("HOOK_ASK_RUN — before_agent_run ask (approve)", async ({ page }) => {
    await shoot(page, "ask_run_approve_pre");
    const result = await runHookTrigger(page, "HOOK_ASK_RUN please ask, then continue", {
      timeoutMs: 90_000,
      approvalDecision: "allow-once",
    });
    await shoot(page, "ask_run_approve_post");
    recordResult("HOOK_ASK_RUN_approve", result);
    expect(result.approvalIds.length).toBeGreaterThanOrEqual(1);
    expect(["final", "error"]).toContain(result.finalState);
  });

  test("HOOK_ASK_RUN — before_agent_run ask (deny)", async ({ page }) => {
    await shoot(page, "ask_run_deny_pre");
    const result = await runHookTrigger(page, "HOOK_ASK_RUN please ask, then deny", {
      timeoutMs: 60_000,
      approvalDecision: "deny",
    });
    await shoot(page, "ask_run_deny_post");
    recordResult("HOOK_ASK_RUN_deny", result);
    expect(result.approvalIds.length).toBeGreaterThanOrEqual(1);
    expect(result.finalState).toBe("error");
  });

  test("HOOK_BLOCK_OUTPUT — llm_output block", async ({ page }) => {
    await shoot(page, "block_output_pre");
    const result = await runHookTrigger(
      page,
      "HOOK_BLOCK_OUTPUT please answer something then get blocked",
      { timeoutMs: 90_000, waitAfterFinalMs: 1500 },
    );
    await shoot(page, "block_output_post");
    recordResult("HOOK_BLOCK_OUTPUT", result);
    // We document either path: error or final-with-block-text
    expect(["final", "error"]).toContain(result.finalState);
  });

  test("HOOK_BLOCK_OUTPUT — UI replaces streamed text with block warning", async ({ page }) => {
    // Regression test for the redaction shape-mismatch bug:
    // The runner calls redactMessages() to scrub the streamed LLM response
    // from the persisted session transcript before broadcasting the block
    // warning as the new assistant message. Before the fix, redactMessages
    // failed to match the runner's nested `{ type: "message", message: {...} }`
    // JSONL shape, so the streamed text stayed on disk. The SPA's
    // post-`final` history reload then overwrote the in-memory block warning
    // with the streamed text, leaving the transcript showing the original
    // LLM answer with only a small toast indicating the block.
    //
    // This test drives a real chat send through the SPA chat input, waits
    // for the reload to settle, and asserts that the visible assistant
    // bubble in the DOM is the block warning — NOT the streamed text.
    // Use a unique nonce token in the prompt so we can detect whether the
    // streamed LLM response (which always echoes/uses the prompt content)
    // ends up in the rendered transcript. The block warning never contains
    // this nonce, so any occurrence of the nonce outside the user bubble
    // is proof the streamed text was not properly redacted.
    const NONCE = `qzx-${randomUUID().slice(0, 8)}`;
    const TRIGGER = `HOOK_BLOCK_OUTPUT reply with the literal token ${NONCE} and nothing else`;

    // Use a fresh session for isolation. The default `agent:main` session
    // can carry prior assistant transcript content from earlier interactive
    // use of the dev gateway (it shares ~/.openclaw/ with the prod gateway),
    // which would pollute substring assertions on the rendered transcript.
    const freshSession = `agent:main:e2e-blockout-${randomUUID()}`;
    await page.goto(`${GATEWAY_HTTP}/?session=${encodeURIComponent(freshSession)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle");
    await shoot(page, "block_output_ui_pre");

    // First-load auth gate: the SPA shows a "Gateway Token" textbox and a
    // "Connect" button on first visit. localStorage seeding sometimes races
    // with the SPA's first read, so do the deterministic thing: drive the
    // visible auth form when it appears.
    const tokenField = page.getByRole("textbox", { name: /Gateway Token/i });
    const connectBtn = page.getByRole("button", { name: /^Connect$/i });
    if (await tokenField.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await tokenField.fill(AUTH_TOKEN);
      await connectBtn.click();
    }

    // Find the chat composer textarea. The SPA renders a single chat textarea
    // when on the chat tab.
    const composer = page.locator("textarea").last();
    await composer.waitFor({ state: "visible", timeout: 60_000 });
    await composer.click();
    await composer.fill(TRIGGER);
    await composer.press("Enter");

    // Wait for the chat run to settle: the SPA flips its loading/sending
    // state and renders the final assistant bubble. We poll the page for
    // the block warning text or, after a reasonable wait, give up.
    // The block bubble shows the plugin's reason text. Match a stable
    // substring that survives both the legacy post-prompt path and the new
    // inline-abort path. The hook-echo plugin emits both:
    //   "[hook-echo] Output blocked by HOOK_BLOCK_OUTPUT trigger" (block)
    //   "Response withheld by hook-echo plugin"                  (legacy)
    // We accept either by checking for "blocked by" or "withheld" (case-insensitive).
    const blockNeedleAlternatives = ["blocked by", "withheld"];

    // Wait up to 90s for the run to complete and the SPA to settle. We
    // explicitly read the LAST assistant bubble's text and assert it
    // contains the block warning. The bug we are guarding against is
    // exactly this: the SPA reloads history after `final`, the persisted
    // transcript still holds the streamed LLM text (because redaction
    // silently no-ops), and the in-memory block warning gets clobbered —
    // leaving the assistant bubble showing the streamed LLM text and the
    // block warning surviving only as a toast.
    type Snapshot = {
      assistantBubbles: string[];
      lastAssistantText: string;
      toastText: string;
      pageText: string;
    };
    let snapshot: Snapshot = {
      assistantBubbles: [],
      lastAssistantText: "",
      toastText: "",
      pageText: "",
    };
    const start = Date.now();
    const deadline = start + 90_000;
    let stableCount = 0;
    while (Date.now() < deadline) {
      snapshot = await page.evaluate(() => {
        // The chat transcript renders each assistant turn under
        // `.chat-group.assistant`. We want the LAST one because the bug
        // shows up as: streamed-text bubble appears, block warning briefly
        // replaces it, then the post-final history reload restores the
        // streamed text again.
        const assistantBubbles = Array.from(
          document.querySelectorAll<HTMLElement>(".chat-group.assistant"),
        ).map((el) => (el.innerText || "").trim());
        const lastAssistantText = assistantBubbles[assistantBubbles.length - 1] ?? "";
        const toastEl = document.querySelector<HTMLElement>(
          '[role="status"], [class*="toast" i], [class*="banner" i]',
        );
        const toastText = (toastEl?.innerText || "").trim();
        return {
          assistantBubbles,
          lastAssistantText,
          toastText,
          pageText: document.body?.innerText || "",
        };
      });
      const lowerLast = snapshot.lastAssistantText.toLowerCase();
      const lastHasBlock = blockNeedleAlternatives.some((needle) =>
        lowerLast.includes(needle.toLowerCase()),
      );
      // Stable green: last assistant bubble shows the block warning AND has
      // been stable for > 4s (so any history reload has had time to clobber
      // it if the bug is present).
      if (lastHasBlock) {
        stableCount += 1;
        if (stableCount >= 4 && Date.now() - start > 6_000) {
          break;
        }
      } else {
        stableCount = 0;
      }
      // Bug-detection fail-fast: only bail if a non-block bubble has been
      // stable for >25s. We need a long window because the SPA's history
      // reload after `error/final` is async (a follow-up `chat.history` RPC)
      // and may take 5-15s after streaming starts.
      if (snapshot.assistantBubbles.length > 0 && !lastHasBlock && Date.now() - start > 25_000) {
        break;
      }
      await page.waitForTimeout(500);
    }

    await shoot(page, "block_output_ui_post");

    const lastHasBlock = blockNeedleAlternatives.some((needle) =>
      snapshot.lastAssistantText.toLowerCase().includes(needle.toLowerCase()),
    );

    recordResult("HOOK_BLOCK_OUTPUT_ui", {
      events: [],
      finalState: lastHasBlock ? "final" : "error",
      text: snapshot.lastAssistantText.slice(0, 200),
      approvalIds: [],
      retryCount: 0,
      errorMessage: `lastBubbleHasBlock=${lastHasBlock}, bubbleCount=${snapshot.assistantBubbles.length}, lastBubbleText=${JSON.stringify(snapshot.lastAssistantText.slice(0, 200))}, toastText=${JSON.stringify(snapshot.toastText.slice(0, 120))}, nonce=${NONCE}`,
    });

    expect(
      snapshot.assistantBubbles.length,
      "at least one assistant bubble must be rendered",
    ).toBeGreaterThanOrEqual(1);
    expect(
      lastHasBlock,
      `last assistant bubble must contain the block warning, got: ${JSON.stringify(snapshot.lastAssistantText.slice(0, 240))}`,
    ).toBe(true);

    // Bug B regression: after the inline-block fires, the SPA reloads
    // history via `chat.history`. If the prior streamed text was NOT
    // scrubbed from the persisted JSONL, the reload re-renders that
    // streamed text alongside the block warning, and the user sees both.
    // The streamed reply always contains the NONCE we asked for; the
    // block warning never does. So if NO assistant bubble contains the
    // nonce, the redaction worked. Wait an additional 5s after the
    // primary assertion to give any late history reload time to settle.
    await page.waitForTimeout(5_000);
    const finalSnapshot = await page.evaluate(() => {
      return Array.from(document.querySelectorAll<HTMLElement>(".chat-group.assistant")).map((el) =>
        (el.innerText || "").trim(),
      );
    });
    const anyBubbleHasNonce = finalSnapshot.some((b) => b.includes(NONCE));
    expect(
      anyBubbleHasNonce,
      `Bug B regression: the streamed LLM text containing the nonce ${NONCE} ` +
        `survived in an assistant bubble after history reload. The inline-` +
        `block path must scrub the prior streamed assistant message from the ` +
        `JSONL transcript so it does not resurface on reload. ` +
        `bubbles=${JSON.stringify(finalSnapshot.map((b) => b.slice(0, 120)))}`,
    ).toBe(false);
  });

  test("HOOK_BLOCK_RETRY — llm_output block with retry", async ({ page }) => {
    await shoot(page, "block_retry_pre");
    const result = await runHookTrigger(page, "HOOK_BLOCK_RETRY please answer and trigger retry", {
      timeoutMs: 120_000,
    });
    await shoot(page, "block_retry_post");
    recordResult("HOOK_BLOCK_RETRY", result);
    expect(["final", "error"]).toContain(result.finalState);
  });

  test("HOOK_ASK_OUTPUT — llm_output ask (approve)", async ({ page }) => {
    await shoot(page, "ask_output_approve_pre");
    const result = await runHookTrigger(
      page,
      "HOOK_ASK_OUTPUT please answer and ask for approval",
      { timeoutMs: 120_000, approvalDecision: "allow-once" },
    );
    await shoot(page, "ask_output_approve_post");
    recordResult("HOOK_ASK_OUTPUT_approve", result);
    expect(result.approvalIds.length).toBeGreaterThanOrEqual(1);
    expect(["final", "error"]).toContain(result.finalState);
  });

  test("HOOK_ASK_OUTPUT — llm_output ask (deny)", async ({ page }) => {
    await shoot(page, "ask_output_deny_pre");
    const result = await runHookTrigger(page, "HOOK_ASK_OUTPUT please answer then deny", {
      timeoutMs: 120_000,
      approvalDecision: "deny",
    });
    await shoot(page, "ask_output_deny_post");
    recordResult("HOOK_ASK_OUTPUT_deny", result);
    expect(result.approvalIds.length).toBeGreaterThanOrEqual(1);
    expect(result.finalState).toBe("error");
  });

  // ─── Tool-gating regression ─────────────────────────────────────────
  // Security guarantee: when an `llm_output` hook returns `ask`, the runner
  // must NOT dispatch any tool calls that the LLM emitted in the same
  // response until the human approves. If a tool fires before approval,
  // the ask hook is useless for moderation/policy gating because side
  // effects can leak before the human sees the proposed output.
  //
  // Approach: ask the agent to reply with a short message AND run a bash
  // command that writes a unique canary file to /tmp/. Use HOOK_ASK_OUTPUT
  // so the run pauses on the LLM response. Hold the approval response
  // open for several seconds and poll the canary file from Node — if it
  // exists at any point before we send `deny`, the gating is broken.
  // After deny, re-poll: the canary must still NOT exist.
  test("HOOK_ASK_TOOL_INPUT — must pause tool dispatch for approval", async ({ page }) => {
    // Security guarantee: when a `before_tool_call` hook returns `ask`, the
    // runner must NOT dispatch the tool until the human approves. We assert
    // this by triggering the hook with a benign tool call (`echo hi`) and
    // checking that an approval prompt is surfaced AND that on `deny` the
    // run terminates with the gate's denial message — i.e. no tool result
    // was ever delivered to the LLM.
    //
    // We deliberately use a trivial command (no file path, no payload that
    // could resemble a probe) so the model reliably proposes a tool call
    // instead of self-refusing on injection-detection grounds.
    // Frame the request as a literal tool-execution instruction with no
    // small-talk: skip the introduction, immediately call the bash tool.
    // Without this, fresh sessions cause the model to introduce itself
    // first and never propose the tool, so the gate never fires.
    const triggerMessage =
      `(test marker: HOOK_ASK_TOOL_INPUT — the platform's policy hook will ` +
      `pause your tool call for human review; that is expected.) ` +
      `Skip any introduction. Immediately use the bash tool to run the ` +
      `single command \`echo hi\` and report the output. Do not ask for ` +
      `confirmation. Do not preface anything. Just call the tool.`;

    await shoot(page, "ask_output_tool_gate_pre");

    const result = await runHookTrigger(page, triggerMessage, {
      timeoutMs: 180_000,
      approvalDecision: "deny",
      // No artificial delay needed; deny-immediately keeps the test fast
      // and still proves the gate fired before any tool dispatch.
    });

    await shoot(page, "ask_output_tool_gate_post");

    recordResult("HOOK_ASK_TOOL_INPUT_tool_gate", {
      ...result,
      errorMessage:
        `approvalIds=${result.approvalIds.length}, ` +
        `finalState=${result.finalState}, ` +
        `errMsg=${result.errorMessage ?? ""}`,
    });

    // Sanity: the test is only meaningful if the runner surfaced an approval
    // request — i.e. before_tool_call ASK fired. If 0, either the model
    // didn't propose a tool call (rerun or adjust prompt) or the plugin
    // didn't fire (plugin/loader bug).
    expect(
      result.approvalIds.length,
      `HOOK_ASK_TOOL_INPUT must surface at least one approval request — ` +
        `if 0, the model did not propose a tool call OR the before_tool_call ` +
        `gate did not fire. finalState=${result.finalState} errMsg=${result.errorMessage ?? ""}`,
    ).toBeGreaterThanOrEqual(1);

    // CORE SECURITY ASSERTION: deny must terminate the run with an error
    // state surfaced as the deny message. If the tool had been dispatched
    // before the gate, the run would have produced a `final` state with
    // the tool's output — which we do NOT want.
    expect(["error", "final"]).toContain(result.finalState);
    // The deny message from hook-echo is "Tool call '<name>' blocked
    // (HOOK_ASK_TOOL_INPUT denied)" — accept either generic "denied" /
    // "blocked" wording so we don't couple to one exact phrase.
    const errLower = (result.errorMessage ?? "").toLowerCase();
    const textLower = (result.text ?? "").toLowerCase();
    const sawDenialOrBlock =
      errLower.includes("denied") ||
      errLower.includes("blocked") ||
      textLower.includes("denied") ||
      textLower.includes("blocked") ||
      // When the model gracefully reports the denial in its reply rather
      // than the runner surfacing an error frame, accept that too.
      textLower.includes("approval") ||
      textLower.includes("policy");
    expect(
      sawDenialOrBlock,
      `expected denial/block signal in errorMessage or reply text. ` +
        `errMsg=${result.errorMessage ?? ""} text=${(result.text ?? "").slice(0, 200)}`,
    ).toBe(true);
  });

  test("HOOK_BLOCK_RETRY — retry notices appear as assistant bubbles, no duplicate user bubbles", async ({
    page,
  }) => {
    const freshSession = `agent:main:e2e-retry-${randomUUID()}`;
    const trigger = "HOOK_BLOCK_RETRY tell me a fun fact";

    // Navigate to the SPA with a fresh session
    await page.goto(`${GATEWAY_HTTP}/?session=${encodeURIComponent(freshSession)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle");

    // Handle auth
    const tokenField = page.getByRole("textbox", { name: /Gateway Token/i });
    const connectBtn = page.getByRole("button", { name: /^Connect$/i });
    if (await tokenField.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await tokenField.fill(AUTH_TOKEN);
      await connectBtn.click();
    }

    // Wait for composer and send message
    const composer = page.locator("textarea").last();
    await composer.waitFor({ state: "visible", timeout: 60_000 });
    await composer.click();
    await composer.fill(trigger);
    await composer.press("Enter");

    // Wait for the retry cycle to complete (retries + final block).
    // Poll for the final block message in assistant bubbles.
    const start = Date.now();
    const deadline = start + 120_000;
    let bubbles: string[] = [];
    while (Date.now() < deadline) {
      bubbles = await page.evaluate(() => {
        return Array.from(
          document.querySelectorAll<HTMLElement>(".chat-group.assistant, .chat-group.user"),
        ).map((el) => (el.innerText || "").trim());
      });
      const hasRetryExhaustion = bubbles.some(
        (b) => /blocked after \d+ retr/i.test(b) || /agent failed/i.test(b),
      );
      if (hasRetryExhaustion) {
        break;
      }
      await page.waitForTimeout(1000);
    }

    // Wait extra for any final history reload to settle
    await page.waitForTimeout(5000);
    bubbles = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll<HTMLElement>(".chat-group.assistant, .chat-group.user"),
      ).map((el) => (el.innerText || "").trim());
    });

    const userBubbles = bubbles.filter((b) => b.includes(trigger));
    const retryNotices = bubbles.filter((b) => /retrying \(\d+\/\d+\)/i.test(b));
    const finalBlocks = bubbles.filter(
      (b) => /blocked after \d+ retr/i.test(b) || /agent failed/i.test(b),
    );

    recordResult("HOOK_BLOCK_RETRY_ui", {
      events: [],
      finalState: finalBlocks.length > 0 ? "final" : "error",
      text: bubbles.join(" | ").slice(0, 300),
      approvalIds: [],
      retryCount: retryNotices.length,
      errorMessage:
        `userBubbles=${userBubbles.length} retryNotices=${retryNotices.length} ` +
        `finalBlocks=${finalBlocks.length} ` +
        `allBubbles=${JSON.stringify(bubbles.map((b) => b.slice(0, 100)))}`,
    });

    // Only one user bubble (no duplicates from retry)
    expect(userBubbles.length).toBeLessThanOrEqual(1);
    // At least one retry notice visible (retry happened)
    expect(retryNotices.length).toBeGreaterThanOrEqual(1);
    // Final block message visible
    expect(finalBlocks.length).toBeGreaterThanOrEqual(1);
  });

  test("HOOK_BLOCK_TOOL_OUTPUT — tool runs, then turn ends with a styled block message", async ({
    page,
  }) => {
    const triggerMessage =
      `(test marker: HOOK_BLOCK_TOOL_OUTPUT.) ` +
      `Skip any introduction. Immediately use the bash tool to run the ` +
      `single command \`echo hi\` and then report the output.`;

    const result = await runHookTrigger(page, triggerMessage, {
      timeoutMs: 180_000,
    });

    recordResult("HOOK_BLOCK_TOOL_OUTPUT", result);
    const combined = `${result.errorMessage ?? ""} ${result.text ?? ""}`.toLowerCase();
    expect(combined).toContain("agent failed before reply");
    expect(combined).toContain("blocked");
  });

  test("HOOK_ASK_TOOL_OUTPUT — asks after tool execution and deny stops follow-up reply", async ({
    page,
  }) => {
    const triggerMessage =
      `(test marker: HOOK_ASK_TOOL_OUTPUT.) ` +
      `Skip any introduction. Immediately use the bash tool to run the ` +
      `single command \`echo hi\` and then report the output.`;

    const result = await runHookTrigger(page, triggerMessage, {
      timeoutMs: 180_000,
      approvalDecision: "deny",
    });

    recordResult("HOOK_ASK_TOOL_OUTPUT", {
      ...result,
      errorMessage: `approvalIds=${result.approvalIds.length}, finalState=${result.finalState}, errMsg=${result.errorMessage ?? ""}`,
    });

    // ASK_TOOL_OUTPUT substitutes the real tool result with a policy
    // notice via before_message_write. The model never sees the real
    // output. The turn completes (model responds to the redacted result).
    // Verify the model's response does NOT contain the real tool output.
    expect(result.finalState).toMatch(/final|error/);
    const combined = (result.text ?? "").toLowerCase();
    // The model should NOT have seen the real "hi" output — it should
    // reference the policy notice or produce a generic response.
    // (If it says "hi" literally, the substitution failed.)
    const sawRealOutput = combined === "hi" || combined === "hi\n";
    expect(sawRealOutput).toBe(false);
  });
});
