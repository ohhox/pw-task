// ─── MODALS / PROJECT ────────────────────────────────────────────────────────
// Project CRUD modals: add, edit, delete, CLAUDE.md copy.
import { db, baseDir, activeProjectId, setActiveProjectId, setSelectedTaskPath } from './state.js';
import { esc, now, uuid, toast, getProject } from './data.js';
import { getEnabledAgents } from './agents/index.js';
import { scheduleSave } from './fileops.js';
import { renderSidebar, renderProject } from './render.js';
import { showModal, qInput, qSelect, qTextarea, qBtn } from './modals-shared.js';
import type { Project } from '../types/domain';

// ─── Color picker ─────────────────────────────────────────────────────────────

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

// ─── CLAUDE.md generator ──────────────────────────────────────────────────────

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
