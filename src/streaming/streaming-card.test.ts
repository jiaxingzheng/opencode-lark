import { describe, it, expect, vi } from "vitest"
import {
  AnswerCardSession,
  ReasoningCardSession,
  ToolsCardSession,
} from "./streaming-card.js"
import type { CardKitClient, CardKitSchema } from "../feishu/cardkit-client.js"
import { CardKitError } from "../feishu/cardkit-client.js"
import { createMockFeishuClient, createMockLogger } from "../__tests__/setup.js"

function createMockCardKitClient(): CardKitClient & {
  createCard: ReturnType<typeof vi.fn>
  updateElement: ReturnType<typeof vi.fn>
  closeStreaming: ReturnType<typeof vi.fn>
} {
  return {
    createCard: vi.fn().mockResolvedValue("card_123"),
    updateElement: vi.fn().mockResolvedValue(undefined),
    closeStreaming: vi.fn().mockResolvedValue(undefined),
  } as any
}

function makeFeishuWithMessage() {
  const feishuClient = createMockFeishuClient()
  ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
    code: 0,
    msg: "ok",
    data: { message_id: "msg_456" },
  })
  return feishuClient
}

async function settle() {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

// ── 💬 AnswerCardSession ──────────────────────────────────────────────

describe("AnswerCardSession", () => {
  function create() {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = makeFeishuWithMessage()
    const session = new AnswerCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
    })
    return { session, cardkitClient, feishuClient }
  }

  it("isActive is false before start and after close", async () => {
    const { session } = create()
    expect(session.isActive).toBe(false)
    await session.start()
    expect(session.isActive).toBe(true)
    await session.close()
    expect(session.isActive).toBe(false)
  })

  it("start() creates a card with reply header", async () => {
    const { session, cardkitClient, feishuClient } = create()
    await session.start()
    expect(cardkitClient.createCard).toHaveBeenCalledOnce()
    const schema = cardkitClient.createCard.mock.calls[0]![0] as CardKitSchema
    expect(schema.schema).toBe("2.0")
    expect(schema.config.streaming_mode).toBe(true)
    expect(schema.config.summary.content).toBe("[Replying...]")
    expect(schema.body.elements[0]!.element_id).toBe("content")
    expect(schema.body.elements[0]!.content).toBe("💬 …")
    expect(feishuClient.sendMessage).toHaveBeenCalledWith("chat_789", {
      msg_type: "interactive",
      content: JSON.stringify({ type: "card", data: { card_id: "card_123" } }),
    })
  })

  it("start() is idempotent", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.start()
    expect(cardkitClient.createCard).toHaveBeenCalledOnce()
  })

  it("start() throws if no message_id returned", async () => {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {},
    })
    const session = new AnswerCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
    })
    await expect(session.start()).rejects.toThrow("sendMessage returned no message_id")
  })

  it("appendText starts lazily and accumulates text", async () => {
    const { session, cardkitClient } = create()
    await session.appendText("Hello ")
    await session.appendText("World")
    expect(cardkitClient.createCard).toHaveBeenCalledOnce()
    expect(session.getText()).toBe("Hello World")
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toBe("Hello World")
  })

  it("appendText no-op on empty chunk and when closed", async () => {
    const { session, cardkitClient } = create()
    await session.appendText("")
    expect(cardkitClient.createCard).not.toHaveBeenCalled()
    await session.start()
    await session.close()
    cardkitClient.updateElement.mockClear()
    await session.appendText("ignored")
    expect(cardkitClient.updateElement).not.toHaveBeenCalled()
  })

  it("setFinalText overrides the buffered text", async () => {
    const { session, cardkitClient } = create()
    await session.appendText("partial")
    await session.setFinalText("FINAL")
    expect(session.getText()).toBe("FINAL")
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toBe("FINAL")
  })

  it("close() flushes pending content and calls closeStreaming", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.appendText("Goodbye")
    await settle()
    expect(cardkitClient.updateElement).toHaveBeenCalledWith(
      "card_123",
      "content",
      "Goodbye",
      expect.any(Number),
    )
    await session.close()
    expect(cardkitClient.closeStreaming).toHaveBeenCalledWith(
      "card_123",
      "Done",
      expect.any(Number),
    )
  })

  it("close() flushes a final update when content changed since last send", async () => {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = makeFeishuWithMessage()
    const session = new AnswerCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
    })
    await session.start()
    // Manually push to queue without awaiting so close() awaits it
    void session.appendText("partial")
    await session.close()
    expect(cardkitClient.updateElement).toHaveBeenCalledWith(
      "card_123",
      "content",
      "partial",
      expect.any(Number),
    )
    expect(cardkitClient.closeStreaming).toHaveBeenCalledWith(
      "card_123",
      "Done",
      expect.any(Number),
    )
  })

  it("close() uses 'No reply' summary when text is empty", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.close()
    expect(cardkitClient.closeStreaming).toHaveBeenCalledWith(
      "card_123",
      "No reply",
      expect.any(Number),
    )
  })

  it("close() is idempotent", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.close()
    await session.close()
    expect(cardkitClient.closeStreaming).toHaveBeenCalledOnce()
  })
})

// ── 🧠 ReasoningCardSession ───────────────────────────────────────────

describe("ReasoningCardSession", () => {
  function create() {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = makeFeishuWithMessage()
    const session = new ReasoningCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
    })
    return { session, cardkitClient, feishuClient }
  }

  it("isActive is false before start and after close", async () => {
    const { session } = create()
    expect(session.isActive).toBe(false)
    await session.start()
    expect(session.isActive).toBe(true)
    await session.close()
    expect(session.isActive).toBe(false)
  })

  it("start() creates a card with reasoning header", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    const schema = cardkitClient.createCard.mock.calls[0]![0] as CardKitSchema
    expect(schema.config.summary.content).toBe("[Reasoning...]")
    expect(schema.body.elements[0]!.content).toBe("🧠 _thinking…_")
  })

  it("appendReasoning starts lazily and accumulates text", async () => {
    const { session, cardkitClient } = create()
    await session.appendReasoning("step 1 ")
    await session.appendReasoning("step 2")
    expect(cardkitClient.createCard).toHaveBeenCalledOnce()
    expect(session.getText()).toBe("step 1 step 2")
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toContain("🧠 **思考过程**")
    expect(lastUpdate).toContain("step 1 step 2")
  })

  it("appendReasoning no-op on empty chunk and when closed", async () => {
    const { session, cardkitClient } = create()
    await session.appendReasoning("")
    expect(cardkitClient.createCard).not.toHaveBeenCalled()
    await session.start()
    await session.close()
    cardkitClient.updateElement.mockClear()
    await session.appendReasoning("ignored")
    expect(cardkitClient.updateElement).not.toHaveBeenCalled()
  })

  it("trims to last maxReasoningChars when overflowing", async () => {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = makeFeishuWithMessage()
    const session = new ReasoningCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
      maxReasoningChars: 20,
    })
    await session.appendReasoning("0123456789")
    await session.appendReasoning("abcdefghij")
    expect(session.getText().length).toBeLessThanOrEqual(20)
    expect(session.getText()).toContain("abcdefghij")
  })

  it("close() with content uses 思考完毕 summary, with none uses same summary", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.appendReasoning("thinking")
    await session.close()
    expect(cardkitClient.closeStreaming).toHaveBeenCalledWith(
      "card_123",
      "思考完毕",
      expect.any(Number),
    )
  })

  it("close() is idempotent", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.close()
    await session.close()
    expect(cardkitClient.closeStreaming).toHaveBeenCalledOnce()
  })
})

// ── 🔧 ToolsCardSession ───────────────────────────────────────────────

describe("ToolsCardSession", () => {
  function create() {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = makeFeishuWithMessage()
    const session = new ToolsCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
    })
    return { session, cardkitClient, feishuClient }
  }

  it("isActive is false before start and after close", async () => {
    const { session } = create()
    expect(session.isActive).toBe(false)
    await session.start()
    expect(session.isActive).toBe(true)
    await session.close()
    expect(session.isActive).toBe(false)
  })

  it("start() creates a card with tools header", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    const schema = cardkitClient.createCard.mock.calls[0]![0] as CardKitSchema
    expect(schema.config.summary.content).toBe("[Tools...]")
    // Minimal initial body so a frozen (CardKit streaming-timeout) card
    // shows just the icon + header instead of a stale "preparing tools…"
    // placeholder.
    expect(schema.body.elements[0]!.content).toBe("🔧")
  })

  it("setToolStatus starts lazily and renders tool with state icon", async () => {
    const { session, cardkitClient } = create()
    await session.setToolStatus("read_file", "running")
    expect(cardkitClient.createCard).toHaveBeenCalledOnce()
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toContain("🔄 **read_file**")
  })

  it("setToolStatus no-op when closed", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.close()
    cardkitClient.updateElement.mockClear()
    await session.setToolStatus("bash", "running")
    expect(cardkitClient.updateElement).not.toHaveBeenCalled()
  })

  it("setToolStatus updates existing tool status (idempotent entry)", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("read_file", "running")
    await session.setToolStatus("read_file", "completed")
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toContain("✅ **read_file**")
    expect(lastUpdate).not.toContain("🔄 **read_file**")
    expect(session.getEntries()).toHaveLength(1)
  })

  it("renders title with tool status when title provided", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("read_file", "completed", "Read src/index.ts")
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toContain("✅ **read_file** · Read src/index.ts")
  })

  it("updates title retroactively on state transition", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("bash", "running")
    await session.setToolStatus("bash", "completed", "Run tests")
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toContain("✅ **bash** · Run tests")
    expect(lastUpdate).not.toContain("🔄 **bash**")
  })

  it("no title separator when title is undefined", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("bash", "running")
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toContain("🔄 **bash**")
  })

  it("setToolInput renders input under the tool entry", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("bash", "running")
    await session.setToolInput("bash", { command: "ls -la" })
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toContain("🔄 **bash**")
    expect(lastUpdate).toContain("› input:")
    expect(lastUpdate).toContain("ls -la")
  })

  it("setToolInput no-op on undefined input", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("bash", "running")
    await settle()
    cardkitClient.updateElement.mockClear()
    await session.setToolInput("bash", undefined)
    expect(cardkitClient.updateElement).not.toHaveBeenCalled()
  })

  it("setToolOutput replaces the full output as a code block", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("bash", "completed", "Run ls")
    await session.setToolOutput("bash", "file1\nfile2\nfile3")
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toContain("› output:")
    expect(lastUpdate).toContain("file1")
    expect(lastUpdate).toContain("file2")
    expect(lastUpdate).toContain("file3")
  })

  it("appendToolOutput appends incrementally instead of overwriting", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("bash", "running")
    await session.appendToolOutput("bash", "chunk1\n")
    await session.appendToolOutput("bash", "chunk2\n")
    await session.appendToolOutput("bash", "chunk3\n")
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toContain("chunk1")
    expect(lastUpdate).toContain("chunk2")
    expect(lastUpdate).toContain("chunk3")
  })

  it("appendToolOutput no-op on empty chunk", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("bash", "running")
    await settle()
    cardkitClient.updateElement.mockClear()
    await session.appendToolOutput("bash", "")
    expect(cardkitClient.updateElement).not.toHaveBeenCalled()
  })

  it("setToolError renders ❌ state with error message", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("bash", "running")
    await session.setToolError("bash", "permission denied")
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toContain("❌ **bash**")
    expect(lastUpdate).toContain("› error:")
    expect(lastUpdate).toContain("permission denied")
  })

  it("renders multiple tools in order", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("read_file", "running")
    await session.setToolStatus("bash", "completed", "Run tests")
    await session.setToolStatus("read_file", "completed", "Read config")
    await settle()
    const lastUpdate = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
    expect(lastUpdate).toContain("✅ **read_file** · Read config")
    expect(lastUpdate).toContain("✅ **bash** · Run tests")
    expect(session.getEntries()).toHaveLength(2)
  })

  it("close() with completed tools uses ✅ N summary", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("read_file", "completed")
    await session.setToolStatus("bash", "completed")
    await session.close()
    expect(cardkitClient.closeStreaming).toHaveBeenCalledWith(
      "card_123",
      "✅ 2",
      expect.any(Number),
    )
  })

  it("close() with mixed completed/errored uses both icons", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.setToolStatus("read_file", "completed")
    await session.setToolStatus("bash", "running")
    await session.setToolError("bash", "boom")
    await session.close()
    expect(cardkitClient.closeStreaming).toHaveBeenCalledWith(
      "card_123",
      "✅ 1 · ❌ 1",
      expect.any(Number),
    )
  })

  it("close() with no tools uses '无工具' summary", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.close()
    expect(cardkitClient.closeStreaming).toHaveBeenCalledWith(
      "card_123",
      "无工具",
      expect.any(Number),
    )
  })

  it("close() is idempotent", async () => {
    const { session, cardkitClient } = create()
    await session.start()
    await session.close()
    await session.close()
    expect(cardkitClient.closeStreaming).toHaveBeenCalledOnce()
  })
})

// ── shared BaseCardSession guarantees ─────────────────────────────────

describe("lazy start (no card if no events)", () => {
  it("answer card never creates a card if no text events", async () => {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = makeFeishuWithMessage()
    const session = new AnswerCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
    })
    await session.close()
    expect(cardkitClient.createCard).not.toHaveBeenCalled()
  })

  it("reasoning card never creates a card if no reasoning events", async () => {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = makeFeishuWithMessage()
    const session = new ReasoningCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
    })
    await session.close()
    expect(cardkitClient.createCard).not.toHaveBeenCalled()
  })

  it("tools card never creates a card if no tool events", async () => {
    const cardkitClient = createMockCardKitClient()
    const feishuClient = makeFeishuWithMessage()
    const session = new ToolsCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
    })
    await session.close()
    expect(cardkitClient.createCard).not.toHaveBeenCalled()
  })
})

// ── CardKit streaming timeout handling ───────────────────────────────

describe("BaseCardSession streaming-timeout handling", () => {
  function setupMockWithTimeout() {
    const cardkitClient = createMockCardKitClient()
    cardkitClient.updateElement = vi
      .fn()
      .mockRejectedValue(new CardKitError(230020, "card streaming timeout"))
    cardkitClient.closeStreaming = vi
      .fn()
      .mockRejectedValue(new CardKitError(230020, "card streaming timeout"))
    const feishuClient = makeFeishuWithMessage()
    return { cardkitClient, feishuClient }
  }

  it("enqueueUpdate swallows CardKit streaming-timeout and freezes the card", async () => {
    const { cardkitClient, feishuClient } = setupMockWithTimeout()
    const logger = createMockLogger()
    const session = new AnswerCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
      logger,
    })
    await session.appendText("hello")
    await settle()
    // First update should have been attempted (and failed with timeout).
    expect(cardkitClient.updateElement).toHaveBeenCalled()
    // Logger should have been notified exactly once.
    const freezeWarns = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("frozen by CardKit streaming timeout"),
    )
    expect(freezeWarns).toHaveLength(1)
  })

  it("subsequent appendText after freeze is a no-op (no extra updateElement calls)", async () => {
    const { cardkitClient, feishuClient } = setupMockWithTimeout()
    const session = new AnswerCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
    })
    await session.appendText("first")
    await settle()
    const callsAfterFreeze = (cardkitClient.updateElement as ReturnType<typeof vi.fn>).mock.calls.length
    await session.appendText("ignored-1")
    await session.appendText("ignored-2")
    await settle()
    expect(cardkitClient.updateElement).toHaveBeenCalledTimes(callsAfterFreeze)
  })

  it("close() skips final update and closeStreaming when card is frozen", async () => {
    const { cardkitClient, feishuClient } = setupMockWithTimeout()
    const session = new AnswerCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
    })
    await session.appendText("payload")
    await settle()
    // Card should be frozen by now; close() should not invoke closeStreaming
    // (it would also fail with the same timeout).
    await session.close()
    expect(cardkitClient.closeStreaming).not.toHaveBeenCalled()
  })

  it("non-timeout errors are rethrown out of enqueueUpdate", async () => {
    const cardkitClient = createMockCardKitClient()
    const otherError = new CardKitError(230001, "permission denied")
    cardkitClient.updateElement = vi.fn().mockRejectedValue(otherError)
    const feishuClient = makeFeishuWithMessage()
    const logger = createMockLogger()
    const session = new AnswerCardSession({
      cardkitClient: cardkitClient as any,
      feishuClient,
      chatId: "chat_789",
      logger,
    })
    // The first appendText triggers the failed updateElement — that error
    // must propagate out of the await chain.
    await expect(session.appendText("trigger")).rejects.toThrow("permission denied")
    // Logger should NOT have logged a freeze event for this non-timeout error.
    const freezeWarns = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("frozen by CardKit streaming timeout"),
    )
    expect(freezeWarns).toHaveLength(0)
  })
})
