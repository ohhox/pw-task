// ─── MODALS (barrel) ─────────────────────────────────────────────────────────
// Phase E architectural split: modals.ts (633 lines) → 4 focused modules.
// This file re-exports everything so existing `import … from './modals.js'`
// call sites continue to work without any changes.
export { showModal } from './modals-shared.js';
export { generateClaudeMd, showClaudeMdCopyModal, showAddProjectModal, showEditProjectModal, confirmDeleteProject } from './modals-project.js';
export { showAddTaskModal, showEditTaskModal, confirmDeleteTask } from './modals-task.js';
export { showAgentManagerModal, showAgentEditModal } from './modals-agent.js';
