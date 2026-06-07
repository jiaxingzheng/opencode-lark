/**
 * Three independent streaming cards, one per information channel:
 *
 *   🧠 ReasoningCard   — model's thinking/reasoning (lazy)
 *   🔧 ToolsCard       — tool calls, their inputs, and accumulated output (lazy)
 *   💬 AnswerCard      — the actual assistant reply text (lazy)
 *
 * All three share the same lifecycle plumbing (CardKit create → sequence-
 * numbered updateElement → closeStreaming) via BaseCardSession. They differ
 * only in how their `content` element is built and what summary line they
 * pass to closeStreaming.
 *
 * The Feishu chat gets up to three separate messages. Each is started
 * lazily on its first event, so a short reply with no reasoning and no
 * tools results in just a plain `replyMessage` text card at the end —
 * no card overhead.
 */

import type { CardKitClient, CardKitSchema } from "../feishu/cardkit-client.js"
import { CardKitError } from "../feishu/cardkit-client.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"

// ── Shared base ──────────────────────────────────────────────────────

export interface BaseCardOptions {
  cardkitClient: CardKitClient
  feishuClient: FeishuApiClient
  chatId: string
  /** Cap on the rendered content body (default 80_000). */
  maxContentChars?: number
  /** Optional logger; used to report streaming-timeout freeze events. */
  logger?: Logger
}

/**
 * Heuristic: CardKit returns errors like "card streaming timeout" once the
 * card has been left in streaming mode past the server-side limit (~30s).
 * After that point the card is frozen on the server side — any further
 * updateElement / closeStreaming calls return the same error. We detect
 * these errors and stop retrying so we don't spam the log.
 */
function isStreamingTimeoutError(err: unknown): boolean {
  if (err instanceof CardKitError) {
    return /streaming\s+timeout|card\s+stream|streaming_mode|streaming\s+closed|stream\s+closed/i.test(
      err.message,
    )
  }
  if (err instanceof Error) {
    return /streaming\s+timeout|card\s+stream|streaming_mode|streaming\s+closed|stream\s+closed/i.test(
      err.message,
    )
  }
  return false
}

interface CardState {
  cardId: string
  messageId: string
  sequence: number
  /** Last content sent to the card (so we can skip no-op updates). */
  lastSentContent: string
}

export abstract class BaseCardSession {
  protected readonly cardkitClient: CardKitClient
  protected readonly feishuClient: FeishuApiClient
  protected readonly chatId: string
  protected readonly maxContentChars: number
  protected readonly logger: Logger | undefined

  protected state: CardState | null = null
  protected closed = false
  /**
   * Set when the server has frozen the card due to a CardKit streaming
   * timeout. After this point updateElement / closeStreaming calls are
   * no-ops so we stop the warning-spam and leave the card at its last
   * rendered state.
   */
  protected frozen = false
  protected queue: Promise<void> = Promise.resolve()

  protected constructor(options: BaseCardOptions) {
    this.cardkitClient = options.cardkitClient
    this.feishuClient = options.feishuClient
    this.chatId = options.chatId
    this.maxContentChars = options.maxContentChars ?? 80_000
    this.logger = options.logger
  }

  get isActive(): boolean {
    return this.state !== null && !this.closed
  }

  /** Build the initial card body shown right after creation. */
  protected abstract initialContent(): string

  /** Build the content for an arbitrary update tick (e.g. with new text). */
  protected abstract currentContent(): string

  /** Summary line passed to closeStreaming. */
  protected abstract closeSummary(): string

  /** Card header summary text used in `config.summary.content`. */
  protected abstract initialSummary(): string

  async start(): Promise<void> {
    if (this.state) return

    const cardJson: CardKitSchema = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: this.initialSummary() },
        streaming_config: {
          print_frequency_ms: { default: 200 },
          print_step: { default: 10 },
        },
      },
      body: {
        elements: [
          { tag: "markdown", content: this.initialContent(), element_id: "content" },
        ],
      },
    }

    const cardId = await this.cardkitClient.createCard(cardJson)

    const result = await this.feishuClient.sendMessage(this.chatId, {
      msg_type: "interactive",
      content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
    })

    const messageId = result.data?.["message_id"] as string | undefined
    if (!messageId) {
      throw new Error("sendMessage returned no message_id")
    }

    this.state = { cardId, messageId, sequence: 1, lastSentContent: "" }
  }

  /** Push the current content to the card, throttled by the shared queue. */
  protected async enqueueUpdate(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed || this.frozen) return
      const raw = this.currentContent()
      const content = raw.length > this.maxContentChars
        ? raw.slice(0, this.maxContentChars) + "\n\n…(内容过长，已截断)"
        : raw
      if (content === this.state.lastSentContent) return
      this.state.sequence += 1
      try {
        await this.cardkitClient.updateElement(
          this.state.cardId,
          "content",
          content,
          this.state.sequence,
        )
        this.state.lastSentContent = content
      } catch (err) {
        if (isStreamingTimeoutError(err)) {
          this.freezeFromTimeout("updateElement")
          return
        }
        throw err
      }
    })
    await this.queue
  }

  async close(): Promise<void> {
    if (!this.state || this.closed) return
    this.closed = true
    await this.queue

    // If the server already froze the card, every further write will fail
    // with the same timeout. Skip the final update and close entirely —
    // the card will stay at its last successfully-rendered state.
    if (this.frozen) {
      this.logger?.info(
        `card ${this.state.cardId} skipped close (already frozen by CardKit streaming timeout)`,
      )
      return
    }

    // Make sure the latest content is on the wire before we close.
    const raw = this.currentContent()
    const content = raw.length > this.maxContentChars
      ? raw.slice(0, this.maxContentChars) + "\n\n…(内容过长，已截断)"
      : raw
    if (content && content !== this.state.lastSentContent) {
      this.state.sequence += 1
      try {
        await this.cardkitClient.updateElement(
          this.state.cardId,
          "content",
          content,
          this.state.sequence,
        )
        this.state.lastSentContent = content
      } catch (err) {
        if (isStreamingTimeoutError(err)) {
          this.freezeFromTimeout("updateElement")
          return
        }
        throw err
      }
    }

    this.state.sequence += 1
    try {
      await this.cardkitClient.closeStreaming(
        this.state.cardId,
        this.closeSummary(),
        this.state.sequence,
      )
    } catch (err) {
      if (isStreamingTimeoutError(err)) {
        this.freezeFromTimeout("closeStreaming")
        return
      }
      throw err
    }
  }

  /**
   * Mark the card as frozen so subsequent updateElement / closeStreaming
   * calls become no-ops, and log the event once. The card stays in the
   * chat at its last successfully-rendered content.
   */
  private freezeFromTimeout(op: string): void {
    if (this.frozen) return
    this.frozen = true
    this.closed = true
    this.logger?.warn(
      `card ${this.state?.cardId ?? "?"} frozen by CardKit streaming timeout during ${op}; further updates skipped`,
    )
  }
}

// ── 💬 Answer card (main reply) ──────────────────────────────────────

export interface AnswerCardOptions extends BaseCardOptions {
  /** Max chars of accumulated text retained in state (default unlimited;
   *  CardKit update cap handled via maxContentChars). */
  maxTextChars?: number
}

export class AnswerCardSession extends BaseCardSession {
  private text = ""
  private readonly maxTextChars: number

  constructor(options: AnswerCardOptions) {
    super(options)
    this.maxTextChars = options.maxTextChars ?? Number.MAX_SAFE_INTEGER
  }

  /** Append a chunk of assistant text. Lazy-starts the card on first call. */
  async appendText(chunk: string): Promise<void> {
    if (this.closed) return
    if (!chunk) return
    if (!this.state) await this.start()
    if (this.closed || !this.state) return
    this.text += chunk
    if (this.text.length > this.maxTextChars) {
      this.text = this.text.slice(-this.maxTextChars)
    }
    await this.enqueueUpdate()
  }

  /** Expose the collected text (used by the bridge for the final fallback reply). */
  getText(): string {
    return this.text
  }

  /** Force a final-text override (e.g. sync fallback reply). */
  async setFinalText(text: string): Promise<void> {
    if (this.closed) return
    if (!this.state) await this.start()
    if (this.closed || !this.state) return
    this.text = text
    await this.enqueueUpdate()
  }

  protected initialContent(): string {
    return "💬 …"
  }

  protected currentContent(): string {
    return this.text || "💬 …"
  }

  protected closeSummary(): string {
    return this.text.trim() ? "Done" : "No reply"
  }

  protected initialSummary(): string {
    return "[Replying...]"
  }
}

// ── 🧠 Reasoning card ────────────────────────────────────────────────

export interface ReasoningCardOptions extends BaseCardOptions {
  /** Keep only the last N chars of reasoning (default 4000). */
  maxReasoningChars?: number
}

export class ReasoningCardSession extends BaseCardSession {
  private reasoning = ""
  private readonly maxReasoningChars: number

  constructor(options: ReasoningCardOptions) {
    super(options)
    this.maxReasoningChars = options.maxReasoningChars ?? 4_000
  }

  /** Append a reasoning chunk. Lazy-starts the card on first call. */
  async appendReasoning(chunk: string): Promise<void> {
    if (this.closed) return
    if (!chunk) return
    if (!this.state) await this.start()
    if (this.closed || !this.state) return
    this.reasoning += chunk
    if (this.reasoning.length > this.maxReasoningChars) {
      this.reasoning = this.reasoning.slice(-this.maxReasoningChars)
    }
    await this.enqueueUpdate()
  }

  getText(): string {
    return this.reasoning
  }

  protected initialContent(): string {
    return "🧠 _thinking…_"
  }

  protected currentContent(): string {
    if (!this.reasoning) return "🧠 _thinking…_"
    return `🧠 **思考过程**\n\`\`\`\n${this.reasoning}\n\`\`\``
  }

  protected closeSummary(): string {
    return "思考完毕"
  }

  protected initialSummary(): string {
    return "[Reasoning...]"
  }
}

// ── 🔧 Tools card ────────────────────────────────────────────────────

export type ToolState = "running" | "completed" | "error"

export interface ToolEntry {
  name: string
  state: ToolState
  title?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
}

export interface ToolsCardOptions extends BaseCardOptions {
  /** Cap on a tool's full output buffer (default 3500 chars). */
  maxToolOutputChars?: number
  /** Cap on output lines per tool when rendering (default 40). */
  maxToolOutputLines?: number
  /** Cap on output chars per tool when rendering (default 1200 chars). */
  maxToolRenderChars?: number
}

export class ToolsCardSession extends BaseCardSession {
  private readonly tools: ToolEntry[] = []
  private readonly maxToolOutputChars: number
  private readonly maxToolOutputLines: number
  private readonly maxToolRenderChars: number

  constructor(options: ToolsCardOptions) {
    super(options)
    this.maxToolOutputChars = options.maxToolOutputChars ?? 3_500
    this.maxToolOutputLines = options.maxToolOutputLines ?? 40
    this.maxToolRenderChars = options.maxToolRenderChars ?? 1_200
  }

  /** Record/refresh a tool's status (and optional title). */
  async setToolStatus(
    name: string,
    state: ToolState,
    title?: string,
  ): Promise<void> {
    if (this.closed) return
    const entry = this.ensureEntry(name)
    entry.state = state
    if (title !== undefined) entry.title = title
    if (!this.state) await this.start()
    if (this.closed || !this.state) return
    await this.enqueueUpdate()
  }

  /** Record/refresh a tool's input. */
  async setToolInput(
    name: string,
    input: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (this.closed) return
    if (input === undefined) return
    const entry = this.ensureEntry(name)
    entry.input = input
    if (!this.state) await this.start()
    if (this.closed || !this.state) return
    await this.enqueueUpdate()
  }

  /** Replace the full output of a tool. */
  async setToolOutput(name: string, output: string): Promise<void> {
    if (this.closed) return
    const entry = this.ensureEntry(name)
    entry.output = output.slice(-this.maxToolOutputChars)
    if (!this.state) await this.start()
    if (this.closed || !this.state) return
    await this.enqueueUpdate()
  }

  /** Append a chunk of tool output (preserves incremental stdout/stderr). */
  async appendToolOutput(name: string, chunk: string): Promise<void> {
    if (this.closed) return
    if (!chunk) return
    const entry = this.ensureEntry(name)
    const next = (entry.output ?? "") + chunk
    entry.output = next.slice(-this.maxToolOutputChars)
    if (!this.state) await this.start()
    if (this.closed || !this.state) return
    await this.enqueueUpdate()
  }

  /** Record an error on a tool (and flip its state to error). */
  async setToolError(name: string, error: string): Promise<void> {
    if (this.closed) return
    const entry = this.ensureEntry(name)
    entry.error = error
    entry.state = "error"
    if (!this.state) await this.start()
    if (this.closed || !this.state) return
    await this.enqueueUpdate()
  }

  getEntries(): readonly ToolEntry[] {
    return this.tools
  }

  private ensureEntry(name: string): ToolEntry {
    let entry = this.tools.find((t) => t.name === name)
    if (!entry) {
      entry = { name, state: "running" }
      this.tools.push(entry)
    }
    return entry
  }

  protected initialContent(): string {
    return "🔧"
  }

  protected currentContent(): string {
    if (this.tools.length === 0) return "🔧 _准备调用工具…_"
    const icons: Record<ToolState, string> = {
      running: "🔄",
      completed: "✅",
      error: "❌",
    }
    const lines: string[] = ["🔧 **工具调用**"]
    for (const t of this.tools) {
      const head = t.title
        ? `${icons[t.state]} **${t.name}** · ${t.title}`
        : `${icons[t.state]} **${t.name}**`
      lines.push("")
      lines.push(head)
      if (t.input !== undefined) {
        lines.push(`  › input: \`${truncate(JSON.stringify(t.input), 400)}\``)
      }
      if (t.output) {
        const out = t.output.length > this.maxToolRenderChars
          ? t.output.slice(-this.maxToolRenderChars)
          : t.output
        const outLines = out.split("\n")
        const tail = outLines.slice(-this.maxToolOutputLines)
        lines.push("  › output:")
        lines.push("  ```")
        for (const ln of tail) lines.push(`  ${ln}`)
        lines.push("  ```")
      }
      if (t.error) {
        lines.push(`  › error: \`${truncate(t.error, 400)}\``)
      }
    }
    return lines.join("\n")
  }

  protected closeSummary(): string {
    const completed = this.tools.filter((t) => t.state === "completed").length
    const errored = this.tools.filter((t) => t.state === "error").length
    if (completed + errored === 0) return "无工具"
    const pieces: string[] = []
    if (completed > 0) pieces.push(`✅ ${completed}`)
    if (errored > 0) pieces.push(`❌ ${errored}`)
    return pieces.join(" · ")
  }

  protected initialSummary(): string {
    return "[Tools...]"
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}
