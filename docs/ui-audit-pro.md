# UI Audit — Path to Pro

**Goal:** อะไรขาด อะไรเกิน เพื่อให้ PwTask รู้สึก **เหมือนเครื่องมือมืออาชีพจริงๆ** ที่ developer ยอมจ่าย $20/mo
**Reviewer:** Claude (acting as senior product designer + dev)
**Created:** 2026-05-03
**Reference:** Linear · Asana · Things3 · Raycast · Arc browser · Figma

---

## 🎯 Executive Summary

**คะแนนปัจจุบัน: 6/10** — ทำงานได้ครบ แต่ยัง "feel like internal tool" ไม่ใช่ "product"

**3 จุดอ่อนใหญ่สุดที่ทำให้รู้สึก amateur:**
1. **Discoverability ต่ำ** — feature ดีๆ ซ่อนอยู่ใต้ accordion ที่ปิดอยู่ (Run History, Activity, Reviews) → user ไม่รู้ว่ามี
2. **Information density กลางๆ ไม่ตอบโจทย์ใคร** — task row พ่น 8+ badge แน่น แต่ไม่มี glanceable signal ที่บอก priority ทันที
3. **No power features** — ไม่มี keyboard shortcuts, bulk action, undo, search across projects, command palette → ใช้ครบ 100 task ไม่ไหว

**1 จุดแข็งใหญ่:** Patch system + AI run + review flow เป็น **unique value** ที่ Linear/Asana ไม่มี → ต้องโชว์ออกมาให้ชัดกว่านี้

---

## ➕ ADD — สิ่งที่ต้องเพิ่ม (จัดลำดับตาม impact/effort ratio)

### Tier S — Must-have ก่อนเรียกตัวเองว่า "pro" (รวม ~5-7 วัน)

| # | Feature | Why pro tools มี | Effort | Impact |
|---|---------|------------------|--------|--------|
| **S1** | **Command Palette (⌘K)** — fuzzy search task/project, jump, run command | Linear/Raycast — 90% ของ pro user ใช้ทุกวัน | 1d | 🔥🔥🔥🔥🔥 |
| **S2** | **Keyboard shortcuts** ทั่วทั้งแอป (J/K nav, R run, E edit, /search, N new) + cheat sheet (?) | Vim/Linear DNA — บอกว่าเคารพ user time | 1d | 🔥🔥🔥🔥 |
| **S3** | **Bulk select + bulk action** (shift-click, multi-status change, bulk delete) | จัดการ 50+ task ทำทีละตัวเหนื่อยเกิน | 1d | 🔥🔥🔥🔥 |
| **S4** | **Undo/Redo** (Cmd+Z) — track last 20 ops, time-travel state | Figma standard — user รู้สึก "safe to experiment" | 1.5d | 🔥🔥🔥🔥 |
| **S5** | **Cross-project search** + global recent | Notion/Linear — เมื่อ project >5 ตัวจำเป็น | 0.5d | 🔥🔥🔥 |
| **S6** | **Toast → Notification center** (persistent, dismissable, history) | toast หาย 2 วิ ลืมว่าเกิดอะไร | 1d | 🔥🔥🔥 |

### Tier A — Highly desired (รวม ~5 วัน)

| # | Feature | Why | Effort |
|---|---------|-----|--------|
| **A1** | **Diff viewer per run** — แสดง file changed before/after agent run (syntax highlight) | Reviewer ตัดสินใจ approve ง่าย ไม่ต้องเปิด VS Code | 2d |
| **A2** | **Inline editing ทุกจุด** — title, status, priority แก้ใน list ไม่ต้องเปิด detail | Notion/Things — เร็วขึ้น 3x | 1d |
| **A3** | **Drag-to-reorder** + Kanban drag (อยู่ใน UI plan U2 อยู่แล้ว) | Asana basic — user คาดหวัง | (already U2) |
| **A4** | **Saved views per project** (filter+sort+view-type) | Asana DNA, อยู่ใน U4 อยู่แล้ว | (already U4) |
| **A5** | **Auto-suggested next task** ("What should I work on?") — algorithm: highest priority + ready (no blockers) + matches active agent | AI-native tool ต้องมี | 1d |
| **A6** | **Run notification** (browser/system Notification API + sound) เมื่อ Claude run จบ | run นาน 5 นาที, user เปลี่ยน tab → ต้องรู้ | 0.5d |
| **A7** | **Activity timeline view** ของ project — scrollable timeline ของทุก action | "What happened today?" | 1d |
| **A8** | **Project archive/unarchive** + archive view | ไม่ต้อง delete project ที่จบแล้ว | 0.5d |

### Tier B — Differentiators (สิ่งที่ทำให้แตกต่างจาก Asana/Linear)

| # | Feature | Why differentiator |
|---|---------|---------------------|
| **B1** | **Live agent status panel** — pin บน sidebar, แสดง agent ที่รันอยู่ปัจจุบัน real-time | AI-native — Linear/Asana ไม่มี |
| **B2** | **Token/cost tracking per run** — แสดง input/output token, cost USD, totals per project/sprint | Pro user ต้องรู้ว่าจ่ายเท่าไหร่ |
| **B3** | **Replay session** — open old session in detail, scroll terminal, copy prompt | reproducibility สำคัญสำหรับ AI agent work |
| **B4** | **Approval queue** — dedicated view ของทุก task ที่ pending_review ทั้ง project | reviewer mode — work in batch |
| **B5** | **Patch inspector** — open patch JSON, dry-run preview before apply | trust the system |
| **B6** | **Agent prompt template library** — save/share system prompts, fork จาก template | AI-native tool ขายได้ |
| **B7** | **Auto-generated PR description** จาก task + run logs (push ไป GitHub) | bridge to git workflow |
| **B8** | **Time tracking** — auto-record time per task (active focus + agent run time) | reports/billing |

### Tier C — Polish (low effort, high delight)

| # | Feature | Why |
|---|---------|-----|
| **C1** | **Loading skeletons** แทน blank/empty | Modern apps ทำกันหมด |
| **C2** | **Empty states with character** — illustration + suggestion + CTA | First impression สำคัญ |
| **C3** | **Optimistic UI** — change status → ทันที (rollback ถ้า save ล้มเหลว) | Feel snappy |
| **C4** | **Smooth transitions** — task row appear/disappear animate, drawer slide spring | "designed feel" |
| **C5** | **Better terminal** — ANSI color, syntax highlight (json/diff), copy button, search-within | Run output อ่านยากตอนนี้ |
| **C6** | **Title autosave indicator** — ✓ saved · • saving · ⚠ failed | Trust UI |
| **C7** | **Tag autocomplete** จาก existing tags ใน project | Faster |
| **C8** | **File path autocomplete** จาก workingDir (Tauri read_dir) | Power user feature |
| **C9** | **Right-click context menu** ที่ task row | Standard desktop pattern |
| **C10** | **Drag file → "Files Modified"** drop zone | UX win |

---

## ➖ REMOVE / CONSOLIDATE — สิ่งที่ควรตัด

### Tier S — ตัดทิ้งเลย (เกะกะ ไม่ใช้)

| # | สิ่งที่ตัด | เหตุผล |
|---|-----------|---------|
| **R1** | **Header 10 ปุ่ม** → เหลือ 4 (search · new task · sync · avatar+menu) | ปุ่มเยอะ = ตาแตก, อย่างอื่นย้ายเข้า command palette |
| **R2** | **Font-size toggle (A⁻ A A⁺)** | หา app ไหน production ที่มีปุ่มนี้ — ใช้ browser zoom (Ctrl+/-) ก็พอ |
| **R3** | **Sidebar Summary section** (Todo: 5, Doing: 2, ...) | ซ้ำกับ counter ที่จะอยู่ใน project header (mockup C มี stats panel แล้ว) |
| **R4** | **Project ID display** (`🪪 proj-tauri-001`) | Internal identifier — โผล่หน้า user ไม่จำเป็น (ย้ายเป็น tooltip ของ project title) |
| **R5** | **`📁` working dir + `🎯` goal** prefix emoji ทุกจุด | ใช้ icon library (Lucide) consistent ทั้งแอปแทน |
| **R6** | **All emoji-as-icon** ใน buttons (`📂`, `🔄`, `💾`, `⚙`, `📦`, `▶`, `✏️`, `🗑`, `✨`, `💻`) | Cross-platform render ไม่ตรง, ขนาดต่าง — แทนด้วย Lucide SVG ทั้งหมด |
| **R7** | **Quick play `▶` button at root tasks only** | Inconsistent — ทำไม root ได้ subtask ไม่ได้? → ทำให้ทุก task มี run icon เหมือนกัน |
| **R8** | **6 badges packed in task title row** (status, priority, agent, model, tags, files, %, reviews) | Cognitive overload — เก็บแค่ status + priority ใน list view, อย่างอื่นเก็บใน detail/hover |

### Tier A — Consolidate (รวม/ลดความซ้ำซ้อน)

| # | Consolidate | จาก → ไป |
|---|-------------|----------|
| **R9** | **3 detail panels: title-input + toolbar chips + accordion sections** | รวมเป็น single editable side drawer ที่ structured ดีกว่า |
| **R10** | **`status` 5 places**: list badge, list select, detail chip, modal, sub-row badge | Single canonical component (StatusPill) ที่ rendered ทุกที่ — แก้ที่เดียวจบ |
| **R11** | **2 places to play task**: list `▶` quick + detail `▶ Run` | quick play mostly useful — เก็บ list, ใน detail ทำ "Run with options" ที่ระบุ session/model |
| **R12** | **Welcome screen + Open folder** เป็น 2 layouts | รวม — first run = friendly onboarding (mock data import option), recurring user = recent projects list |
| **R13** | **Modals สำหรับทุก dialog** (add/edit project, add/edit task, claude.md export, agent mgr) | Create/edit → inline drawer; only destructive actions เท่านั้นที่ใช้ modal |
| **R14** | **Activity log buried ใน accordion** ที่ปิดอยู่ default | Default open ใน drawer, หรือทำ "Activity" tab dedicated |
| **R15** | **5 separate config places**: filter bar, status select, agent select, project edit, agent manager | สร้าง "Settings" panel center ที่จัดทุกอย่าง |

### Tier B — Defer หรือ Remove ถ้าไม่ใช้

| # | Feature | Action |
|---|---------|--------|
| **R16** | **Plan with AI button** ปัจจุบันเป็น MVP — ถ้า quality ไม่ดี ซ่อนก่อน | Keep but improve OR hide ใน command palette |
| **R17** | **CLAUDE.md export modal** | Move ไป command palette (`> Export CLAUDE.md`) |
| **R18** | **VS Code button + Run Project button** | Keep — แต่ย้ายเข้า project menu (kebab) ไม่อยู่ header |

---

## ✨ KEEP & POLISH — ของดีที่ต้อง refine

| # | สิ่งที่ดีอยู่แล้ว | ต้องปรับ |
|---|----------------|----------|
| K1 | **Patch-based AI workflow** | Showcase ใน UI ชัดกว่า — patch counter, "1 patch pending" badge, inspector |
| K2 | **Auto-escalate logic** (subtask done → parent escalates) | ดี ไม่ต้องเปลี่ยน — แต่บอก user ตอน escalate (toast) |
| K3 | **Multi-agent system** (planner/executor/reviewer/quickfix) | UI ปัจจุบันแสดงแค่ badge — ทำ "Agent profiles" view ให้ดูเลือกง่าย |
| K4 | **Markdown rendering ใน description + notes** | ดีแล้ว — เพิ่ม syntax highlight ใน code block (Prism.js หรือ shiki) |
| K5 | **Subtask nesting + tree line** | Visual ดี — แต่ collapse state ไม่ persist ระหว่าง session (เก็บ localStorage) |
| K6 | **Activity log structure** (timestamp + agent + action) | Schema ดี — แต่ render ใน timeline view สวยกว่า list |
| K7 | **Streaming terminal output** ระหว่าง run | ดี — แต่ขยาย max-height (ตอนนี้ 480px), เพิ่ม "follow tail" toggle |
| K8 | **Task ID copy button** (`✓ Copied` feedback) | ดี — pattern เดียวกันกับทุก copyable element |

---

## 🏛️ ARCHITECTURAL Recommendations

### 1. Component System — สร้าง design system จริง
ตอนนี้ wraps everything in plain HTML/CSS. Pro feel ต้องมี:
- **Token system** — design tokens ใน CSS vars (already partial), expand: spacing scale, type scale, motion scale
- **Component primitives** — Button, Input, Select, Chip, Badge, Avatar, Tooltip, Dropdown, Drawer, Modal, Toast, Skeleton — สร้างเป็น re-usable pieces
- **Composition rules** — แต่ละ component มี variants (size, intent, loading, disabled)

### 2. State management — ปัจจุบันเป็น global mutable state
Issue: render.ts ใช้ `db`, `activeProjectId`, etc. → mutate → render full list
Pro pattern: ใช้ **observable store** หรือ small reactive lib (e.g., Solid signals, Preact signals, nanostores)
- Selective re-render (one task changed → only that row re-renders)
- Time-travel debugging
- Optimistic updates clean

### 3. Routing — URL = state
ปัจจุบัน selected task ไม่อยู่ใน URL → reload เสีย state, ไม่สามารถ deep-link ได้
Pro: ใช้ **history.pushState** สำหรับ:
- `/p/proj-tauri-001` — project active
- `/p/proj-tauri-001/t/task-013` — task selected
- `/p/proj-tauri-001/view/board` — view mode
- ทำให้ Tauri menu (right-click → open in new window) ทำงานได้

### 4. Concurrency UX — multiple agents running
ตอนนี้ activeRuns เป็น Map แต่ UI โชว์ไม่ชัด
Pro pattern: persistent **bottom sheet** หรือ **floating panel** บอก "3 agents running" + click expand → live status of each

### 5. Onboarding — first 60 seconds
ตอนนี้: Welcome → Open folder → empty state
Pro: Welcome → "Try with sample data" (สร้าง demo project + tasks ให้เลย, ลบทีหลังได้) — user เห็นว่าทำอะไรได้ใน 30 วิ

### 6. Error handling — silent failures
ตอนนี้ console.warn (logger now) แต่ user ไม่รู้
Pro: errors → notification center, retry button, "report issue" link

### 7. Performance — re-render full list every time
`renderTaskList()` rebuilds DOM ทั้งหมด — slow on >100 tasks
Pro: virtual scrolling (lit-virtual หรือ tanstack-virtual) + diff render

### 8. Accessibility — currently 0 ARIA
เปิด screen reader ใช้ไม่ได้
Pro: ARIA roles, focus management, keyboard nav, color contrast — สำคัญมากถ้าจะขายให้บริษัท (legal compliance)

---

## 📊 Priority Matrix

```
                    HIGH IMPACT
                          ↑
   S1 cmd palette         |   S4 undo
   S2 keyboard            |   K1 patch showcase
   S3 bulk select         |   A1 diff viewer
   R1 header cleanup      |   B1 live agent panel
   R6 emoji → icons       |
   ──────────────────────┼─────────────────────→ HIGH EFFORT
   C1 skeletons           |   B5 patch inspector
   C2 empty states        |   B6 prompt library
   R2 font toggle         |   B7 PR auto-gen
   R5 emoji prefix        |   architectural #2 state mgmt
                          |
                    LOW IMPACT
```

**Sweet spot (high impact, low effort):** S1, S2, S3, R1, R6, C1, C2

---

## 🎯 Recommendation — สำหรับ "Pro" rebrand

### Sprint 3 (after Phase 1.6 backend done) — UI rebuild

**Phase A · Foundation Polish (3-4 วัน) — Pre-mockup-C work**
1. R1 + R6: clean header, emoji → Lucide icons
2. R5: emoji prefix → icons in headers/labels
3. R8: trim badges in task row
4. R10: extract StatusPill canonical component
5. R3 + R4: remove sidebar summary + project ID display
6. C1: loading skeletons
7. C2: empty states with character

**Phase B · Mockup C Implementation (5-7 วัน) — per ui-redesign-plan.md**
- U1 Foundation refresh
- U2 Board view
- U3 Timeline (placeholder for Calendar)
- U4 Saved views

**Phase C · Pro Power Features (4-5 วัน)**
1. S1 Command Palette (⌘K)
2. S2 Keyboard shortcuts
3. S3 Bulk select
4. S4 Undo/redo
5. S6 Notification center
6. S5 Cross-project search

**Phase D · AI-Native Differentiators (3-4 วัน)**
1. B1 Live agent panel (sidebar pin)
2. B2 Token/cost tracking
3. B4 Approval queue view
4. A1 Diff viewer per run
5. A6 Run completion notification

**Phase E · Polish + Architecture (3-5 วัน)**
1. C3 Optimistic UI
2. C5 Better terminal (ANSI colors, copy, search)
3. Routing (URL = state)
4. Selective re-render (signal-based store)
5. Virtual scrolling on task list

**Total Sprint 3: ~3 weeks of agent work** — output = professional v1.0

---

## ❓ Decisions to make

1. **Cut scope** — ทำทั้งหมดข้างบนใน Sprint 3 หรือ pick top 30%?
2. **Architectural rewrite** (state mgmt + routing + virtual scroll) — รวมใน Sprint 3 หรือ Sprint 4?
3. **B-tier AI differentiators** (token tracking, prompt library, PR auto-gen) — ทำเลย vs รอ user feedback หลัง launch?
4. **Onboarding** (sample data) — สำคัญแค่ไหนถ้า audience = developers ที่อ่าน README ได้?
5. **A11y** — ลงทุนตอนนี้ หรือรอ first paying customer ขอ?
