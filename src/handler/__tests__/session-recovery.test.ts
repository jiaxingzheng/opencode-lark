import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { isSessionBusy, abortSession } from "../message-handler.js"
import { createMockLogger } from "../../__tests__/setup.js"

const SERVER = "http://test:4096"

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response)
}

describe("isSessionBusy", () => {
  let logger = createMockLogger()
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()
    logger = createMockLogger()
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns false for empty message list", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    } as unknown as Response)
    const busy = await isSessionBusy(SERVER, "ses-1", logger)
    expect(busy).toBe(false)
  })

  it("returns false for non-array body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: "oops" }),
    } as unknown as Response)
    const busy = await isSessionBusy(SERVER, "ses-1", logger)
    expect(busy).toBe(false)
  })

  it("returns false when newest assistant is completed", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          info: {
            role: "user",
            time: { created: 1000 },
          },
        },
        {
          info: {
            role: "assistant",
            time: { created: 2000, completed: 3000 },
            finish: "stop",
          },
        },
      ],
    } as unknown as Response)
    const busy = await isSessionBusy(SERVER, "ses-1", logger)
    expect(busy).toBe(false)
  })

  it("returns false when newest message is a user message", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          info: {
            role: "assistant",
            time: { created: 1000, completed: 2000 },
            finish: "stop",
          },
        },
        { info: { role: "user", time: { created: 3000 } } },
      ],
    } as unknown as Response)
    const busy = await isSessionBusy(SERVER, "ses-1", logger)
    expect(busy).toBe(false)
  })

  it("returns true when newest assistant has no completed/finish (the hang case)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          info: {
            role: "user",
            time: { created: 1000 },
          },
        },
        {
          info: {
            role: "assistant",
            time: { created: 2000 },
            // no completed, no finish — model hung
          },
        },
      ],
    } as unknown as Response)
    const busy = await isSessionBusy(SERVER, "ses-1", logger)
    expect(busy).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("in-flight assistant"),
    )
  })

  it("returns true when assistant has time.start but no completed and finish is empty", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          info: {
            role: "assistant",
            time: { created: 2000 },
            finish: "",
          },
        },
      ],
    } as unknown as Response)
    const busy = await isSessionBusy(SERVER, "ses-1", logger)
    expect(busy).toBe(true)
  })

  it("returns false on HTTP 404 and logs warn", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as unknown as Response)
    const busy = await isSessionBusy(SERVER, "ses-1", logger)
    expect(busy).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 404"),
    )
  })

  it("returns false on HTTP 500 and logs warn", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response)
    const busy = await isSessionBusy(SERVER, "ses-1", logger)
    expect(busy).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 500"),
    )
  })

  it("returns false on network error and logs warn", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))
    const busy = await isSessionBusy(SERVER, "ses-1", logger)
    expect(busy).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("probe failed"),
    )
  })

  it("only inspects the newest assistant (ignores older in-flight)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        // oldest: an in-flight assistant that was never resumed (orphaned)
        { info: { role: "assistant", time: { created: 1000 } } },
        // newer: a completed assistant
        { info: { role: "assistant", time: { created: 2000, completed: 2500 }, finish: "stop" } },
      ],
    } as unknown as Response)
    const busy = await isSessionBusy(SERVER, "ses-1", logger)
    expect(busy).toBe(false)
  })
})

describe("abortSession", () => {
  let logger = createMockLogger()
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()
    logger = createMockLogger()
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("POSTs to /session/{id}/abort and returns true on 200", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "true" } as unknown as Response)
    const ok = await abortSession(SERVER, "ses-1", logger)
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `${SERVER}/session/ses-1/abort`,
      expect.objectContaining({ method: "POST" }),
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("aborted session ses-1"),
    )
  })

  it("returns false on HTTP error and logs warn", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "" } as unknown as Response)
    const ok = await abortSession(SERVER, "ses-1", logger)
    expect(ok).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 500"),
    )
  })

  it("returns false on network error and logs warn", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"))
    const ok = await abortSession(SERVER, "ses-1", logger)
    expect(ok).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("request failed"),
    )
  })
})
