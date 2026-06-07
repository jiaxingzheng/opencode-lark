/**
 * High-level streaming card session manager.
 * Wraps CardKitClient with throttling, tool status, sub-agent buttons,
 * and full lifecycle management.
 *
 * Card layout (single `content` element with markdown):
 *   <reasoning block, truncated>
 *   <assistant text, streaming>
 *   ---
 *   🔄/✅/❌ tool_name · title
 *      › input: { ... }
 *      › output: ...
 *   ---
 *   🔗 [subagent label](actionValue)
 */

import type { CardKitClient, CardKitSchema } from "../feishu/cardkit-client.js"
import type { FeishuApiClient } from "../feishu/api-client.js"

export interface StreamingCardOptions {
  cardkitClient: CardKitClient
  feishuClient: FeishuApiClient
  chatId: string
  /** Cap on text rendered inside the content element (default 80_000). */
  maxContentChars?: number
  /** Keep only the last N chars of the reasoning block (default 4000). */
  maxReasoningChars?: number
  /** Keep only the last N chars of a tool's output buffer (default 3500). */
  maxToolOutputChars?: number
  /** Keep only the last N chars of a single tool-output append (default 1800). */
  maxToolAppendChars?: number
}

interface CardState {
  cardId: string
  messageId: string
  sequence: number
  /** Assistant text streamed so far. Mutated by appendText. */
  currentText: string
  /** Reasoning/thinking content collected so far. Mutated by appendReasoning. */
  reasoningText: string
}

interface ToolDetail {
  name: string
  state: "running" | "completed" | "error"
  title?: string
  input?: Record<string, unknown>
  /** Buffered output (stdout/stderr-ish), appended incrementally. */
  output?: string
  error?: string
}

interface SubtaskButton {
  label: string
  actionValue: string
}

const REASONING_HEADER = "🧠 **思考过程**"
const ASSISTANT_HEADER = "💬 **回答**"

export class StreamingCardSession {
  private readonly cardkitClient: CardKitClient
  private readonly feishuClient: FeishuApiClient
  private readonly chatId: string
  private readonly maxContentChars: number
  private readonly maxReasoningChars: number
  private readonly maxToolOutputChars: number
  private readonly maxToolAppendChars: number

  private state: CardState | null = null
  private closed = false
  private queue: Promise<void> = Promise.resolve()
  private lastSentContent = ""

  private toolDetails: ToolDetail[] = []
  private subtaskButtons: SubtaskButton[] = []

  constructor(options: StreamingCardOptions) {
    this.cardkitClient = options.cardkitClient
    this.feishuClient = options.feishuClient
    this.chatId = options.chatId
    this.maxContentChars = options.maxContentChars ?? 80_000
    this.maxReasoningChars = options.maxReasoningChars ?? 4_000
    this.maxToolOutputChars = options.maxToolOutputChars ?? 3_500
    this.maxToolAppendChars = options.maxToolAppendChars ?? 1_800
  }

  get isActive(): boolean {
    return this.state !== null && !this.closed
  }

  async start(): Promise<void> {
    if (this.state) {
      return
    }

    const cardJson: CardKitSchema = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: {
          print_frequency_ms: { default: 200 },
          print_step: { default: 10 },
        },
      },
      body: {
        elements: [
          { tag: "markdown", content: "🛠️ Processing...", element_id: "content" },
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

    this.state = { cardId, messageId, sequence: 1, currentText: "", reasoningText: "" }
  }


  // ── Text streaming ───────────────────────────────────────────────

  /** Append a chunk of assistant text. No-op if card is closed/missing. */
  async appendText(chunk: string): Promise<void> {
    if (!this.state || this.closed) return
    if (!chunk) return
    this.state.currentText += chunk
    await this.enqueueUpdate(this.buildFullContent())
  }

  /** Append a chunk of reasoning/thinking content. No-op if card is closed/missing. */
  async appendReasoning(chunk: string): Promise<void> {
    if (!this.state || this.closed) return
    if (!chunk) return
    this.state.reasoningText += chunk
    // Keep reasoning bounded to the configured window
    if (this.state.reasoningText.length > this.maxReasoningChars) {
      this.state.reasoningText = this.state.reasoningText.slice(-this.maxReasoningChars)
    }
    await this.enqueueUpdate(this.buildFullContent())
  }

  // ── Tool I/O ─────────────────────────────────────────────────────

  /** Record/refresh the input of a tool. Idempotent for the same name. */
  async setToolInput(
    name: string,
    input: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!this.state || this.closed) return
    const detail = this.ensureToolDetail(name)
    if (input !== undefined) detail.input = input
    await this.enqueueUpdate(this.buildFullContent())
  }

  /** Record/refresh the running status of a tool (and optional title). */
  async setToolStatus(
    name: string,
    state: "running" | "completed" | "error",
    title?: string,
  ): Promise<void> {
    if (!this.state || this.closed) return
    const detail = this.ensureToolDetail(name)
    detail.state = state
    if (title !== undefined) detail.title = title
    await this.enqueueUpdate(this.buildFullContent())
  }

  /** Replace the full output of a tool. Prefer appendToolOutput for streaming. */
  async setToolOutput(name: string, output: string): Promise<void> {
    if (!this.state || this.closed) return
    const detail = this.ensureToolDetail(name)
    detail.output = output.slice(-this.maxToolOutputChars)
    await this.enqueueUpdate(this.buildFullContent())
  }

  /** Append a chunk of tool output. Preserves incremental stdout/stderr. */
  async appendToolOutput(name: string, chunk: string): Promise<void> {
    if (!this.state || this.closed) return
    if (!chunk) return
    const detail = this.ensureToolDetail(name)
    const next = (detail.output ?? "") + chunk
    detail.output = next.slice(-this.maxToolOutputChars)
    await this.enqueueUpdate(this.buildFullContent())
  }

  /** Record an error message on a tool (renders under its entry). */
  async setToolError(name: string, error: string): Promise<void> {
    if (!this.state || this.closed) return
    const detail = this.ensureToolDetail(name)
    detail.error = error
    detail.state = "error"
    await this.enqueueUpdate(this.buildFullContent())
  }

  // ── Sub-agent buttons ───────────────────────────────────────────

  async addSubtaskButton(label: string, actionValue: string): Promise<void> {
    if (!this.state || this.closed) return
    this.subtaskButtons.push({ label, actionValue })
    await this.enqueueUpdate(this.buildFullContent())
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async close(finalText?: string): Promise<void> {
    if (!this.state || this.closed) return
    this.closed = true
    await this.queue

    let text: string
    if (finalText !== undefined) {
      // Caller-provided final reply wins (e.g. fallback from sync response).
      text = finalText
    } else if (this.state.currentText.trim() || this.toolDetails.length > 0) {
      text = this.buildFullContent()
    } else {
      text = "✅ Done"
    }

    if (text && text !== this.lastSentContent) {
      this.state.sequence += 1
      await this.cardkitClient.updateElement(
        this.state.cardId,
        "content",
        text,
        this.state.sequence,
      )
    }

    const summary = this.buildSummary()
    this.state.sequence += 1
    await this.cardkitClient.closeStreaming(
      this.state.cardId,
      summary,
      this.state.sequence,
    )
  }

  // ── Internals ────────────────────────────────────────────────────

  private ensureToolDetail(name: string): ToolDetail {
    let detail = this.toolDetails.find((t) => t.name === name)
    if (!detail) {
      detail = { name, state: "running" }
      this.toolDetails.push(detail)
    }
    return detail
  }

  private async enqueueUpdate(content: string): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) return
      const bounded = content.length > this.maxContentChars
        ? content.slice(0, this.maxContentChars) + "\n\n…(内容过长，已截断)"
        : content
      this.state.sequence += 1
      await this.cardkitClient.updateElement(
        this.state.cardId,
        "content",
        bounded,
        this.state.sequence,
      )
      this.lastSentContent = bounded
    })
    await this.queue
  }

  private buildReasoningBlock(): string {
    if (!this.state?.reasoningText) return ""
    return `${REASONING_HEADER}\n\`\`\`\n${this.state.reasoningText}\n\`\`\``
  }

  private buildAssistantBlock(): string {
    const text = this.state?.currentText ?? ""
    if (!text) return ""
    return `${ASSISTANT_HEADER}\n${text}`
  }

  private buildToolsBlock(): string {
    if (this.toolDetails.length === 0) return ""
    const icons: Record<ToolDetail["state"], string> = {
      running: "🔄",
      completed: "✅",
      error: "❌",
    }
    const lines: string[] = []
    for (const t of this.toolDetails) {
      const head = t.title
        ? `${icons[t.state]} **${t.name}** · ${t.title}`
        : `${icons[t.state]} **${t.name}**`
      lines.push(head)
      if (t.input !== undefined) {
        lines.push(`  › input: \`${truncate(JSON.stringify(t.input), 400)}\``)
      }
      if (t.output) {
        const out = t.output.length > 1200 ? t.output.slice(-1200) : t.output
        lines.push("  › output:")
        lines.push("  ```")
        for (const ln of out.split("\n").slice(-40)) {
          lines.push(`  ${ln}`)
        }
        lines.push("  ```")
      }
      if (t.error) {
        lines.push(`  › error: \`${truncate(t.error, 400)}\``)
      }
    }
    return "\n\n---\n" + lines.join("\n")
  }

  private buildButtonsBlock(): string {
    if (this.subtaskButtons.length === 0) return ""
    const lines = this.subtaskButtons.map(
      (b) => `🔗 [${b.label}](${b.actionValue})`,
    )
    return "\n\n---\n" + lines.join("\n")
  }

  private buildFullContent(): string {
    if (!this.state) return ""
    const parts = [
      this.buildReasoningBlock(),
      this.buildAssistantBlock(),
      this.buildToolsBlock(),
      this.buildButtonsBlock(),
    ].filter((s) => s.length > 0)
    if (parts.length === 0) return "🛠️ Processing..."
    return parts.join("\n\n")
  }

  private buildSummary(): string {
    const completed = this.toolDetails.filter((t) => t.state === "completed").length
    const errored = this.toolDetails.filter((t) => t.state === "error").length
    if (completed + errored === 0) return "Done"
    const pieces: string[] = []
    if (completed > 0) pieces.push(`✅ ${completed} tool(s)`)
    if (errored > 0) pieces.push(`❌ ${errored} error(s)`)
    return pieces.join(" · ")
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}
