// ─── MODALS ─────────────────────────────────────────────────────────────────
// Owns: all modal dialog creation and interaction (add/edit project/task, delete, CLAUDE.md copy).
// Does NOT: persist data directly — calls scheduleSave() and render helpers after mutations.
import {
  db, baseDir, activeProjectId, selectedTaskPath,
  setActiveProjectId, setSelectedTaskPath,
} from './state.js';
import {
  esc, now, uuid, statusLabel, modelShortName, MODEL_OPTIONS,
  toast, autoEscalate, getProject, findTaskByPath,
} from './data.js';
import {
  getEnabledAgents, getAllAgents, getAgent, agentAdd, agentUpdate, agentRemove,
  DEFAULT_AGENT_IDS, legacyToAgentId,
} from './agents/index.js';
import { scheduleSave } from './fileops.js';
import { renderSidebar, renderProject, renderTaskList, refreshAgentFilter } from './render.js';
import { renderDetail } from './detail.js';
import type {
  Project, Task, Agent, AgentProvider, TaskStatus, TaskPriority,
} from '../types/domain';

// ─── Typed query helpers ──────────────────────────────────────────────────
// IDs in modal innerHTML are static; cast results once instead of repeating
// `as HTMLInputElement` everywhere.
const qInput = (root: ParentNode, sel: string): HTMLInputElement =>
  root.querySelector(sel) as HTMLInputElement;
const qSelect = (root: ParentNode, sel: string): HTMLSelectElement =>
  root.querySelector(sel) as HTMLSelectElement;
const qTextarea = (root: ParentNode, sel: string): HTMLTextAreaElement =>
  root.querySelector(sel) as HTMLTextAreaElement;
const qBtn = (root: ParentNode, sel: string): HTMLButtonElement =>
  root.querySelector(sel) as HTMLButtonElement;

type ModalConfirmFn = (ov: HTMLElement) => boolean | void;

export function showModal(
  html: string,
  onConfirm: ModalConfirmFn,
  confirmText: string = 'Confirm',
  isDanger: boolean = false
): HTMLElement {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal">${html}<div class="modal-actions">
    <button class="modal-btn" id="m-cancel">Cancel</button>
    <button class="modal-btn ${isDanger ? 'danger' : 'primary'}" id="m-confirm">${confirmText}</button>
  </div></div>`;
  document.body.appendChild(ov);
  const close = (): void => { document.body.removeChild(ov); };
  qBtn(ov, '#m-cancel').addEventListener('click', close);
  qBtn(ov, '#m-confirm').addEventListener('click', () => {
    const prevent = onConfirm(ov);
    if (prevent !== false) close();
  });
  setTimeout(() => {
    const focusable = ov.querySelector<HTMLElement>('.modal-input, textarea, select');
    focusable?.focus();
  }, 50);
  return ov;
}

const COLORS: string[] = [
  '#6c63ff', '#ff6584', '#4ade80', '#60a5fa', '#fb923c', '#f472b6', '#a78bfa', '#34d399',
];

function colorPickerHtml(cur: string): string {
  return `<div class="color-row">${COLORS.map((c) =>
    `<div class="color-swatch${c === cur ? ' selected' : ''}" data-color="${c}" style="background:${c}"></div>`
  ).join('')}<input type="color" class="color-input-native" id="color-native" value="${cur || COLORS[0]}"></div>`;
}

function bindColor(ov: HTMLElement): () => string {
  let sel: string =
    (ov.querySelector('.color-swatch.selected') as HTMLElement | null)?.dataset.color ||
    COLORS[0];
  ov.querySelectorAll<HTMLElement>('.color-swatch').forEach((sw) =>
    sw.addEventListener('click', () => {
      ov.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      sw.classList.add('selected');
      sel = sw.dataset.color || COLORS[0];
      qInput(ov, '#color-native').value = sel;
    })
  );
  qInput(ov, '#color-native').addEventListener('input', (e) => {
    ov.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
    sel = (e.target as HTMLInputElement).value;
  });
  return () => sel;
}

export function generateClaudeMd(proj: Project, basePath: string): string {
  const raw = (basePath || '').replace(/[/\\]$/, '');
  const sep = raw.includes('\\') ? '\\' : '/';
  const p = raw || 'YOUR_OUTPUTS_FOLDER_PATH';
  const pSlash = p + sep;
  return `# CLAUDE.md — AI Task Flow Instructions

## ทุก session ต้องทำก่อนเริ่มงาน

1. อ่าน \`tasks.json\` ตาม path ในส่วน **Config** ด้านล่าง
2. ดู \`_instructions.patchPattern\` ในไฟล์นั้นเพื่อเข้าใจรูปแบบ patch
3. ถามว่าจะทำ task ไหน หรือ propose task ใหม่จาก goal ที่ได้รับ
4. เริ่มทำงานเมื่อได้รับ confirm แล้วเท่านั้น

---

## ทุก session ต้องทำหลังเสร็จงาน

> ⚠️ **ห้ามแก้ \`tasks.json\` โดยตรง** — ให้สร้าง patch file ใน \`patches/\` แทนเสมอ

สร้างไฟล์ใน **patches folder** (ดู path ในส่วน Config) ชื่อไฟล์:
\`\`\`
YYYY-MM-DDTHH-MM-SS_Claude.json
\`\`\`
เช่น \`2026-05-02T10-30-00_Claude.json\`

### รูปแบบ patch file

\`\`\`json
{
  "version": "1.0",
  "timestamp": "2026-05-02T10:30:00.000Z",
  "agent": "Claude",
  "changes": [
    {
      "type": "status_change",
      "projectId": "${proj.id}",
      "taskId": "task-xxx",
      "from": "in_progress",
      "to": "pending_review",
      "note": "สิ่งที่ทำไปใน session นี้"
    },
    {
      "type": "files_modified",
      "projectId": "${proj.id}",
      "taskId": "task-xxx",
      "files": ["path/to/changed/file.ts"]
    }
  ]
}
\`\`\`

### Change types ที่ใช้ได้

| type | fields ที่ต้องมี |
|------|-----------------|
| \`status_change\` | projectId, taskId, from, to, **note (บังคับ)** |
| \`add_task\` | projectId, parentTaskId (null = root), task (full object) |
| \`update_task\` | projectId, taskId, updates {field: value, ...}, note? |
| \`files_modified\` | projectId, taskId, files[] |
| \`add_log\` | projectId, taskId, log {timestamp, agent, action} |

> **\`note\` บังคับ** เมื่อเปลี่ยน status — สรุปสั้นๆ ว่า session นี้ทำอะไรไป Dashboard จะแสดง note นี้ที่ task row ให้ human เห็นทันที

Dashboard จะ merge patches อัตโนมัติตามลำดับเวลาเมื่อเปิดโปรแกรม และลบ patch ที่ apply แล้วทิ้ง

---

## Status ที่ใช้

| Status | ความหมาย |
|--------|----------|
| \`todo\` | ยังไม่เริ่ม |
| \`in_progress\` | กำลังทำอยู่ใน session นี้ |
| \`pending_review\` | ทำเสร็จแล้ว รอ human ตรวจ |
| \`done\` | human approve แล้ว |
| \`blocked\` | ติดปัญหา รอ dependency |

> **สำคัญ**: Claude ตั้ง status เป็น \`pending_review\` ได้ แต่ **ห้ามตั้งเป็น \`done\` เอง** — ให้ human เป็นคนตัดสินใจผ่าน dashboard

---

## Config

- **tasks.json**: \`${pSlash}tasks.json\`
- **patches folder**: \`${pSlash}patches${sep}\`
- **dashboard**: \`${pSlash}dashboard.html\`
- **Project ที่ active ใน tasks.json**: ${proj.name} (\`${proj.id}\`)

---

## กฎเพิ่มเติม

- ดู \`projectId\` และ \`taskId\` จาก \`tasks.json\` ก่อนเขียน patch ทุกครั้ง
- ถ้ายังไม่มี task ที่ตรงกับงาน → เพิ่มผ่าน patch (type: \`add_task\`) แทนการแก้ไฟล์ตรงๆ
- ถ้างานใหญ่ → แตกเป็น subtasks ก่อน แล้วค่อยเริ่ม
- ถ้าไม่แน่ใจว่า task ไหน active อยู่ → อ่าน \`tasks.json\` และถามก่อนเสมอ
- ไม่ลบ task เก่าออก — เปลี่ยน status เป็น \`done\` หรือ \`blocked\` แทน
`;
}

export function showClaudeMdCopyModal(proj: Project): void {
  const storedPath = baseDir || localStorage.getItem('pwtask-base-path') || '';
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal" style="max-width:640px;width:90vw">
    <div class="modal-title">📋 CLAUDE.md — ${esc(proj.name)}</div>
    <div class="modal-field" style="margin-bottom:12px">
      <label class="modal-label" style="display:block;margin-bottom:4px">📂 Path ของ outputs folder</label>
      <input id="claudemd-base-path" class="modal-input" value="${esc(storedPath)}" placeholder="เช่น D:\\DEV\\PwTask\\outputs" style="font-family:monospace;font-size:12px">
      <div style="font-size:11px;color:var(--text-muted);margin-top:3px">ตั้งครั้งเดียว จะจำให้อัตโนมัติ • dashboard.html, tasks.json, patches/ อยู่ใน folder นี้</div>
    </div>
    <textarea id="claudemd-content" style="width:100%;height:280px;font-family:monospace;font-size:11px;background:var(--surface3);border:1px solid var(--border);color:var(--text);padding:10px;border-radius:var(--radius-sm);resize:vertical;line-height:1.5" spellcheck="false"></textarea>
    <p style="font-size:11px;color:var(--text-muted);margin-top:6px">วางไฟล์นี้ที่ root ของ project directory ชื่อ <code style="background:var(--surface3);padding:1px 4px;border-radius:3px">CLAUDE.md</code></p>
    <div class="modal-actions">
      <button class="modal-btn" id="m-close-claude">Close</button>
      <button class="modal-btn primary" id="m-copy-claude">Copy to Clipboard</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const pathInput = qInput(ov, '#claudemd-base-path');
  const contentArea = qTextarea(ov, '#claudemd-content');
  const refresh = (): void => { contentArea.value = generateClaudeMd(proj, pathInput.value.trim()); };
  refresh();
  pathInput.addEventListener('input', refresh);
  pathInput.addEventListener('blur', () => {
    const p = pathInput.value.trim();
    if (p) localStorage.setItem('pwtask-base-path', p);
  });
  const close = (): void => { document.body.removeChild(ov); };
  qBtn(ov, '#m-close-claude').addEventListener('click', close);
  qBtn(ov, '#m-copy-claude').addEventListener('click', () => {
    const p = pathInput.value.trim();
    if (p) localStorage.setItem('pwtask-base-path', p);
    navigator.clipboard.writeText(contentArea.value).then(() => {
      toast('Copied! วางใน CLAUDE.md ของ project directory ได้เลย');
    }).catch(() => {
      contentArea.select();
      document.execCommand('copy');
      toast('Copied!');
    });
  });
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
}

export function showAddProjectModal(): void {
  let getColor: () => string = () => COLORS[0];
  const ov = showModal(
    `
    <div class="modal-title">New Project</div>
    <div class="modal-field"><label class="modal-label">Name</label><input class="modal-input" id="p-name" placeholder="Project name…"></div>
    <div class="modal-field"><label class="modal-label">Description</label><textarea class="modal-textarea" id="p-desc" placeholder="Short description…"></textarea></div>
    <div class="modal-field"><label class="modal-label">🎯 Goal</label><textarea class="modal-textarea" id="p-goal" placeholder="เป้าหมายของ project นี้คืออะไร…" style="min-height:60px"></textarea></div>
    <div class="modal-field"><label class="modal-label">📁 Working Directory</label><input class="modal-input" id="p-workdir" placeholder="เช่น D:\\DEV\\MyProject" style="font-family:monospace;font-size:12px"></div>
    <div class="modal-field"><label class="modal-label">▶ Run Command</label><input class="modal-input" id="p-runcmd" placeholder="เช่น npm run dev" style="font-family:monospace;font-size:12px"></div>
    <div class="modal-field"><label class="modal-label">Color</label>${colorPickerHtml(COLORS[0])}</div>`,
    () => {
      if (!db) return false;
      const name = qInput(ov, '#p-name').value.trim();
      if (!name) { toast('Name is required'); return false; }
      const newProj: Project = {
        id: uuid(),
        name,
        description: qTextarea(ov, '#p-desc').value.trim(),
        goal: qTextarea(ov, '#p-goal').value.trim(),
        workingDir: qInput(ov, '#p-workdir').value.trim(),
        runCommand: qInput(ov, '#p-runcmd').value.trim(),
        color: getColor(),
        createdAt: now(),
        tasks: [],
      };
      db.projects.push(newProj);
      setActiveProjectId(newProj.id);
      scheduleSave();
      renderSidebar();
      renderProject();
      toast('✅ Project created');
      setTimeout(() => showClaudeMdCopyModal(newProj), 150);
    },
    'Create'
  );
  getColor = bindColor(ov);
}

export function showEditProjectModal(): void {
  const proj = getProject(activeProjectId);
  if (!proj) return;
  const defs = proj.agentDefaults || {};
  const claudeAgents = getEnabledAgents().filter((a) => a.provider === 'claude');
  const agentOptsHtml = (selected: string): string =>
    claudeAgents.map((a) =>
      `<option value="${a.id}"${a.id === selected ? ' selected' : ''}>${a.label}</option>`
    ).join('');

  let getColor: () => string = () => proj.color;
  const ov = showModal(
    `
    <div class="modal-title">Edit Project</div>
    <div class="modal-field"><label class="modal-label">Name</label><input class="modal-input" id="p-name" value="${esc(proj.name)}"></div>
    <div class="modal-field"><label class="modal-label">Description</label><textarea class="modal-textarea" id="p-desc">${esc(proj.description || '')}</textarea></div>
    <div class="modal-field"><label class="modal-label">🎯 Goal</label><textarea class="modal-textarea" id="p-goal" style="min-height:60px">${esc(proj.goal || '')}</textarea></div>
    <div class="modal-field"><label class="modal-label">📁 Working Directory</label><input class="modal-input" id="p-workdir" value="${esc(proj.workingDir || '')}" style="font-family:monospace;font-size:12px"></div>
    <div class="modal-field"><label class="modal-label">▶ Run Command</label><input class="modal-input" id="p-runcmd" value="${esc(proj.runCommand || '')}" placeholder="เช่น npm run dev" style="font-family:monospace;font-size:12px"></div>
    <div class="modal-field">
      <label class="modal-label">🤖 Agent Defaults</label>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div><div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">Planner</div>
          <select class="modal-select" id="p-def-planner">${agentOptsHtml(defs.planner || 'planner')}</select></div>
        <div><div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">Executor</div>
          <select class="modal-select" id="p-def-executor">${agentOptsHtml(defs.executor || 'executor')}</select></div>
        <div><div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">Reviewer</div>
          <select class="modal-select" id="p-def-reviewer">${agentOptsHtml(defs.reviewer || 'reviewer')}</select></div>
      </div>
    </div>
    <div class="modal-field"><label class="modal-label">Color</label>${colorPickerHtml(proj.color)}</div>`,
    () => {
      const name = qInput(ov, '#p-name').value.trim();
      if (!name) { toast('Name is required'); return false; }
      proj.name = name;
      proj.description = qTextarea(ov, '#p-desc').value.trim();
      proj.goal = qTextarea(ov, '#p-goal').value.trim();
      proj.workingDir = qInput(ov, '#p-workdir').value.trim();
      proj.runCommand = qInput(ov, '#p-runcmd').value.trim();
      proj.agentDefaults = {
        planner: qSelect(ov, '#p-def-planner').value,
        executor: qSelect(ov, '#p-def-executor').value,
        reviewer: qSelect(ov, '#p-def-reviewer').value,
      };
      proj.color = getColor();
      scheduleSave();
      renderSidebar();
      renderProject();
    },
    'Save'
  );
  getColor = bindColor(ov);
}

export function confirmDeleteProject(): void {
  const proj = getProject(activeProjectId);
  if (!proj) return;
  showModal(
    `<div class="modal-title">Delete Project</div><p style="color:var(--text-dim);font-size:13px">Delete <strong>${esc(proj.name)}</strong> and all its tasks?</p>`,
    () => {
      if (!db) return false;
      db.projects = db.projects.filter((p) => p.id !== activeProjectId);
      setActiveProjectId(db.projects[0]?.id || null);
      setSelectedTaskPath(null);
      scheduleSave();
      renderSidebar();
      renderProject();
      toast('🗑 Project deleted');
    },
    'Delete',
    true
  );
}

export function showAddTaskModal(parentPath: string[] | null): void {
  showModal(
    `
    <div class="modal-title">${parentPath ? 'New Subtask' : 'New Task'}</div>
    <div class="modal-field"><label class="modal-label">Title</label><input class="modal-input" id="t-title" placeholder="Task title…"></div>
    <div class="modal-field"><label class="modal-label">Description</label><textarea class="modal-textarea" id="t-desc" placeholder="Markdown supported…"></textarea></div>
    <div class="modal-field"><label class="modal-label">Priority</label>
      <select class="modal-select" id="t-priority"><option value="medium">Medium</option><option value="high">High</option><option value="low">Low</option></select></div>
    <div class="modal-field"><label class="modal-label">Agent</label>
      <select class="modal-select" id="t-agent">
        ${getEnabledAgents().map((a) => `<option value="${a.id}"${a.id === 'executor' ? ' selected' : ''}>${a.label}</option>`).join('')}
      </select></div>
    <div class="modal-field"><label class="modal-label">Model</label>
      <select class="modal-select" id="t-model">
        <option value="">— agent default —</option>
        ${MODEL_OPTIONS.map((o) => `<option value="${o.id}">${o.label}</option>`).join('')}
      </select></div>
    <div class="modal-field"><label class="modal-label">Prompt</label><textarea class="modal-textarea" id="t-prompt" placeholder="คำสั่งสำหรับ Claude…" style="min-height:70px;font-size:12px"></textarea></div>`,
    (ov) => {
      const title = qInput(ov, '#t-title').value.trim();
      if (!title) { toast('Title is required'); return false; }
      const agentId = qSelect(ov, '#t-agent').value;
      const agentEntry = getAgent(agentId);
      const task: Task = {
        id: uuid(),
        title,
        description: qTextarea(ov, '#t-desc').value.trim(),
        status: 'todo',
        priority: qSelect(ov, '#t-priority').value as TaskPriority,
        tags: [],
        agentId,
        aiAgent: agentEntry.label,
        model: qSelect(ov, '#t-model').value || null,
        prompt: qTextarea(ov, '#t-prompt').value.trim() || null,
        lastSessionId: null,
        runHistory: [],
        filesModified: [],
        createdAt: now(),
        updatedAt: now(),
        completedAt: null,
        reviews: [],
        activityLog: [{ timestamp: now(), agent: 'Manual', action: 'created task' }],
        subtasks: [],
      };
      if (!parentPath) {
        getProject(activeProjectId)?.tasks.push(task);
      } else {
        const parent = findTaskByPath(parentPath);
        if (parent) (parent.subtasks = parent.subtasks || []).push(task);
      }
      scheduleSave();
      renderSidebar();
      renderTaskList();
      toast('✅ Task created');
    },
    'Create'
  );
}

export function showEditTaskModal(path: string[]): void {
  const task = findTaskByPath(path);
  if (!task) return;
  showModal(
    `
    <div class="modal-title">Edit Task</div>
    <div class="modal-field"><label class="modal-label">Title</label><input class="modal-input" id="t-title" value="${esc(task.title)}"></div>
    <div class="modal-field"><label class="modal-label">Description</label><textarea class="modal-textarea" id="t-desc">${esc(task.description || '')}</textarea></div>
    <div class="modal-field"><label class="modal-label">Status</label>
      <select class="modal-select" id="t-status">${(['todo', 'in_progress', 'pending_review', 'done', 'blocked'] as TaskStatus[]).map((s) => `<option value="${s}"${task.status === s ? ' selected' : ''}>${statusLabel(s)}</option>`).join('')}</select></div>
    <div class="modal-field"><label class="modal-label">Priority</label>
      <select class="modal-select" id="t-priority">${(['low', 'medium', 'high'] as TaskPriority[]).map((s) => `<option value="${s}"${task.priority === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
    <div class="modal-field"><label class="modal-label">Agent</label>
      <select class="modal-select" id="t-agent">${getEnabledAgents().map((a) => {
        const sel = (task.agentId || legacyToAgentId(task.aiAgent || '')) === a.id;
        return `<option value="${a.id}"${sel ? ' selected' : ''}>${a.label}</option>`;
      }).join('')}</select></div>`,
    (ov) => {
      const title = qInput(ov, '#t-title').value.trim();
      if (!title) { toast('Title is required'); return false; }
      const newStatus = qSelect(ov, '#t-status').value as TaskStatus;
      if (newStatus !== task.status) {
        (task.activityLog ??= []).push({
          timestamp: now(),
          agent: 'Manual',
          action: `changed status from ${task.status} to ${newStatus}`,
        });
        if (newStatus === 'done') task.completedAt = now();
      }
      const newAgentId = qSelect(ov, '#t-agent').value;
      task.title = title;
      task.description = qTextarea(ov, '#t-desc').value.trim();
      task.status = newStatus;
      task.priority = qSelect(ov, '#t-priority').value as TaskPriority;
      task.agentId = newAgentId;
      task.aiAgent = getAgent(newAgentId).label;
      task.updatedAt = now();
      getProject(activeProjectId)?.tasks.forEach(autoEscalate);
      scheduleSave();
      renderSidebar();
      renderTaskList();
      if (selectedTaskPath?.join('/') === path.join('/')) renderDetail();
    },
    'Save'
  );
}

// ─── AGENT MANAGER ─────────────────────────────────────────────────────────
export function showAgentManagerModal(): void {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  document.body.appendChild(ov);

  const rerender = (): void => {
    const agents = getAllAgents();
    ov.innerHTML = `<div class="modal" style="max-width:640px;width:92vw">
      <div class="modal-title">⚙ Agent Manager</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:380px;overflow-y:auto;padding-right:2px">
        ${agents.map((a) => `
          <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm)${a.enabled ? '' : ';opacity:0.5'}">
            <input type="checkbox" style="cursor:pointer;width:16px;height:16px;flex-shrink:0" data-id="${a.id}" data-action="toggle"${a.enabled ? ' checked' : ''}>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span style="font-weight:600;font-size:13px">${esc(a.label)}</span>
                <span style="font-size:10px;padding:1px 5px;border-radius:3px;${a.provider === 'claude' ? 'background:#1e3a5f;color:#60a5fa' : 'background:var(--surface3);color:var(--text-muted)'}">${a.provider}</span>
                ${a.defaultModel ? `<span style="font-size:10px;color:var(--text-muted)">${esc(modelShortName(a.defaultModel))}</span>` : ''}
              </div>
              ${a.systemPrompt ? `<div style="font-size:11px;color:var(--text-dim);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px">${esc(a.systemPrompt.slice(0, 80))}${a.systemPrompt.length > 80 ? '…' : ''}</div>` : ''}
            </div>
            <button class="task-action-btn" data-id="${a.id}" data-action="edit" style="flex-shrink:0">✏️</button>
            <button class="task-action-btn danger" data-id="${a.id}" data-action="delete" style="flex-shrink:0"${DEFAULT_AGENT_IDS.has(a.id) ? ' disabled title="Built-in agents cannot be deleted"' : ''}>🗑</button>
          </div>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="modal-btn primary" id="agm-add">＋ Add Agent</button>
        <button class="modal-btn" id="agm-close">Close</button>
      </div>
    </div>`;

    qBtn(ov, '#agm-close').addEventListener('click', () => document.body.removeChild(ov));
    qBtn(ov, '#agm-add').addEventListener('click', () =>
      showAgentEditModal(null, () => { scheduleSave(); refreshAgentFilter(); rerender(); })
    );
    ov.addEventListener('click', (e) => { if (e.target === ov) document.body.removeChild(ov); });

    ov.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
      const id = el.dataset.id || '';
      const action = el.dataset.action;
      if (action === 'toggle') {
        el.addEventListener('change', () => {
          // CRUD now goes through Rust IPC. Fire-and-forget but surface
          // failures so the toggle never silently desyncs from disk.
          agentUpdate(id, { enabled: (el as HTMLInputElement).checked })
            .then(() => { scheduleSave(); refreshAgentFilter(); rerender(); })
            .catch((e: unknown) => toast('❌ ' + (e instanceof Error ? e.message : String(e))));
        });
      } else if (action === 'edit') {
        el.addEventListener('click', () =>
          showAgentEditModal(id, () => { scheduleSave(); refreshAgentFilter(); rerender(); })
        );
      } else if (action === 'delete') {
        el.addEventListener('click', () => {
          agentRemove(id)
            .then(() => {
              scheduleSave();
              refreshAgentFilter();
              rerender();
              toast('🗑 Agent removed');
            })
            .catch((e: unknown) => toast('❌ ' + (e instanceof Error ? e.message : String(e))));
        });
      }
    });
  };

  rerender();
}

export function showAgentEditModal(agentId: string | null, onSaved: () => void): void {
  const isNew = agentId === null;
  const a: Agent = isNew
    ? {
        id: '',
        label: '',
        provider: 'claude',
        defaultModel: 'claude-sonnet-4-6',
        capabilities: [],
        enabled: true,
        systemPrompt: '',
      }
    : { ...getAgent(agentId) };

  const modelOptsHtml = MODEL_OPTIONS.map((o) =>
    `<option value="${o.id}"${o.id === a.defaultModel ? ' selected' : ''}>${o.label}</option>`
  ).join('');

  showModal(
    `
    <div class="modal-title">${isNew ? '＋ Add Agent' : 'Edit: ' + esc(a.label)}</div>
    ${isNew ? `<div class="modal-field"><label class="modal-label">ID <span style="font-size:10px;color:var(--text-muted)">(unique, lowercase, hyphens ok)</span></label>
      <input class="modal-input" id="ae-id" value="" placeholder="e.g. my-agent" style="font-family:monospace"></div>` : ''}
    <div class="modal-field"><label class="modal-label">Label</label>
      <input class="modal-input" id="ae-label" value="${esc(a.label)}" placeholder="Display name…"></div>
    <div class="modal-field"><label class="modal-label">Provider</label>
      <select class="modal-select" id="ae-provider"${!isNew && agentId !== null && DEFAULT_AGENT_IDS.has(agentId) ? ' disabled' : ''}>
        <option value="claude"${a.provider === 'claude' ? ' selected' : ''}>claude</option>
        <option value="manual"${a.provider === 'manual' ? ' selected' : ''}>manual</option>
      </select></div>
    <div class="modal-field"><label class="modal-label">Default Model</label>
      <select class="modal-select" id="ae-model">
        <option value="">— none —</option>
        ${modelOptsHtml}
      </select></div>
    <div class="modal-field"><label class="modal-label">System Prompt <span style="font-size:10px;color:var(--text-muted)">(optional — prepended to every run)</span></label>
      <textarea class="modal-textarea" id="ae-sysprompt" style="min-height:100px;font-family:monospace;font-size:12px">${esc(a.systemPrompt || '')}</textarea></div>`,
    (ov) => {
      const label = qInput(ov, '#ae-label').value.trim();
      if (!label) { toast('Label is required'); return false; }
      const systemPrompt = qTextarea(ov, '#ae-sysprompt').value;
      const defaultModel = qSelect(ov, '#ae-model').value || null;

      // CRUD is now async (Rust round-trip). The showModal contract still
      // expects a sync confirm callback, so we fire-and-forget here and
      // surface any error via toast — the modal closes optimistically.
      if (isNew) {
        const id = qInput(ov, '#ae-id').value.trim().replace(/\s+/g, '-').toLowerCase();
        if (!id) { toast('ID is required'); return false; }
        if (getAllAgents().find((x) => x.id === id)) { toast('Agent ID already exists'); return false; }
        agentAdd({
          id,
          label,
          provider: qSelect(ov, '#ae-provider').value as AgentProvider,
          defaultModel,
          capabilities: [],
          enabled: true,
          systemPrompt,
        })
          .then(() => onSaved())
          .catch((e: unknown) => toast('❌ ' + (e instanceof Error ? e.message : String(e))));
      } else {
        const patch: Partial<Agent> = { label, systemPrompt, defaultModel };
        if (agentId !== null && !DEFAULT_AGENT_IDS.has(agentId)) {
          patch.provider = qSelect(ov, '#ae-provider').value as AgentProvider;
        }
        if (agentId !== null) {
          agentUpdate(agentId, patch)
            .then(() => onSaved())
            .catch((e: unknown) => toast('❌ ' + (e instanceof Error ? e.message : String(e))));
        } else {
          onSaved();
        }
      }
    },
    isNew ? 'Add' : 'Save'
  );
}

export function confirmDeleteTask(path: string[]): void {
  const task = findTaskByPath(path);
  if (!task) return;
  showModal(
    `<div class="modal-title">Delete Task</div><p style="color:var(--text-dim);font-size:13px">Delete <strong>${esc(task.title)}</strong>${(task.subtasks || []).length ? ' and all subtasks' : ''}?</p>`,
    () => {
      const proj = getProject(activeProjectId);
      if (!proj) return false;
      if (path.length === 1) {
        proj.tasks = proj.tasks.filter((t) => t.id !== path[0]);
      } else {
        const parent = findTaskByPath(path.slice(0, -1));
        if (parent) parent.subtasks = (parent.subtasks || []).filter((t) => t.id !== path[path.length - 1]);
      }
      if (selectedTaskPath?.join('/').startsWith(path.join('/'))) {
        setSelectedTaskPath(null);
        const panel = document.getElementById('detail-panel');
        if (panel) panel.style.display = 'none';
      }
      scheduleSave();
      renderSidebar();
      renderTaskList();
      toast('🗑 Task deleted');
    },
    'Delete',
    true
  );
}
