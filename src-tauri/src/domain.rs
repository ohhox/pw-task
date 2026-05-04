// ─── DOMAIN ──────────────────────────────────────────────────────────────────
// Canonical Rust types for the in-memory task database.
//
// Mirrors `src/types/domain.ts` byte-for-byte: every JSON document that loads
// into the TypeScript model must round-trip through these structs without
// shape drift, and every value produced here must deserialize cleanly on the
// TS side via the auto-generated `bindings.ts`.
//
// Key conventions:
//   * Field names are snake_case in Rust but serialize to camelCase in JSON
//     via `#[serde(rename_all = "camelCase")]`, matching the existing
//     `outputs/tasks.json` shape so no migration is required.
//   * Enums use string-literal serialization (`"todo"`, `"in_progress"`, ...)
//     to match the TS string-union types.
//   * Optional/missing fields use `#[serde(default, skip_serializing_if =
//     "Option::is_none")]` to keep round-trips free of phantom `null` keys.
//   * Collection fields default to empty so partial JSON (e.g. legacy data
//     without `runHistory`) deserializes without error.
//   * The free-form `_instructions` blob on `Database` is preserved as
//     `serde_json::Value` so Rust never has to interpret it.

use serde::{Deserialize, Serialize};
use specta::Type;

// Re-export so callers can `use ai_task_flow::domain::TokenUsage` without
// knowing where the struct was originally defined.
pub use crate::TokenUsage;

// ─── ENUMS ───────────────────────────────────────────────────────────────────

/// Task workflow state. Matches TS `TaskStatus` string-union exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    PendingReview,
    Done,
    Blocked,
}

/// Priority bucket. Matches TS `TaskPriority`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum TaskPriority {
    Low,
    Medium,
    High,
}

/// Provider type for an agent (claude CLI vs manual/external).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum AgentProvider {
    Claude,
    Manual,
}

// ─── ACTIVITY / HISTORY ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLog {
    pub timestamp: String,
    pub agent: String,
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LastNote {
    pub timestamp: String,
    pub agent: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunEntry {
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_file: Option<String>,
    /// Token usage and cost captured from Anthropic's `result` line.
    /// Omitted when absent so old tasks.json entries without this field
    /// still deserialize cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReviewAction {
    Approved,
    RequestChanges,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub timestamp: String,
    pub action: ReviewAction,
    pub comment: String,
    pub reviewer: String,
}

// ─── TASK ────────────────────────────────────────────────────────────────────

/// Recursive task node. Each task may own zero-or-more `subtasks`; Rust handles
/// the recursion cleanly because `Vec<Task>` is heap-allocated, so no `Box`
/// indirection is required.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub status: TaskStatus,
    pub priority: TaskPriority,

    // Agent assignment — agentId is canonical, aiAgent is the legacy
    // display string still found in older tasks.json entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_agent: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,

    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub subtasks: Vec<Task>,
    #[serde(default)]
    pub files_modified: Vec<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_history: Option<Vec<RunEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_note: Option<LastNote>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviews: Option<Vec<Review>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_log: Option<Vec<ActivityLog>>,

    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

// ─── PROJECT ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_command: Option<String>,
    pub color: String,
    pub created_at: String,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_defaults: Option<ProjectAgentDefaults>,
}

// ─── AGENT ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub label: String,
    pub provider: AgentProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub enabled: bool,
    #[serde(default)]
    pub system_prompt: String,
    /// Per-agent permission profile from upgrade-01 fix. Optional during migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_permissions: Option<bool>,
}

// ─── PATCH / CHANGE ──────────────────────────────────────────────────────────

/// Discriminated union of patch operations. Tagged on `type` to match the
/// existing JSON wire format that the JS dashboard already produces.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Change {
    StatusChange {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<TaskStatus>,
        to: TaskStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    AddProject {
        project: Project,
    },
    AddTask {
        #[serde(rename = "projectId")]
        project_id: String,
        /// `None` (JSON `null`) = root level under the project.
        #[serde(rename = "parentTaskId")]
        parent_task_id: Option<String>,
        task: Task,
    },
    UpdateTask {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        /// Sparse map of field → new value. Allowlist enforced server-side.
        updates: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    FilesModified {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        files: Vec<String>,
    },
    AddLog {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        log: ActivityLog,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub version: String,
    pub timestamp: String,
    pub agent: String,
    pub changes: Vec<Change>,
    /// Marker written when a patch could not be deleted; treated as
    /// already-applied. Stays as `_applied` (underscore prefix) on the wire.
    #[serde(rename = "_applied", default, skip_serializing_if = "Option::is_none")]
    pub applied: Option<bool>,
}

// ─── DATABASE ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Database {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Set by Phase 1.4 migrations once they land; until then `version`
    /// stays canonical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<String>,
    pub last_updated: String,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<Agent>>,
    /// Patch identifiers that have already been applied — see
    /// fileops.ts:patchIdentity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_patches: Option<Vec<String>>,
    /// Free-form metadata block (`forAI`, `patchPattern`, examples). Kept as
    /// an opaque JSON value so Rust never has to interpret it. The leading
    /// underscore is preserved on the wire by the explicit `rename`.
    #[serde(
        rename = "_instructions",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub instructions: Option<serde_json::Value>,
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

impl TaskStatus {
    /// Stable string form used by progress/escalate logic and matching the
    /// JSON wire representation. Cheap because we just return a static slice.
    pub fn as_wire_str(self) -> &'static str {
        match self {
            TaskStatus::Todo => "todo",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::PendingReview => "pending_review",
            TaskStatus::Done => "done",
            TaskStatus::Blocked => "blocked",
        }
    }
}
