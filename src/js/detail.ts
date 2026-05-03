// ─── DETAIL / WORKSPACE ──────────────────────────────────────────────────────
// Owns: workspace rendering and inline field editing for the selected task.
import {
  activeProjectId, selectedTaskPath, baseDir, activeRuns,
  setSelectedTaskPath
} from './state.js';
import {
  esc, now, toast, fmtDate, statusLabel, modelShortName, modelBadgeClass,
  MODEL_OPTIONS, renderMd, getProject, findTaskByPath, autoEscalate,
  countAll, countDone, safePathJoin
} from './data.js';
import { tauriReadText } from './api.js';
import { getEnabledAgents, getAgent } from './agents/registry.js';
import { legacyToAgentId } from './agents/legacy-mapping.js';
import { resolveAgentId } from './agents/routing.js';
import { scheduleSave } from './fileops.js';
import { runClaude, playTask } from './ai.js';
import { renderSidebar, renderTaskList } from './render.js';
import { $, $maybe } from './dom.js';
import type { TaskStatus, TaskPriority } from '../types/domain';

export function renderDetail() {
  if (!selectedTaskPath) return;
  const taskPath = selectedTaskPath; // narrowed local to avoid repeated null checks below
  const task = findTaskByPath(taskPath);
  if (!task) return;
  const proj = getProject(activeProjectId);
  const body = $('detail-body');
  $('detail-title-text').textContent = task.title;
  const projNameEl = $maybe('ws-proj-name');
  if (projNameEl) projNameEl.textContent = proj?.name || '';
  body.innerHTML = '';

  // ── local helpers ──────────────────────────────────────────────────────
  const mkChipSel = (
    opts: string[],
    cur: string,
    labels: string[],
    cls: string,
    onChange: (v: string) => void
  ): HTMLSelectElement => {
    const sel = document.createElement('select');
    sel.className = 'ws-chip ' + cls; sel.dataset.v = cur;
    opts.forEach((o: string, i: number) => {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = labels[i];
      if (o === cur) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => { sel.dataset.v = sel.value; onChange(sel.value); });
    return sel;
  };
  const mkAcc = (
    labelHtml: string,
    startOpen: boolean,
    fill: (el: HTMLElement) => void
  ): HTMLDivElement => {
    const wrap = document.createElement('div'); wrap.className = 'ws-accordion';
    const btn = document.createElement('button'); btn.className = 'ws-accordion-btn';
    const bodyEl = document.createElement('div'); bodyEl.className = 'ws-accordion-body';
    let open = startOpen;
    const upd = () => {
      btn.innerHTML = `<span>${open ? '▼' : '▶'}</span><span style="flex:1">${labelHtml}</span>`;
      bodyEl.style.display = open ? '' : 'none';
    };
    btn.addEventListener('click', () => { open = !open; upd(); });
    fill(bodyEl); upd();
    wrap.appendChild(btn); wrap.appendChild(bodyEl);
    return wrap;
  };
  const sep = () => { const hr = document.createElement('hr'); hr.className = 'ws-sep'; return hr; };

  // ── breadcrumb (subtask navigation) ────────────────────────────────────
  if (selectedTaskPath.length > 1) {
    const bc = document.createElement('div');
    bc.style.cssText = 'font-size:var(--fs-xs);color:var(--text-muted);margin-bottom:12px;display:flex;align-items:center;gap:6px';
    const up = document.createElement('button');
    up.style.cssText = 'font-size:var(--fs-xs);background:none;border:none;color:var(--accent);cursor:pointer;padding:0';
    up.textContent = '↑ Parent task';
    up.addEventListener('click', () => { setSelectedTaskPath(taskPath.slice(0, -1)); renderDetail(); });
    bc.appendChild(up);
    body.appendChild(bc);
  }

  // ── title ──────────────────────────────────────────────────────────────
  const titleInput = document.createElement('input');
  titleInput.className = 'ws-title-input'; titleInput.value = task.title; titleInput.spellcheck = false;
  titleInput.addEventListener('change', () => {
    task.title = titleInput.value; task.updatedAt = now();
    $('detail-title-text').textContent = task.title;
    scheduleSave(); renderTaskList(); renderSidebar();
  });
  body.appendChild(titleInput);

  // ── toolbar ────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div'); toolbar.className = 'ws-toolbar';

  const statusChip = mkChipSel(
    ['todo','in_progress','pending_review','done','blocked'], task.status,
    ['Todo','In Progress','Pending Review','Done','Blocked'], 'ws-status-chip',
    (v: string) => {
      const old = task.status; task.status = v as TaskStatus; task.updatedAt = now();
      if (v==='done') task.completedAt = now();
      (task.activityLog||=[]).push({ timestamp:now(), agent:'Manual', action:`changed status from ${old} to ${v}` });
      getProject(activeProjectId)?.tasks.forEach(autoEscalate);
      scheduleSave(); renderSidebar(); renderTaskList(); renderDetail();
    }
  );
  const priorityChip = mkChipSel(
    ['low','medium','high'], task.priority || 'medium', ['Low','Medium','High'], 'ws-priority-chip',
    (v: string) => { task.priority = v as TaskPriority; task.updatedAt = now(); scheduleSave(); renderTaskList(); }
  );
  const agentOpts = getEnabledAgents();
  const agentChip = mkChipSel(
    agentOpts.map(a => a.id), task.agentId || legacyToAgentId(task.aiAgent || 'Claude'),
    agentOpts.map(a => a.label), 'ws-agent-chip',
    v => { task.agentId = v; task.aiAgent = getAgent(v).label; task.updatedAt = now(); scheduleSave(); renderTaskList(); }
  );
  const curAgent = getAgent(task.agentId || legacyToAgentId(task.aiAgent || 'Claude'));
  const mOpts = [{ id:'', label:`auto (${modelShortName(curAgent.defaultModel||'claude-sonnet-4-6')})` }, ...MODEL_OPTIONS];
  const modelChip = mkChipSel(
    mOpts.map(o => o.id), task.model || '', mOpts.map(o => o.label), 'ws-model-chip',
    v => { task.model = v || null; task.updatedAt = now(); scheduleSave(); renderTaskList(); }
  );
  const idBtn = document.createElement('button'); idBtn.className = 'ws-id-btn';
  idBtn.textContent = task.id; idBtn.title = 'Copy task ID';
  idBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(task.id).then(() => { idBtn.textContent = '✓ Copied'; setTimeout(() => { idBtn.textContent = task.id; }, 1500); });
  });
  toolbar.appendChild(statusChip); toolbar.appendChild(priorityChip);
  toolbar.appendChild(agentChip); toolbar.appendChild(modelChip);
  const sp = document.createElement('span'); sp.style.flex = '1'; toolbar.appendChild(sp);
  toolbar.appendChild(idBtn);
  body.appendChild(toolbar);

  // ── description accordion ──────────────────────────────────────────────
  let editingDesc = false;
  body.appendChild(mkAcc('Description', !!(task.description), el => {
    const mdView = document.createElement('div'); mdView.className = 'md-view'; mdView.innerHTML = renderMd(task.description);
    const mdEdit = document.createElement('textarea'); mdEdit.className = 'md-textarea'; mdEdit.value = task.description||''; mdEdit.style.display='none';
    const editBtn = document.createElement('button'); editBtn.className = 'md-toggle-btn'; editBtn.textContent = '✏️ Edit'; editBtn.style.marginBottom = '8px';
    editBtn.addEventListener('click', () => {
      editingDesc = !editingDesc;
      if (editingDesc) { mdView.style.display='none'; mdEdit.style.display=''; editBtn.textContent='💾 Save'; }
      else { task.description = mdEdit.value; task.updatedAt=now(); scheduleSave(); mdView.innerHTML = renderMd(task.description); mdView.style.display=''; mdEdit.style.display='none'; editBtn.textContent='✏️ Edit'; }
    });
    el.appendChild(editBtn); el.appendChild(mdView); el.appendChild(mdEdit);
  }));

  // ── subtasks accordion ─────────────────────────────────────────────────
  const subs = task.subtasks || [];
  if (subs.length) {
    const doneCount = countDone(subs), totalCount = countAll(subs);
    const pct = totalCount ? Math.round(doneCount/totalCount*100) : 0;
    body.appendChild(mkAcc(
      `Subtasks <span class="ws-acc-extra">${doneCount}/${totalCount} · ${pct}%</span>`,
      true, el => {
        const prog = document.createElement('div');
        prog.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:12px';
        prog.innerHTML = `<div class="progress-bar-bg" style="flex:1;max-width:none"><div class="progress-bar-fill" style="width:${pct}%"></div></div><span class="progress-text">${pct}%</span>`;
        el.appendChild(prog);
        subs.forEach(sub => {
          const row = document.createElement('div'); row.className = 'ws-sub-row';
          const pulse = activeRuns.has(sub.id) ? '<span class="running-pulse"></span>' : '';
          row.innerHTML = `${pulse}<span class="badge status-${sub.status}" style="flex-shrink:0">${statusLabel(sub.status)}</span><span style="font-size:var(--fs-sm);flex:1;${sub.status==='done'?'text-decoration:line-through;color:var(--text-muted)':''}">${esc(sub.title)}</span>`;
          row.addEventListener('click', () => { setSelectedTaskPath([...taskPath, sub.id]); renderDetail(); });
          el.appendChild(row);
        });
      }
    ));
  }

  body.appendChild(sep());

  // ── prompt ──────────────────────────────────────────────────────────────
  const pLabel = document.createElement('div'); pLabel.className = 'ws-section-label'; pLabel.textContent = 'Prompt';
  body.appendChild(pLabel);

  const promptArea = document.createElement('textarea');
  promptArea.className = 'ws-prompt-area'; promptArea.value = task.prompt || '';
  promptArea.placeholder = 'คำสั่งสำหรับ Claude รัน task นี้…';
  body.appendChild(promptArea);

  // ── run controls ───────────────────────────────────────────────────────
  const runRow = document.createElement('div'); runRow.className = 'ws-run-row';
  const playBtn = document.createElement('button'); playBtn.className = 'play-btn';
  const isManual = getAgent(resolveAgentId(task)).provider === 'manual';
  if (isManual) { playBtn.textContent = '⊘ Manual'; playBtn.disabled = true; }
  else { playBtn.textContent = '▶ Run'; playBtn.disabled = !task.prompt?.trim(); }
  const runStatusEl = document.createElement('span'); runStatusEl.className = 'run-status-text';
  runStatusEl.textContent = task.lastNote ? `Last: ${fmtDate(task.lastNote.timestamp)}` : '';
  runRow.appendChild(playBtn); runRow.appendChild(runStatusEl);
  body.appendChild(runRow);

  const terminal = document.createElement('div');
  terminal.className = 'ws-terminal'; terminal.style.display = 'none';
  body.appendChild(terminal);

  promptArea.addEventListener('input', () => {
    task.prompt = promptArea.value; task.updatedAt = now(); scheduleSave();
    playBtn.disabled = !promptArea.value.trim();
  });
  playBtn.addEventListener('click', async () => {
    if (playBtn.disabled) return;
    if (!task.prompt?.trim()) { toast('⚠️ กรุณาใส่ Prompt ก่อน'); return; }
    await playTask(task, playBtn, runStatusEl, terminal);
  });

  // reconnect active run
  const runEntry = activeRuns.get(task.id);
  if (runEntry) {
    terminal.style.display = '';
    runEntry.lines.forEach(line => { const s = document.createElement('span'); s.className='out-line'; s.textContent=line+'\n'; terminal.appendChild(s); });
    terminal.scrollTop = terminal.scrollHeight;
    runEntry.uiRefs = { playBtn, statusEl: runStatusEl, terminal };
    playBtn.disabled = true; playBtn.classList.add('running'); playBtn.textContent = '⏳ Running…';
    runStatusEl.textContent = '⏳ Running…';
  }

  // ── last note ──────────────────────────────────────────────────────────
  if (task.lastNote) {
    const lastNote = task.lastNote;
    body.appendChild(sep());
    body.appendChild(mkAcc('Last Session Note', false, (el) => {
      const nd = document.createElement('div'); nd.className = 'detail-last-note';
      const nm = document.createElement('div'); nm.className = 'detail-last-note-meta';
      nm.textContent = `${lastNote.agent} · ${fmtDate(lastNote.timestamp)}`;
      const mdEl = document.createElement('div'); mdEl.className = 'md-view note-md';
      mdEl.innerHTML = renderMd(lastNote.summary || '');
      nd.appendChild(nm); nd.appendChild(mdEl); el.appendChild(nd);
    }));
  }

  // ── run history ────────────────────────────────────────────────────────
  const runHist = (task.runHistory || []).filter(r => r.timestamp);
  if (runHist.length) {
    body.appendChild(mkAcc(`Run History <span class="ws-acc-extra">${runHist.length} run${runHist.length > 1 ? 's' : ''}</span>`, false, el => {
      runHist.slice().reverse().forEach(run => {
        const item = document.createElement('div'); item.className = 'run-history-item';
        const meta = document.createElement('div'); meta.className = 'run-history-meta';
        meta.innerHTML = `<span>${esc(fmtDate(run.timestamp))}</span>${run.model ? `<span class="badge ${modelBadgeClass(run.model)}">${esc(modelShortName(run.model))}</span>` : ''}${run.agentId ? `<span class="badge agent-badge">${esc(getAgent(run.agentId).label)}</span>` : ''}${run.sessionId ? `<span style="font-family:monospace;font-size:10px;color:var(--text-muted)">sid:${esc(String(run.sessionId).slice(0,8))}</span>` : ''}`;
        const sumEl = document.createElement('div'); sumEl.className = 'run-history-summary';
        sumEl.textContent = run.summary || '';
        item.appendChild(meta); item.appendChild(sumEl);

        if (run.outputFile) {
          const viewBtn = document.createElement('button'); viewBtn.className = 'run-view-btn';
          viewBtn.textContent = '📄 View Full Output';
          const outDiv = document.createElement('div'); outDiv.className = 'ws-terminal run-output-terminal';
          outDiv.style.cssText = 'display:none;margin-top:8px;white-space:pre-wrap';
          viewBtn.addEventListener('click', async () => {
            if (outDiv.style.display !== 'none') {
              outDiv.style.display = 'none'; viewBtn.textContent = '📄 View Full Output'; return;
            }
            viewBtn.textContent = '⏳ Loading…'; viewBtn.disabled = true;
            try {
              if (!baseDir || !run.outputFile) throw new Error('No baseDir or outputFile');
              const text = await tauriReadText(safePathJoin(baseDir, run.outputFile));
              const data = JSON.parse(text);
              outDiv.textContent = data.output || '(empty)';
            } catch(e) { outDiv.textContent = '❌ ' + String(e); }
            outDiv.style.display = ''; viewBtn.textContent = '▲ Hide Output'; viewBtn.disabled = false;
            outDiv.scrollTop = 0;
          });
          item.appendChild(viewBtn); item.appendChild(outDiv);
        }
        el.appendChild(item);
      });
    }));
  }

  // ── review panel ───────────────────────────────────────────────────────
  if (task.status === 'pending_review') {
    body.appendChild(sep());
    const reviewSec = document.createElement('div');
    const panel = document.createElement('div'); panel.className = 'review-panel';
    panel.innerHTML = '<div class="review-panel-title">🔍 Pending Review</div>';
    const commentArea = document.createElement('textarea'); commentArea.className = 'review-textarea';
    commentArea.placeholder = 'Review comment (optional for Approve, required for Request Changes)…';
    const btnRow = document.createElement('div'); btnRow.className = 'review-btn-row';
    const approveBtn = document.createElement('button'); approveBtn.className = 'review-btn approve'; approveBtn.textContent = '✅ Approve';
    approveBtn.addEventListener('click', () => {
      (task.reviews = task.reviews||[]).push({ timestamp:now(), action:'approved', comment:commentArea.value.trim(), reviewer:'Manual' });
      task.status = 'done'; task.completedAt = now(); task.updatedAt = now();
      (task.activityLog||=[]).push({ timestamp:now(), agent:'Manual', action:'approved → done' });
      getProject(activeProjectId)?.tasks.forEach(autoEscalate);
      scheduleSave(); renderSidebar(); renderTaskList(); renderDetail();
    });
    const requestBtn = document.createElement('button'); requestBtn.className = 'review-btn request'; requestBtn.textContent = '↩️ Request Changes';
    requestBtn.addEventListener('click', () => {
      const comment = commentArea.value.trim(); if (!comment) { toast('⚠️ กรุณาใส่ comment ก่อน'); return; }
      (task.reviews = task.reviews||[]).push({ timestamp:now(), action:'request_changes', comment, reviewer:'Manual' });
      task.status = 'in_progress'; task.updatedAt = now();
      (task.activityLog||=[]).push({ timestamp:now(), agent:'Manual', action:`requested changes: ${comment}` });
      scheduleSave(); renderSidebar(); renderTaskList(); renderDetail();
    });
    btnRow.appendChild(approveBtn); btnRow.appendChild(requestBtn);
    panel.appendChild(commentArea); panel.appendChild(btnRow);
    if (task.prompt) {
      const rerunLabel = document.createElement('div'); rerunLabel.style.cssText = 'font-size:var(--fs-xs);color:var(--text-muted);margin-top:10px;margin-bottom:5px'; rerunLabel.textContent = '🔄 Reject + Re-run:';
      panel.appendChild(rerunLabel);
      const rerunRow = document.createElement('div'); rerunRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      const freshBtn = document.createElement('button'); freshBtn.className = 'review-btn';
      freshBtn.style.cssText = 'background:rgba(96,165,250,0.1);color:var(--blue);border-color:rgba(96,165,250,0.35);flex:1'; freshBtn.textContent = '🔄 Fresh Re-run';
      const resumeBtn = document.createElement('button'); resumeBtn.className = 'review-btn';
      resumeBtn.style.cssText = 'background:rgba(167,139,250,0.1);color:#a78bfa;border-color:rgba(167,139,250,0.35);flex:1'; resumeBtn.textContent = '▶ Resume Session';
      resumeBtn.disabled = !task.lastSessionId;
      const reviewTerminal = document.createElement('div'); reviewTerminal.className = 'ws-terminal'; reviewTerminal.style.display = 'none';
      const reviewStatus = document.createElement('div'); reviewStatus.style.cssText = 'font-size:var(--fs-xs);color:var(--text-muted);margin-top:4px';
      const doRerun = async (sessionId: string | null): Promise<void> => {
        if (activeRuns.has(task.id)) { toast('⚠️ Task นี้กำลังรันอยู่'); return; }
        const comment = commentArea.value.trim();
        if (!comment && !sessionId) { toast('⚠️ กรุณาใส่ comment ก่อน'); return; }
        (task.reviews = task.reviews||[]).push({ timestamp:now(), action:'request_changes', comment:comment||'(re-run)', reviewer:'Manual' });
        task.status = 'in_progress'; task.updatedAt = now();
        (task.activityLog||=[]).push({ timestamp:now(), agent:'Manual', action:`requested changes${comment?': '+comment:''} → re-run` });
        scheduleSave(); renderSidebar(); renderTaskList();
        const taskPrompt = task.prompt || '';
        const prompt = sessionId
          ? (comment || 'Please continue and fix the issues')
          : (comment ? `FEEDBACK: ${comment}\n\n${taskPrompt}` : taskPrompt);
        freshBtn.disabled = true; resumeBtn.disabled = true; requestBtn.disabled = true; approveBtn.disabled = true;
        await runClaude({ task, prompt, sessionId, playBtn: null, statusEl: reviewStatus, terminal: reviewTerminal, prevStatus: 'pending_review', onDone: () => renderDetail() });
      };
      freshBtn.addEventListener('click', () => doRerun(null));
      resumeBtn.addEventListener('click', () => doRerun(task.lastSessionId ?? null));
      rerunRow.appendChild(freshBtn); rerunRow.appendChild(resumeBtn);
      panel.appendChild(rerunRow); panel.appendChild(reviewTerminal); panel.appendChild(reviewStatus);
    }
    reviewSec.appendChild(panel); body.appendChild(reviewSec);
  }

  // ── review history ─────────────────────────────────────────────────────
  const reviews = task.reviews || [];
  if (reviews.length) {
    body.appendChild(mkAcc(`Review History <span class="ws-acc-extra">${reviews.length}</span>`, false, el => {
      const hw = document.createElement('div'); hw.className = 'review-history';
      reviews.slice().reverse().forEach(r => {
        const item = document.createElement('div'); item.className = 'review-history-item';
        item.innerHTML = `<span class="review-action-badge ${r.action==='approved'?'approved':'requested'}">${r.action==='approved'?'✅ Approved':'↩️ Requested Changes'}</span><span class="review-meta">${fmtDate(r.timestamp)} · ${esc(r.reviewer||'—')}</span>${r.comment?`<div class="review-comment-text">${esc(r.comment)}</div>`:''}`;
        hw.appendChild(item);
      });
      el.appendChild(hw);
    }));
  }

  // ── tags & files ────────────────────────────────────────────────────────
  body.appendChild(sep());
  body.appendChild(mkAcc('Tags & Files', false, el => {
    // Tags
    const tagWrap = document.createElement('div'); tagWrap.className = 'tag-wrap'; tagWrap.style.marginBottom = '14px';
    const refreshTags = () => {
      tagWrap.innerHTML = '';
      (task.tags||[]).forEach((tag, i) => {
        const span = document.createElement('span'); span.className = 'tag';
        span.innerHTML = `#${esc(tag)} <button class="tag-remove">×</button>`;
        span.querySelector('.tag-remove')?.addEventListener('click', () => { task.tags.splice(i, 1); task.updatedAt = now(); scheduleSave(); refreshTags(); });
        tagWrap.appendChild(span);
      });
      const inp = document.createElement('input'); inp.className = 'tag-add-input'; inp.placeholder = '+ tag';
      inp.addEventListener('keydown', e => { if (e.key==='Enter' && inp.value.trim()) { (task.tags=task.tags||[]).push(inp.value.trim()); task.updatedAt=now(); scheduleSave(); refreshTags(); } });
      tagWrap.appendChild(inp);
    };
    refreshTags();
    el.appendChild(tagWrap);
    // Files
    const filesList = document.createElement('div'); filesList.className = 'files-list';
    const refreshFiles = () => {
      filesList.innerHTML = '';
      (task.filesModified||[]).forEach((f, i) => {
        const row = document.createElement('div'); row.className = 'file-item';
        row.innerHTML = `📄 ${esc(f)} <button class="file-remove">×</button>`;
        row.querySelector('.file-remove')?.addEventListener('click', () => { task.filesModified.splice(i, 1); task.updatedAt = now(); scheduleSave(); refreshFiles(); });
        filesList.appendChild(row);
      });
    };
    refreshFiles();
    const fileAddRow = document.createElement('div'); fileAddRow.className = 'file-add-row';
    const fileInp = document.createElement('input'); fileInp.className = 'file-input'; fileInp.placeholder = 'src/path/to/file.ts';
    const fileAddBtn = document.createElement('button'); fileAddBtn.className = 'file-add-btn'; fileAddBtn.textContent = '+ Add';
    fileAddBtn.addEventListener('click', () => { if (!fileInp.value.trim()) return; (task.filesModified=task.filesModified||[]).push(fileInp.value.trim()); task.updatedAt=now(); scheduleSave(); refreshFiles(); fileInp.value=''; });
    fileAddRow.appendChild(fileInp); fileAddRow.appendChild(fileAddBtn);
    el.appendChild(filesList); el.appendChild(fileAddRow);
  }));

  // ── activity log & timestamps ──────────────────────────────────────────
  body.appendChild(mkAcc(`Activity Log <span class="ws-acc-extra">${(task.activityLog||[]).length} entries</span>`, false, el => {
    const tsRow = document.createElement('div'); tsRow.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:var(--fs-xs);margin-bottom:12px';
    const addTs = (k: string, v: string): void => { const k2=document.createElement('span'); k2.style.color='var(--text-muted)'; k2.textContent=k; const v2=document.createElement('span'); v2.textContent=v; tsRow.appendChild(k2); tsRow.appendChild(v2); };
    addTs('Created', fmtDate(task.createdAt)); addTs('Updated', fmtDate(task.updatedAt));
    if (task.completedAt) addTs('Completed', fmtDate(task.completedAt));
    el.appendChild(tsRow);
    const logList = document.createElement('div'); logList.className = 'log-list';
    (task.activityLog||[]).slice().reverse().forEach(entry => {
      const item = document.createElement('div'); item.className = 'log-item';
      item.innerHTML = `<span class="log-time">${fmtDate(entry.timestamp)}</span> · <span class="log-agent">${esc(entry.agent)}</span> · ${esc(entry.action)}`;
      logList.appendChild(item);
    });
    el.appendChild(logList);
  }));
}

export function mkSection(title: string): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'detail-section';
  if (title) {
    const lbl = document.createElement('div');
    lbl.className = 'detail-label'; lbl.textContent = title;
    sec.appendChild(lbl);
  }
  return sec;
}

export function mkDetailRow(key: string, valEl: string | HTMLElement): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'detail-field';
  const k = document.createElement('div'); k.className = 'detail-key'; k.textContent = key;
  const v = document.createElement('div'); v.className = 'detail-val';
  if (typeof valEl === 'string') v.textContent = valEl; else v.appendChild(valEl);
  row.appendChild(k); row.appendChild(v);
  return row;
}

export function mkSelect(
  options: string[],
  current: string,
  onChange: (v: string) => void,
  labels?: string[]
): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'detail-select';
  options.forEach((o: string, i: number) => {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = labels ? labels[i] : statusLabel(o);
    if (o === current) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
