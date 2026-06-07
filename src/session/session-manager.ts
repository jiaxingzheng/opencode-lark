import { type Database } from "bun:sqlite"
import { createLogger } from "../utils/logger.js"
import type { SessionMapping } from "../types.js"
import { parseModelSpec } from "../utils/config.js"

const logger = createLogger("session-manager")

interface SessionManagerOptions {
  serverUrl: string
  db: Database
  defaultAgent: string
  /** Model spec as "providerID/id" (e.g. "opencode/minimax-m3-free").
   *  Passed into POST /session body so newly created sessions are
   *  pinned to the configured model instead of opencode's default. */
  defaultModel?: string
}

export interface SessionManager {
  getOrCreate(feishuKey: string, agent?: string): Promise<string>
  getExisting(feishuKey: string): Promise<string | undefined>
  getSession(feishuKey: string): SessionMapping | null
  deleteMapping(feishuKey: string): boolean
  setMapping(feishuKey: string, sessionId: string, agent?: string): boolean
  cleanup(maxAgeMs?: number): number
  /** Validate all stored mappings against the opencode server; delete stale ones. */
  validateAndCleanupStale(): Promise<number>
}

function getWorkingDirectory(): string {
  return process.env.OPENCODE_CWD || process.cwd()
}

interface TuiSession {
  id: string
  title?: string
  directory?: string
  time?: { created: number; updated: number }
}

export function createSessionManager(
  options: SessionManagerOptions,
): SessionManager {
  const { serverUrl, db, defaultAgent, defaultModel } = options

  // Parse the configured model spec once at construction. If it fails
  // to parse (bad format), fall back to no model override and warn —
  // opencode will use its own default for the agent.
  const parsedModel = defaultModel ? parseModelSpec(defaultModel) : null
  if (defaultModel && !parsedModel) {
    logger.warn(
      `defaultModel "${defaultModel}" is not in "providerID/id" form — sessions will use opencode's default model`,
    )
  } else if (parsedModel) {
    logger.info(
      `New sessions will be pinned to model ${parsedModel.providerID}/${parsedModel.id}`,
    )
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_sessions (
      feishu_key  TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      agent       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      is_bound    INTEGER DEFAULT 0
    )
  `)

  try {
    db.exec("ALTER TABLE feishu_sessions ADD COLUMN is_bound INTEGER DEFAULT 0")
  } catch {
    // Column already exists — safe to ignore
  }

  const getStmt = db.prepare(
    "SELECT * FROM feishu_sessions WHERE feishu_key = ?",
  )

  const upsertStmt = db.prepare(
    `INSERT OR REPLACE INTO feishu_sessions
       (feishu_key, session_id, agent, created_at, last_active, is_bound)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )

  const updateActiveStmt = db.prepare(
    "UPDATE feishu_sessions SET last_active = ? WHERE feishu_key = ?",
  )

  const cleanupStmt = db.prepare(
    "DELETE FROM feishu_sessions WHERE last_active < ?",
  )

  const deleteMappingStmt = db.prepare(
    "DELETE FROM feishu_sessions WHERE feishu_key = ?",
  )

  /** Check whether a session ID actually exists on the opencode server.
   *  Returns false ONLY on 404. All other errors (500, 429, network) return true (conservative). */
  async function sessionExistsOnServer(sessionId: string): Promise<boolean> {
    try {
      const resp = await fetch(`${serverUrl}/session/${sessionId}`)
      if (resp.status === 404) return false
      // Any other status (200, 500, 429, 401, etc.) — conservatively assume exists
      return true
    } catch {
      // Network error — assume session exists to avoid false cleanup
      return true
    }
  }

  async function discoverTuiSession(): Promise<TuiSession | null> {
    const cwd = getWorkingDirectory()
    const url = `${serverUrl}/session?roots=true&limit=1&directory=${encodeURIComponent(cwd)}`

    try {
      const resp = await fetch(url)
      if (!resp.ok) return null

      const sessions = (await resp.json()) as TuiSession[]
      const candidate = sessions[0] ?? null
      if (!candidate) return null

      // Validate that the discovered session actually exists on the server
      const exists = await sessionExistsOnServer(candidate.id)
      if (!exists) {
        logger.warn(`Discovered TUI session ${candidate.id} returned 404 — skipping`)
        return null
      }

      return candidate
    } catch {
      return null
    }
  }

  async function createNewSession(feishuKey: string, agent?: string): Promise<string> {
    const body: Record<string, unknown> = {
      title: `Feishu chat ${feishuKey}`,
    }
    if (agent ?? defaultAgent) body["agent"] = agent ?? defaultAgent
    if (parsedModel) body["model"] = parsedModel

    const resp = await fetch(`${serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      throw new Error(`Failed to create session: HTTP ${resp.status}`)
    }

    const data = (await resp.json()) as { id: string }
    return data.id
  }

  return {
    async getOrCreate(feishuKey, agent) {
      const existing = getStmt.get(feishuKey) as SessionMapping | null

      if (existing) {
        updateActiveStmt.run(Date.now(), feishuKey)
        return existing.session_id
      }

      const agentName = agent ?? defaultAgent
      logger.info(`Resolving session for ${feishuKey} (agent: ${agentName})`)

      const discovered = await discoverTuiSession()

      if (discovered) {
        const now = Date.now()
        upsertStmt.run(feishuKey, discovered.id, agentName, now, now, 1)
        logger.info(`Bound to TUI session: ${feishuKey} → ${discovered.id}`)
        return discovered.id
      }

      const sessionId = await createNewSession(feishuKey, agent)
      const now = Date.now()
      upsertStmt.run(feishuKey, sessionId, agentName, now, now, 0)
      logger.info(`Session created: ${feishuKey} → ${sessionId}`)
      return sessionId
    },

    async getExisting(feishuKey) {
      const existing = getStmt.get(feishuKey) as SessionMapping | null
      return existing?.session_id
    },

    getSession(feishuKey) {
      return (getStmt.get(feishuKey) as SessionMapping | undefined) ?? null
    },

    deleteMapping(feishuKey) {
      const result = deleteMappingStmt.run(feishuKey)
      if (result.changes > 0) {
        logger.info(`Deleted session mapping for ${feishuKey}`)
      }
      return result.changes > 0
    },

    setMapping(feishuKey, sessionId, agent) {
      const agentName = agent ?? defaultAgent
      const now = Date.now()
      const result = upsertStmt.run(feishuKey, sessionId, agentName, now, now, 1)
      if (result.changes > 0) {
        logger.info(`Set session mapping: ${feishuKey} → ${sessionId}`)
      }
      return result.changes > 0
    },

    cleanup(maxAgeMs = 30 * 60 * 1000) {
      const cutoff = Date.now() - maxAgeMs
      const result = cleanupStmt.run(cutoff)
      if (result.changes > 0) {
        logger.info(`Cleaned up ${result.changes} expired session mappings`)
      }
      return result.changes
    },

    async validateAndCleanupStale() {
      const allMappingsStmt = db.prepare("SELECT * FROM feishu_sessions")
      const allMappings = allMappingsStmt.all() as SessionMapping[]
      let cleaned = 0

      for (const mapping of allMappings) {
        try {
          const exists = await sessionExistsOnServer(mapping.session_id)
          if (!exists) {
            deleteMappingStmt.run(mapping.feishu_key)
            cleaned++
            logger.info(
              `Startup cleanup: removed stale mapping ${mapping.feishu_key} → ${mapping.session_id}`,
            )
          }
        } catch (err) {
          // Network error — skip this mapping, don't disrupt startup
          logger.warn(
            `Startup cleanup: failed to validate ${mapping.session_id}: ${err}`,
          )
        }
      }

      if (cleaned > 0) {
        logger.info(`Startup cleanup: removed ${cleaned} stale session mapping(s)`)
      } else if (allMappings.length > 0) {
        logger.info(`Startup cleanup: all ${allMappings.length} session mapping(s) valid`)
      }

      return cleaned
    },
  }
}


