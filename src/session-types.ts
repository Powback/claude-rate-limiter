// ============================================================================
// Session / Conversation / Message data model
// ============================================================================
//
// Hierarchy:
//   Account → Session → Conversation → Turn (Message)
//
// How this maps to JSON request logs in ./logs/:
//
//   Each log file = one API request forwarded by the proxy.
//   The request body contains the FULL conversation history (Anthropic's
//   stateless API resends all prior messages on every turn).
//
//   session_id     — from metadata.user_id (JSON-encoded field)
//   messageCount   — number of messages in history; grows +2 per turn
//                    (user msg + assistant response = one turn)
//   cch=<hash>     — "conversation context hash" in system[0] billing header;
//                    same hash across consecutive requests = same conversation
//
// Session boundary rules:
//   - Different session_id → new Session
//   - messageCount resets to 1 (within same session) → new Conversation
//   - Gap > SESSION_INACTIVITY_MS with no requests → new Session
//
// Conversation boundary rules:
//   - messageCount drops back to 1 → new Conversation
//   - Gap > CONVERSATION_INACTIVITY_MS → new Conversation (within session)
//   - cch hash changes (when messageCount stays same) → new Conversation
//
// Turn index formula (0-based):
//   turnIndex = Math.floor((messageCount - 1) / 2)
//   History grows: [user]=1 → [user,asst,user]=3 → [u,a,u,a,u]=5 → …
//   So request with messageCount=1 → turn 0, messageCount=3 → turn 1, etc.

// ── Constants ─────────────────────────────────────────────────────────────────

/** Gap after which a new CLI invocation is assumed (30 minutes) */
export const SESSION_INACTIVITY_MS = 30 * 60 * 1000;

/** Gap within a session that starts a new conversation thread (5 minutes) */
export const CONVERSATION_INACTIVITY_MS = 5 * 60 * 1000;

// ── Raw log shape (parsed from request-*.json files) ─────────────────────────

/**
 * Parsed representation of one request-*.json log file.
 * This is the source data for building Sessions/Conversations/Turns.
 */
export interface ParsedLogEntry {
  // Derived from filename
  filename: string;         // "request-2026-03-29T03-10-04-982Z.json"
  capturedAt: number;       // epoch ms (parsed from filename timestamp)

  // From request body
  model: string;            // "claude-haiku-4-5-20251001"
  messageCount: number;     // total messages in history at time of request
  systemPromptLength: number;
  streaming: boolean;

  // From metadata.user_id (JSON-parsed string)
  sessionId: string;        // UUID, e.g. "4a49efde-e628-4fa1-83dc-1497f9c8ff1d"
  deviceId: string;         // hex device fingerprint
  accountUuid: string;      // Anthropic account UUID

  // From billing header in system[0]: "cc_version=X; cc_entrypoint=Y; cch=Z;"
  ccVersion: string;        // "2.1.86.204"
  ccEntrypoint: string;     // "sdk-cli" | "vscode" | "ide" | "web" | …
  contextHash: string;      // cch= value (short hash, may be empty string)

  // From proxy response tracking (populated after response completes)
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  statusCode?: number;
  latencyMs?: number;
  tokensSaved?: number;
}

// ── Turn / Message ────────────────────────────────────────────────────────────

/**
 * One conversational turn = one user query + one assistant response.
 *
 * Each Turn corresponds to exactly one API request log file.
 * The request body at this point contains the full prior history
 * (messageCount - 1 prior messages) plus the new user message.
 */
export interface Turn {
  /** "<sessionId>-<conversationIndex>-<turnIndex>" */
  id: string;

  conversationId: string;
  sessionId: string;

  /** 0-based index within the conversation */
  turnIndex: number;

  /** epoch ms of when the proxy captured this request */
  timestamp: number;

  /** Source log filename */
  logFile: string;

  /** Model used for this turn */
  model: string;

  /**
   * Total messages in history at request time.
   * Equals (turnIndex * 2) + 1 for a normal conversation.
   */
  messageHistoryLength: number;

  /**
   * Conversation context hash from billing header (cch=).
   * Same value across consecutive requests = same ongoing conversation.
   * Empty string if not present.
   */
  contextHash: string;

  // Token usage for this turn
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  tokensSaved?: number;

  // Performance
  latencyMs?: number;
  statusCode?: number;
  streaming?: boolean;
}

// ── Conversation ──────────────────────────────────────────────────────────────

/**
 * A Conversation is a continuous sequence of turns on the same topic.
 *
 * Within one CLI session a user may start multiple conversations
 * (e.g., /clear, or opening a new task). A new conversation begins when:
 *   - messageCount drops back to 1 (history was reset)
 *   - cch hash changes (new context preset)
 *   - > CONVERSATION_INACTIVITY_MS gap between consecutive requests
 */
export interface Conversation {
  /** "<sessionId>-conv-<index>" */
  id: string;

  sessionId: string;

  /** 0-based index within the parent session */
  conversationIndex: number;

  /** epoch ms of the first turn in this conversation */
  startedAt: number;

  /** epoch ms of the most recent turn */
  lastActivityAt: number;

  /** Ordered turns (oldest first) */
  turns: Turn[];

  /** Total completed turns (= turns.length) */
  turnCount: number;

  /** Context hash (cch=) of the first turn; may be empty */
  initialContextHash: string;

  // ── Aggregated token stats ──────────────────────────────────────────────

  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalTokensSaved: number;

  /** Sum of all turn latencies in ms */
  totalLatencyMs: number;

  /** Distinct models seen in this conversation */
  models: string[];

  // ── Status ──────────────────────────────────────────────────────────────

  /**
   * True when the most recent turn was < CONVERSATION_INACTIVITY_MS ago.
   * Evaluated at read time, not stored.
   */
  isActive: boolean;
}

// ── Session ───────────────────────────────────────────────────────────────────

/**
 * A Session represents one Claude CLI invocation (or agent run).
 *
 * Identified by the session_id UUID from metadata.user_id.
 * Each `claude` process launch generates a fresh session_id;
 * all API requests within that process share it.
 *
 * A session may contain multiple Conversations (if the user runs
 * multiple prompts or the agent makes multiple separate task requests).
 */
export interface Session {
  /** The session_id UUID from metadata.user_id */
  id: string;

  // ── Identity ─────────────────────────────────────────────────────────────

  deviceId: string;
  accountUuid: string;

  /** "sdk-cli" | "vscode" | "ide" | "web" | unknown */
  entrypoint: string;

  /** Claude Code version string, e.g. "2.1.86.204" */
  ccVersion: string;

  /**
   * Short description of the agent role, extracted from the first
   * non-billing system prompt block that fits a known pattern.
   * Examples: "Claude Code", "Kanban Task Agent", "General Purpose Agent"
   */
  agentDescription?: string;

  // ── Timing ───────────────────────────────────────────────────────────────

  /** epoch ms of the first request in this session */
  startedAt: number;

  /** epoch ms of the most recent request */
  lastActivityAt: number;

  /** Duration from startedAt to lastActivityAt in ms */
  durationMs: number;

  // ── Conversations ────────────────────────────────────────────────────────

  /** Ordered conversations within this session (oldest first) */
  conversations: Conversation[];

  conversationCount: number;

  // ── Aggregated stats ──────────────────────────────────────────────────────

  /** Total API requests made in this session (= sum of all turn counts) */
  totalRequests: number;

  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalTokensSaved: number;

  /** Distinct models used across all conversations */
  models: string[];

  // ── Status ────────────────────────────────────────────────────────────────

  /**
   * True when lastActivityAt < SESSION_INACTIVITY_MS ago.
   * Evaluated at read time.
   */
  isActive: boolean;
}

// ── Account ───────────────────────────────────────────────────────────────────

/**
 * Top-level grouping by Anthropic account.
 * All sessions sharing the same accountUuid belong here.
 */
export interface Account {
  uuid: string;           // accountUuid from metadata
  deviceId: string;       // device fingerprint (may vary if multi-device)

  sessions: Session[];
  sessionCount: number;

  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalTokensSaved: number;
}

// ── Grouping result ───────────────────────────────────────────────────────────

/**
 * Output of the session-grouping algorithm.
 * Takes an array of ParsedLogEntry (from log files) and returns
 * the structured hierarchy.
 */
export interface GroupingResult {
  accounts: Account[];

  /** Flat index for O(1) lookup by session id */
  sessionIndex: Map<string, Session>;

  /** Flat index for O(1) lookup by conversation id */
  conversationIndex: Map<string, Conversation>;

  // Global stats
  totalLogFiles: number;
  totalSessions: number;
  totalConversations: number;
  totalTurns: number;

  /** Log files that could not be parsed (missing session_id, etc.) */
  unparseable: string[];
}

// ── Parsing helpers (types only) ──────────────────────────────────────────────

/**
 * Parsed billing header fields.
 * Extracted from: system[0].text which contains
 * "x-anthropic-billing-header: cc_version=X; cc_entrypoint=Y; cch=Z;"
 */
export interface BillingHeader {
  ccVersion: string;
  ccEntrypoint: string;
  contextHash: string;    // cch= value
}

/**
 * Parsed metadata.user_id (the field is a JSON-encoded string).
 */
export interface UserMetadata {
  device_id: string;
  account_uuid: string;
  session_id: string;
}
