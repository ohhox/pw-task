// ─── DOMAIN TYPES ────────────────────────────────────────────────────────────
// Single source of truth for the in-memory data model that lives in tasks.json.
// Mirrors the schema of tasks.json + patches/*.json so JS and (later) Rust agree.

// ─── ENUMS ────────────────────────────────────────────────────────────────

export type TaskStatus = 'todo' | 'in_progress' | 'pending_review' | 'done' | 'blocked';

export type TaskPriority = 'low' | 'medium' | 'high';

export type ModelId =
  | 'claude-haiku-4-5-20251001'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-7';

export type AgentProvider = 'claude' | 'manual';

// ─── TASK ─────────────────────────────────────────────────────────────────

export interface ActivityLogEntry {
  timestamp: string;
  agent: string;
  action: string;
}

export interface LastNote {
  timestamp: string;
  agent: string;
  summary: string;
}

export interface RunHistoryEntry {
  timestamp: string;
  model?: string;
  agentId?: string;
  summary?: string;
  sessionId?: string | null;
  outputFile?: string | null;
  /** Token usage and cost from Anthropic's result line. Absent for older run entries. */
  tokens?: TokenUsage | null;
}

/** Token usage + cost captured from Anthropic's result line. Matches bindings.ts `TokenUsage`. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Authoritative cost — do NOT recompute client-side; Anthropic returns this server-side. */
  totalCostUsd: number;
}

export interface Review {
  timestamp: string;
  action: 'approved' | 'request_changes';
  comment: string;
  reviewer: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;

  // Agent assignment — agentId is canonical, aiAgent is the legacy display string
  agentId?: string;
  aiAgent?: string;

  model?: ModelId | string | null;
  prompt?: string | null;

  tags: string[];
  subtasks: Task[];
  filesModified: string[];

  lastSessionId?: string | null;
  runHistory?: RunHistoryEntry[];
  lastNote?: LastNote;
  reviews?: Review[];
  activityLog?: ActivityLogEntry[];

  createdAt: string;
  updatedAt?: string;
  completedAt?: string | null;
}

// ─── PROJECT ──────────────────────────────────────────────────────────────

export interface ProjectAgentDefaults {
  planner?: string;
  executor?: string;
  reviewer?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  goal?: string;
  workingDir?: string;
  runCommand?: string;
  color: string;
  createdAt: string;
  tasks: Task[];
  agentDefaults?: ProjectAgentDefaults;
}

// ─── AGENT ────────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  label: string;
  provider: AgentProvider;
  defaultModel: ModelId | string | null;
  capabilities: string[];
  enabled: boolean;
  systemPrompt: string;
  /** Per-agent permission profile from upgrade-01 fix. Optional during migration. */
  allowedTools?: string[] | null;
  skipPermissions?: boolean;
}

// ─── PATCH ────────────────────────────────────────────────────────────────

export interface PatchBase {
  version: string;
  timestamp: string;
  agent: string;
  changes: Change[];
  /** Marker written when a patch could not be deleted; treated as already-applied. */
  _applied?: boolean;
}

export type Patch = PatchBase;

// Discriminated union — switch on `type`
export type Change =
  | StatusChangeEvent
  | AddProjectEvent
  | AddTaskEvent
  | UpdateTaskEvent
  | FilesModifiedEvent
  | AddLogEvent;

export interface StatusChangeEvent {
  type: 'status_change';
  projectId: string;
  taskId: string;
  from?: TaskStatus;
  to: TaskStatus;
  /** Required when transitioning between non-trivial states — surfaces in dashboard. */
  note?: string;
}

export interface AddProjectEvent {
  type: 'add_project';
  project: Project;
}

export interface AddTaskEvent {
  type: 'add_task';
  projectId: string;
  /** null = root level under the project */
  parentTaskId: string | null;
  task: Task;
}

/** Updatable fields are restricted by the apply-side allowlist for safety. */
export interface UpdateTaskEvent {
  type: 'update_task';
  projectId: string;
  taskId: string;
  updates: Partial<
    Pick<
      Task,
      'title' | 'description' | 'priority' | 'agentId' | 'aiAgent' | 'model' | 'prompt' | 'tags'
    >
  >;
  note?: string;
}

export interface FilesModifiedEvent {
  type: 'files_modified';
  projectId: string;
  taskId: string;
  files: string[];
}

export interface AddLogEvent {
  type: 'add_log';
  projectId: string;
  taskId: string;
  log: ActivityLogEntry;
}

// ─── DATABASE ─────────────────────────────────────────────────────────────

export interface DatabaseInstructions {
  forAI?: string;
  patchPattern?: unknown;
}

export interface Database {
  version?: string;
  /** Set by Phase 1.4 migrations once they land; until then `version` is canonical. */
  schemaVersion?: string;
  lastUpdated: string;
  projects: Project[];
  agents?: Agent[];
  /** Patch identifiers that have already been applied — see fileops.ts:patchIdentity */
  appliedPatches?: string[];
  _instructions?: DatabaseInstructions;
}
