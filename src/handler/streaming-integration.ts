
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { SubAgentTracker } from "../streaming/subagent-tracker.js"
import type { Logger } from "../utils/logger.js"
import type { EventProcessor } from "../streaming/event-processor.js"
import type { QuestionAsked, PermissionRequested } from "../streaming/event-processor.js"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { addListener, removeListener } from "../utils/event-listeners.js"
import type { OutboundMediaHandler } from "./outbound-media.js"
import type { ExpiringSet } from "../utils/expiring-set.js"
import type { InteractiveCardRegistry } from "../feishu/interactive-card-registry.js"
import {
  extractFeishuMessageId,
  interactiveCardKey,
} from "../feishu/interactive-card-registry.js"

// ── Types ──

export interface StreamingBridgeDeps {
  feishuClient: FeishuApiClient
  subAgentTracker: SubAgentTracker
  logger: Logger
  seenInteractiveIds: ExpiringSet<string>
  interactiveCardRegistry?: InteractiveCardRegistry
  outboundMedia?: OutboundMediaHandler
}

export interface StreamingBridge {
  handleMessage(
    chatId: string,
    sessionId: string,
    eventListeners: EventListenerMap,
    eventProcessor: EventProcessor,
    sendMessage: () => Promise<string>,
    onComplete: (text: string) => void,
    messageId: string,
    reactionId: string | null,
  ): Promise<void>
}

// ── Constants ──

const FIRST_EVENT_TIMEOUT_MS = 90 * 1_000

// ── Tool emoji mapping ──

const TOOL_EMOJI: Record<string, string> = {
  read_file: "📖",
  write_file: "✏️",
  edit_file: "✏️",
  list_files: "📂",
  search: "🔍",
  grep: "🔍",
  glob: "🔍",
  bash: "💻",
  execute: "💻",
  question: "❓",
  permission: "🔐",
  browser: "🌐",
  web_fetch: "🌐",
  web_search: "🔎",
  image: "🖼️",
  todo: "📝",
}

function getToolEmoji(toolName: string): string {
  return TOOL_EMOJI[toolName] ?? "🔧"
}

function extractToolPreview(toolName: string, input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined
  switch (toolName) {
    case "bash":
      return typeof input.command === "string" ? input.command : undefined
    case "file_edit":
    case "file_write":
      return typeof input.filePath === "string" ? input.filePath : undefined
    case "file_read":
      return typeof input.filePath === "string" ? input.filePath : undefined
    case "glob":
    case "glob_search":
      return typeof input.pattern === "string" ? input.pattern : undefined
    case "grep":
    case "grep_search":
      return typeof input.pattern === "string" ? input.pattern : undefined
    case "web_fetch":
      return typeof input.url === "string" ? input.url : undefined
    case "websearch":
      return typeof input.query === "string" ? input.query : undefined
    default: {
      const values = Object.values(input).filter((v) => typeof v === "string") as string[]
      return values.length > 0 ? values[0] : undefined
    }
  }
}

// ── Factory ──

export function createStreamingBridge(
  deps: StreamingBridgeDeps,
): StreamingBridge {
  const { feishuClient, logger, seenInteractiveIds } = deps

  return {
    async handleMessage(
      chatId: string,
      sessionId: string,
      eventListeners: EventListenerMap,
      eventProcessor: EventProcessor,
      sendMessage: () => Promise<string>,
      onComplete: (text: string) => void,
      messageId: string,
      reactionId: string | null,
    ): Promise<void> {
      // ── State ──
      let textBuffer = ""
      let gotFirstEvent = false
      let settled = false
      let syncResponseBody = ""
      const reportedTools = new Set<string>()
      let completeResolve: (() => void) | null = null
      const completePromise = new Promise<void>((resolve) => {
        completeResolve = resolve
      })

      // ── Helpers ──

      const removeReaction = async (): Promise<void> => {
        if (!reactionId) return
        try {
          await feishuClient.deleteReaction(messageId, reactionId)
        } catch (err) {
          logger.warn(`deleteReaction failed: ${err}`)
        }
      }

      const sendFinalResponse = async (text: string): Promise<void> => {
        const card = buildFinalResponseCard(text)
        await feishuClient.replyMessage(messageId, {
          msg_type: "interactive",
          content: JSON.stringify(card),
        })
        await removeReaction()
      }

      const sendToolProgress = async (
        toolName: string,
        state: string,
        title?: string,
        input?: Record<string, unknown>,
      ): Promise<void> => {
        const emoji = getToolEmoji(toolName)
        const preview = extractToolPreview(toolName, input)
        const label = preview || title || toolName
        const prefix =
          state === "completed"
            ? `${emoji} ✅`
            : state === "error"
              ? `${emoji} ❌`
              : emoji
        const msg = `${prefix} ${label}`

        // Only send first notification with meaningful content (skip pending with no input)
        if (reportedTools.has(toolName)) return
        if (!preview && state === "pending") return
        reportedTools.add(toolName)

        try {
          await feishuClient.sendMessage(chatId, {
            msg_type: "text",
            content: JSON.stringify({ text: msg }),
          })
        } catch (err) {
          logger.warn(`sendToolProgress failed: ${err}`)
        }
      }

      // ── Event listener ──

      const myListener = (rawEvent: unknown): void => {
        const action = eventProcessor.processEvent(rawEvent)
        if (!action) return
        if (action.sessionId !== sessionId) return

        gotFirstEvent = true

        switch (action.type) {
          case "TextDelta": {
            textBuffer += action.text
            if (textBuffer.length > 102_400) {
              textBuffer = textBuffer.slice(0, 102_400) + "\n\n…(内容过长，已截断)"
            }
            break
          }

          case "ReasoningDelta": {
            // Intentionally ignored — hermes-style: no thinking display
            break
          }

          case "ToolStateChange": {
            logger.info(`ToolStateChange: ${action.toolName} state=${action.state} input=${JSON.stringify(action.input)}`)
            sendToolProgress(
              action.toolName,
              action.state as string,
              action.title,
              action.input,
            ).catch((err) => logger.warn(`sendToolProgress failed: ${err}`))
            break
          }

          case "SubtaskDiscovered": {
            deps.subAgentTracker
              .onSubtaskDiscovered(action)
              .then((tracked) => {
                const childSessionId = tracked.childSessionId ?? action.sessionId
                const cardData = buildSubAgentNotificationCard(
                  action.description,
                  action.agent ?? "sub-agent",
                  childSessionId,
                )
                return feishuClient.sendMessage(chatId, {
                  msg_type: "interactive",
                  content: JSON.stringify(cardData),
                })
              })
              .catch((err) => {
                logger.warn(`SubtaskDiscovered handling failed: ${err}`)
              })
            break
          }

          case "QuestionAsked": {
            const cardKey = interactiveCardKey("question", action.requestId)
            if (seenInteractiveIds.has(cardKey)) break
            if (
              deps.interactiveCardRegistry &&
              !deps.interactiveCardRegistry.beginDispatch(
                "question",
                action.requestId,
              )
            ) {
              break
            }
            logger.info(
              `Question event received in bridge for session ${sessionId}, requestId=${action.requestId}`,
            )
            const questionCard = buildQuestionCard(action)
            feishuClient
              .sendMessage(chatId, {
                msg_type: "interactive",
                content: JSON.stringify(questionCard),
              })
              .then((response) => {
                const mid = extractFeishuMessageId(response)
                if (!mid) {
                  deps.interactiveCardRegistry?.failDispatch(
                    "question",
                    action.requestId,
                  )
                  return
                }
                seenInteractiveIds.add(cardKey)
                deps.interactiveCardRegistry?.track({
                  requestId: action.requestId,
                  kind: "question",
                  chatId,
                  messageId: mid,
                })
              })
              .catch((err) => {
                deps.interactiveCardRegistry?.failDispatch(
                  "question",
                  action.requestId,
                )
                logger.warn(`Question card send failed: ${err}`)
              })
            break
          }

          case "PermissionRequested": {
            const cardKey = interactiveCardKey("permission", action.requestId)
            if (seenInteractiveIds.has(cardKey)) break
            if (
              deps.interactiveCardRegistry &&
              !deps.interactiveCardRegistry.beginDispatch(
                "permission",
                action.requestId,
              )
            ) {
              break
            }
            logger.info(
              `Permission event received in bridge for session ${sessionId}, requestId=${action.requestId}`,
            )
            const permissionCard = buildPermissionCard(action)
            feishuClient
              .sendMessage(chatId, {
                msg_type: "interactive",
                content: JSON.stringify(permissionCard),
              })
              .then((response) => {
                const mid = extractFeishuMessageId(response)
                if (!mid) {
                  deps.interactiveCardRegistry?.failDispatch(
                    "permission",
                    action.requestId,
                  )
                  return
                }
                seenInteractiveIds.add(cardKey)
                deps.interactiveCardRegistry?.track({
                  requestId: action.requestId,
                  kind: "permission",
                  chatId,
                  messageId: mid,
                })
              })
              .catch((err) => {
                deps.interactiveCardRegistry?.failDispatch(
                  "permission",
                  action.requestId,
                )
                logger.warn(`Permission card send failed: ${err}`)
              })
            break
          }

          case "SessionIdle": {
            if (settled) return
            settled = true
            clearTimeout(firstEventTimer)
            removeListener(eventListeners, sessionId, myListener)

            const responseText = textBuffer.trim() || "（无回复）"
            logger.info(
              `Session ${sessionId} idle — sending final response (${responseText.length} chars)`,
            )

            void (async () => {
              try {
                await sendFinalResponse(responseText)
              } catch (err) {
                logger.warn(`sendFinalResponse failed: ${err}`)
              }
              if (deps.outboundMedia) {
                try {
                  await deps.outboundMedia.sendDetectedFiles(chatId, responseText)
                } catch (err) {
                  logger.warn(`outboundMedia.sendDetectedFiles failed: ${err}`)
                }
              }
              onComplete(responseText)
              completeResolve?.()
            })()
            break
          }

          default:
            break
        }
      }

      // ── Timeout: no SSE events within FIRST_EVENT_TIMEOUT_MS ──

      const firstEventTimer = setTimeout(() => {
        if (gotFirstEvent || settled) return
        settled = true
        removeListener(eventListeners, sessionId, myListener)
        logger.warn(
          `No SSE events received within ${FIRST_EVENT_TIMEOUT_MS}ms for ${sessionId}, falling back to sync response`,
        )
        const fallbackText = parseSyncResponse(syncResponseBody, logger)
        void (async () => {
          try {
            await sendFinalResponse(fallbackText)
          } catch (err) {
            logger.warn(`sendFinalResponse in timeout fallback failed: ${err}`)
          }
          if (deps.outboundMedia) {
            try {
              await deps.outboundMedia.sendDetectedFiles(chatId, fallbackText)
            } catch (mediaErr) {
              logger.warn(
                `outboundMedia.sendDetectedFiles in timeout fallback failed: ${mediaErr}`,
              )
            }
          }
          onComplete(fallbackText)
          completeResolve?.()
        })()
      }, FIRST_EVENT_TIMEOUT_MS)

      // ── Register listener BEFORE POST to avoid race ──

      addListener(eventListeners, sessionId, myListener)

      sendMessage()
        .then((responseBody) => {
          syncResponseBody = responseBody
          logger.info(
            `POST completed for session ${sessionId} (${responseBody.length} bytes)`,
          )
        })
        .catch((err) => {
          if (settled) return
          if (gotFirstEvent) {
            logger.info(
              `POST timed out for session ${sessionId} but SSE events are flowing — keeping listener active`,
            )
            return
          }
          settled = true
          clearTimeout(firstEventTimer)
          removeListener(eventListeners, sessionId, myListener)
          logger.warn(`sendMessage failed for ${sessionId}: ${err}`)
        })

      await completePromise
    },
  }
}

// ── Helpers ──

function parseSyncResponse(rawText: string, logger: Logger): string {
  if (!rawText.trim()) return "（无回复）"
  try {
    const data = JSON.parse(rawText) as {
      parts?: Array<{ type: string; text?: string }>
    }
    return (
      data.parts
        ?.filter((p) => p.type === "text" && p.text)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim() || "（无回复）"
    )
  } catch (e) {
    logger.warn(`Failed to parse sync response: ${e}`)
    return rawText.trim() || "（无回复）"
  }
}

export function buildFinalResponseCard(text: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: "markdown",
        content: text,
      },
    ],
  }
}

function buildSubAgentNotificationCard(
  description: string,
  agent: string,
  childSessionId: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `🤖 ${agent}` },
      template: "indigo",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: description },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔍 View Details" },
            type: "primary",
            value: { action: "view_subagent", childSessionId },
          },
        ],
      },
    ],
  }
}

export function buildQuestionCard(
  action: QuestionAsked,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []

  for (let qi = 0; qi < action.questions.length; qi++) {
    const question = action.questions[qi]!
    if (qi > 0) {
      elements.push({ tag: "hr" })
    }
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: question.question },
    })
    elements.push({
      tag: "action",
      actions: question.options.map((opt, idx) => ({
        tag: "button",
        text: { tag: "plain_text", content: opt.label },
        type: idx === 0 ? "primary" : "default",
        value: {
          action: "question_answer",
          requestId: action.requestId,
          answers: JSON.stringify([[opt.label]]),
        },
      })),
    })
  }

  const header = action.questions[0]?.header ?? "Question"

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `❓ ${header}` },
      template: "orange",
    },
    elements,
  }
}

export function buildPermissionCard(
  action: PermissionRequested,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `🔐 Permission: ${action.permissionType}`,
      },
      template: "yellow",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: action.title },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ Allow Once" },
            type: "primary",
            value: {
              action: "permission_reply",
              requestId: action.requestId,
              reply: "once",
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ Always Allow" },
            type: "default",
            value: {
              action: "permission_reply",
              requestId: action.requestId,
              reply: "always",
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ Reject" },
            type: "danger",
            value: {
              action: "permission_reply",
              requestId: action.requestId,
              reply: "reject",
            },
          },
        ],
      },
    ],
  }
}
