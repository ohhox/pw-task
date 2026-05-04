// ─── AI ──────────────────────────────────────────────────────────────────────
// Owns: Claude run flow (streaming, session resume, review/re-run) and project planning.
// Does NOT: choose provider directly — delegates to execution-service.ts.
import { getLogger } from '../logger.js';
import {
  baseDir, activeProjectId, activeRuns, setSelectedTaskPath,
} from './state.js';
import {
  esc, now, uuid, toast, isFullyDone, joinPath, safePathJoin, isSafeTaskId,
  patchFileName, getProject, findTaskByPath, findNextRunnablePath,
} from './data.js';
import {
  tauriListen, tauriWriteText, tauriCreateDir,
} from './api.js';
import { getAgent, getTaskAgentLabel, resolveAgentId } from './agents/index.js';
import { runTaskWithAgent, planProjectWithAgent } from './agents/execution-service.js';
import { scheduleSave, applyPatches } from './fileops.js';
import { renderSidebar, renderTaskList, renderProject } from './render.js';
import { renderDetail } from './detail.js';
import { openWorkspace } from './main.js';
import type { Task, TaskStatus, TaskPriority, Project, Patch, ModelId } from '../types/domain';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const log = getLogger('ai');

// ─── Run flow ────────────────────────────────────────────────────────────

interface RunClaudeInput {
  task: Task;
  prompt: string;
  sessionId: string | null;
  playBtn: HTMLButtonElement | null;
  statusEl: HTMLElement | null;
  terminal: HTMLElement;
  onDone?: (() => void) | null;
  prevStatus?: TaskStatus;
}

interface RunEntry {
  runId: string;
  lines: string[];
  uiRefs: {
    playBtn: HTMLButtonElement | null;
    statusEl: HTMLElement | null;
    terminal: HTMLElement | null;
  };
}

// prevStatus: status before run — passed by playTask so we can revert if run fails
export async function runClaude({
  task, prompt, sessionId, playBtn, statusEl, terminal, onDone, prevStatus,
}: RunClaudeInput): Promise<void> {
  const proj = getProject(activeProjectId);

  if (playBtn) { playBtn.disabled = true; playBtn.classList.add('running'); playBtn.textContent = '⏳ Running…'; }
  terminal.style.display = '';
  terminal.innerHTML = '<span style="color:var(--text-muted)">Starting…\n</span>';
  if (statusEl) statusEl.textContent = '⏳ Running…';

  const revertStatus = (): void => {
    if (prevStatus !== undefined && task.status === 'in_progress') {
      task.status = prevStatus;
      task.updatedAt = now();
      scheduleSave(); renderSidebar(); renderTaskList();
    }
  };

  const runId = uuid();
  const runEntry: RunEntry = { runId, lines: [], uiRefs: { playBtn, statusEl, terminal } };
  activeRuns.set(task.id, runEntry);
  renderTaskList();

  const appendLine = (line: string): void => {
    runEntry.lines.push(line);
    const t = runEntry.uiRefs.terminal;
    if (!t) return;
    const span = document.createElement('span');
    span.className = 'out-line';
    span.textContent = line + '\n';
    t.appendChild(span);
    t.scrollTop = t.scrollHeight;
  };

  const unlistenLine = await tauriListen<string>(`run-line:${runId}`, (e) => appendLine(e.payload ?? ''));

  const cleanup = (): void => {
    activeRuns.delete(task.id);
    renderTaskList();
  };

  try {
    const exResult = await runTaskWithAgent({
      task, prompt,
      sessionId: sessionId || null,
      workingDir: proj?.workingDir || null,
      runId,
    });
    unlistenLine();

    if (!exResult.ok) {
      cleanup();
      revertStatus();
      const { statusEl: se, playBtn: pb } = runEntry.uiRefs;
      if (se) se.textContent = '❌ ' + exResult.error;
      if (pb) { pb.classList.remove('running'); pb.textContent = '▶ Run'; pb.disabled = false; }
      return;
    }

    const { output = '', sessionId: sid, agentId, model, usage } = exResult;
    if (sid) task.lastSessionId = sid;
    if (agentId) task.agentId = agentId;

    const runTs = now();
    const summary = output.trim().slice(0, 300).replace(/\s+/g, ' ') + (output.length > 300 ? '…' : '');

    // Save full output to runs/ dir
    let outputFile: string | null = null;
    if (baseDir && output.trim() && isSafeTaskId(task.id)) {
      const safeTs = runTs.replace(/[:.]/g, '-');
      outputFile = `runs/${task.id}_${safeTs}.json`;
      try {
        await tauriCreateDir(joinPath(baseDir, 'runs')).catch(() => {});
        await tauriWriteText(safePathJoin(baseDir, outputFile), JSON.stringify({
          taskId: task.id, timestamp: runTs, model, agentId, sessionId: sid, output,
        }, null, 2));
      } catch (e) {
        log.warn('run output save failed', { error: errMsg(e) });
        outputFile = null;
      }
    }

    task.lastNote = { timestamp: runTs, agent: getAgent(agentId).label, summary };
    task.status = 'pending_review';
    task.updatedAt = runTs;
    (task.activityLog = task.activityLog || []).push({
      timestamp: runTs, agent: getAgent(agentId).label,
      action: `run completed → pending_review${sid ? ' · sid:' + sid.slice(0, 8) : ''}`,
    });
    (task.runHistory = task.runHistory || []).push({
      timestamp: runTs, model, agentId, summary, sessionId: sid, outputFile,
      ...(usage != null ? { tokens: usage } : {}),
    });
    cleanup();
    scheduleSave(); renderSidebar(); renderTaskList();

    const { statusEl: se, playBtn: pb } = runEntry.uiRefs;
    if (se) se.textContent = '✅ Done';
    if (pb) { pb.classList.remove('running'); pb.textContent = '▶ Run Again'; pb.disabled = false; }
    if (onDone) onDone();
  } catch (e) {
    unlistenLine();
    cleanup();
    revertStatus();
    const { statusEl: se, playBtn: pb } = runEntry.uiRefs;
    if (se) se.textContent = '❌ ' + errMsg(e);
    if (pb) { pb.classList.remove('running'); pb.textContent = '▶ Run'; pb.disabled = false; }
  }
}

export async function playTask(
  task: Task,
  playBtn: HTMLButtonElement | null,
  statusEl: HTMLElement | null,
  terminal: HTMLElement
): Promise<void> {
  // Block concurrent runs of the same task
  if (activeRuns.has(task.id)) {
    toast('⚠️ Task นี้กำลังรันอยู่');
    return;
  }
  // Block manual agent before touching any state
  if (getAgent(resolveAgentId(task)).provider === 'manual') {
    toast('⚠️ Manual tasks cannot be auto-run');
    return;
  }

  const prevStatus = task.status;
  if (task.status === 'todo' || task.status === 'pending_review') {
    task.status = 'in_progress';
    task.updatedAt = now();
    const agentLabel = getTaskAgentLabel(task);
    (task.activityLog = task.activityLog || []).push({
      timestamp: now(), agent: agentLabel,
      action: `started run (${agentLabel})`,
    });
    scheduleSave(); renderSidebar(); renderTaskList();
  }
  await runClaude({
    task, prompt: task.prompt || '', sessionId: null,
    playBtn, statusEl, terminal, prevStatus,
  });
}

export async function quickPlay(rootPath: string[]): Promise<void> {
  const rootTask = findTaskByPath(rootPath);
  if (!rootTask) return;

  const nextPath = findNextRunnablePath(rootTask, rootPath) || rootPath;
  const targetTask = findTaskByPath(nextPath);
  if (!targetTask) return;

  if (!targetTask.prompt?.trim()) { toast('⚠️ Task นี้ไม่มี Prompt'); return; }
  if (getAgent(resolveAgentId(targetTask)).provider === 'manual') { toast('⚠️ Manual task ไม่สามารถ auto-run ได้'); return; }
  if (isFullyDone(rootTask)) { toast('✅ Task ทุก subtask เสร็จแล้ว'); return; }

  // Select task and open detail panel
  document.querySelectorAll('#task-list .task-row.selected').forEach((r) => r.classList.remove('selected'));
  const row = document.querySelector(`#task-list .task-row[data-path="${CSS.escape(nextPath.join('/'))}"]`);
  if (row) row.classList.add('selected');
  setSelectedTaskPath(nextPath);
  openWorkspace();
  renderDetail();

  // Trigger the play button rendered by renderDetail
  const playBtn = document.querySelector<HTMLButtonElement>('#detail-body .play-btn');
  if (playBtn && !playBtn.disabled) playBtn.click();
}

// ─── Plan AI output parser ───────────────────────────────────────────────

interface PlannedTask {
  title: string;
  description?: string;
  priority?: TaskPriority;
  model?: ModelId | string;
  prompt?: string;
}

export function parsePlanOutput(output: string): PlannedTask[] {
  const blockMatch = output.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (blockMatch) {
    try {
      const a: unknown = JSON.parse(blockMatch[1]);
      if (Array.isArray(a)) return a.filter((t): t is PlannedTask => !!t?.title);
    } catch {}
  }
  const arrMatch = output.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const a: unknown = JSON.parse(arrMatch[0]);
      if (Array.isArray(a)) return a.filter((t): t is PlannedTask => !!t?.title);
    } catch {}
  }
  return [];
}

export async function planProject(proj: Project): Promise<void> {
  if (!proj.goal) { toast('⚠️ กรุณาใส่ Goal ใน Project ก่อน (✏️ Edit)'); return; }
  if (!baseDir) { toast('⚠️ ยังไม่ได้เลือก folder'); return; }

  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal" style="max-width:600px;width:92vw">
    <div class="modal-title">✨ AI Planning: ${esc(proj.name)}</div>
    <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-bottom:10px">🎯 ${esc(proj.goal)}</div>
    <div id="plan-terminal" class="output-terminal" style="min-height:180px;max-height:320px"></div>
    <div id="plan-status" style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:8px">⏳ กำลังวางแผน…</div>
    <div class="modal-actions">
      <button class="modal-btn" id="plan-close" disabled>Close</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const terminal = ov.querySelector<HTMLElement>('#plan-terminal');
  const statusEl = ov.querySelector<HTMLElement>('#plan-status');
  const closeBtn = ov.querySelector<HTMLButtonElement>('#plan-close');
  if (!terminal || !statusEl || !closeBtn) return;

  const runId = uuid();
  const planPrompt = `You are an AI project planner. Create a development task list for this project.

Project: ${proj.name}
Goal: ${proj.goal}${proj.workingDir ? '\nWorking directory: ' + proj.workingDir : ''}${proj.description ? '\nDescription: ' + proj.description : ''}

Output ONLY a JSON array. No markdown, no explanation, just the JSON array.
Each task must have exactly these fields:
{
  "id": "task-1",
  "title": "Task title",
  "description": "Detailed description",
  "priority": "high" | "medium" | "low",
  "model": "claude-haiku-4-5-20251001" | "claude-sonnet-4-6" | "claude-opus-4-7",
  "prompt": "The exact prompt to give Claude to complete this task"
}`;

  const unlistenLine = await tauriListen<string>(`run-line:${runId}`, (e) => {
    const line = e.payload ?? '';
    const span = document.createElement('span');
    span.className = 'out-line';
    span.textContent = line + '\n';
    terminal.appendChild(span);
    terminal.scrollTop = terminal.scrollHeight;
  });

  try {
    const exResult = await planProjectWithAgent({ project: proj, prompt: planPrompt, runId });
    unlistenLine();

    if (!exResult.ok) {
      statusEl.textContent = '❌ ' + (exResult.error || 'unknown error');
      closeBtn.disabled = false;
      return;
    }

    statusEl.textContent = '🔍 Parsing tasks…';
    const tasks = parsePlanOutput(exResult.output || '');

    if (!tasks.length) {
      statusEl.textContent = '⚠️ ไม่พบ JSON tasks ใน output — ลอง Plan ใหม่';
      closeBtn.disabled = false;
      return;
    }

    const patchTs = new Date().toISOString();
    const executorId = proj.agentDefaults?.executor || 'executor';
    const patch: Patch = {
      version: '1.0',
      timestamp: patchTs,
      agent: 'Claude (Plan)',
      changes: tasks.map((t) => {
        const task: Task = {
          id: uuid(),
          title: t.title,
          description: t.description || '',
          status: 'todo',
          priority: (t.priority || 'medium') as TaskPriority,
          agentId: executorId,
          aiAgent: getAgent(executorId).label,
          model: t.model || 'claude-sonnet-4-6',
          prompt: t.prompt || '',
          tags: [],
          reviews: [],
          subtasks: [],
          filesModified: [],
          lastSessionId: null,
          runHistory: [],
          createdAt: patchTs,
          activityLog: [{ timestamp: patchTs, agent: 'Claude (Plan)', action: 'created by ✨ Plan AI' }],
        };
        return {
          type: 'add_task' as const,
          projectId: proj.id,
          parentTaskId: null as string | null,
          task,
        };
      }),
    };

    await tauriWriteText(joinPath(joinPath(baseDir, 'patches'), patchFileName('PlanAI')), JSON.stringify(patch, null, 2));
    await applyPatches();
    renderSidebar();
    renderProject();
    statusEl.textContent = `✅ สร้าง ${tasks.length} tasks สำเร็จ!`;
    toast(`✨ Plan สำเร็จ! สร้าง ${tasks.length} tasks`);
  } catch (e) {
    unlistenLine();
    statusEl.textContent = '❌ ' + errMsg(e);
  }

  closeBtn.disabled = false;
  closeBtn.addEventListener('click', () => { if (document.body.contains(ov)) document.body.removeChild(ov); });
  ov.addEventListener('click', (e) => { if (e.target === ov && !closeBtn.disabled) document.body.removeChild(ov); });
}
