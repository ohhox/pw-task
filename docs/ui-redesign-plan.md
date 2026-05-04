# UI Redesign Plan — Multi-view (Direction C)

**Status:** Approved direction, implementation pending
**Reference:** `outputs/mockups/c-multiview.html`
**Owner:** Claude (PM) → frontend-dev sub-agent
**Created:** 2026-05-03

---

## 1. Goals

1. **Multi-view per project** — same task data rendered as List / Board (Kanban) / Timeline / Calendar
2. **Professional/corporate aesthetic** — Atlassian-style chrome (clean blue, light mode default, rounded corners)
3. **Power-user comfort** — saved views, bulk select, drag-to-reorder
4. **Same data, no migration** — existing `tasks.json` works; only ADD new optional fields (saved views)
5. **Performance** — render hot paths stay sync (per Phase 1.6 Option B Hybrid pattern)

## 2. Non-goals

- Mission Control / cassette futurism aesthetic (Direction D rejected)
- Linear-style command palette (Direction A rejected as primary)
- Things3 inline-everything editing (Direction B rejected)
- Mobile/responsive — desktop-only for v1
- Multi-user / real-time collaboration
- Dark mode in U1-U3 (deferred to U5 if needed — light mode default per mockup)

## 3. Visual System

### Palette (light mode)
```
--bg:           #FAFBFC    page background
--surface:      #FFFFFF    cards, panels
--surface-2:    #F4F5F7    subdued surface
--surface-3:    #EBECF0    hover/divider
--border:       #DFE1E6    standard border
--text:         #172B4D    primary
--text-2:       #5E6C84    secondary
--text-3:       #97A0AF    tertiary/disabled
--accent:       #0052CC    primary action (Atlassian blue)
--accent-soft:  #DEEBFF    accent background

--green:   #00875A    --green-soft:   #E3FCEF
--orange:  #FF8B00    --orange-soft:  #FFF0B3
--red:     #DE350B    --red-soft:     #FFEBE6
--blue:    #0065FF    --blue-soft:    #DEEBFF
--purple:  #6554C0    --purple-soft:  #EAE6FF
--yellow:  #FFAB00
```

### Typography
- **Body:** `'Inter', -apple-system, system-ui, sans-serif` — 14px/1.43 (Note: Inter ที่ Mockup C ใช้ — เก็บไว้)
- **Mono (IDs, code):** `'JetBrains Mono', ui-monospace, monospace` — 11-13px
- No display font — clean professional all the way

### Spacing/Radius
- 4px base grid; common: 4 / 8 / 12 / 16 / 24
- Border radius: 4px standard, 6px cards
- Shadows: `0 1px 2px rgba(9,30,66,0.08)` (sm), `0 4px 8px rgba(9,30,66,0.1)` (md)

### Iconography
- **Lucide Icons** (inline SVG, 14-16px stroke 2) — replace ALL emoji in markup
- Status as colored dot/square, not emoji

## 4. Information Architecture

### Current (legacy)
```
Header (10 buttons!) — Sidebar (Projects + Summary) — Main (Welcome OR Project view → Task list)
                                                    Detail panel REPLACES task list
```

### New
```
TopBar (logo + global search + new task + notifications + avatar)
├── Sidebar (collapsible) — Workspace · Projects · Saved Views
└── Main
    ├── Project Header (title + meta + actions) — always visible
    ├── View Tabs (List · Board · Timeline · Calendar · + Add View)
    ├── Toolbar 2 (Filter · Group · Sort · Customize · count)
    └── View Body (changes based on active view)

Detail panel: side-drawer (slides in from right, 480px), does NOT replace list
```

**Key change:** detail panel = overlay/drawer instead of replacement → user can browse + edit simultaneously.

## 5. Component Inventory

### Existing → Map to new
| Current | New |
|---|---|
| `#header` 10 buttons | TopBar — 4 elements + avatar |
| `#sidebar #project-list` | Sidebar Workspace + Projects sections |
| `#sidebar-summary` | DELETED — moved to project header stats |
| `#filters-bar` | Toolbar 2 (after view tabs) |
| `#task-list` `.task-row` | List view rows (unchanged data, new visual) |
| `#detail-panel` | Side drawer (right slide-in, not replacement) |
| `.modal-overlay` | Keep for create/edit dialogs (still needed) |
| Welcome screen | Keep but redesign empty state |

### New components to build
1. **TopBar** — global search input + new task button + avatar
2. **ViewTabs** — segmented control with icon + label + count badge
3. **Toolbar2** — filter pills, group/sort dropdowns
4. **TaskCard** (Board view) — compact card with labels, ID, assignee avatar, progress bar
5. **KanbanColumn** — header + scrollable card list + add button
6. **DetailDrawer** — right slide-in panel
7. **Avatar** — colored gradient circle with initials
8. **Label chip** — colored tag with bold uppercase text (Asana style)
9. **PriorityIndicator** — bar/dot system
10. **AssigneeAvatar** — small circle with agent initials

## 6. Implementation Phases

### **U1 — Foundation Refresh** (1-2 days)
**Scope:** New visual system + TopBar + Sidebar + Project Header (List view stays close to existing)

**Files modified:**
- `src/index.html` — restructure header, sidebar, project view markup
- `src/styles.css` — new palette, components base, spacing rhythm
- `src/js/main.ts` — wire new event listeners, view-tab toggle skeleton (only List enabled)
- `src/js/render.ts` — minimal — adapt to new markup IDs/classes

**New files:**
- `src/views/icons.ts` — Lucide SVG icon library (export functions returning SVG strings)
- `src/views/components/avatar.ts` — Avatar generator (initials + gradient by agent)
- `src/views/components/label.ts` — Label chip variants

**Backup created:**
- `outputs/backup-pre-redesign/index.html`
- `outputs/backup-pre-redesign/styles.css`

**DoD:** App runs, looks like Mockup C, all existing functionality preserved (List view only). Backend untouched.

---

### **U2 — Board View (Kanban)** (2-3 days)
**Scope:** Add Board view as second tab; drag-drop between columns updates task status

**Files created:**
- `src/views/board.ts` — board renderer (groups tasks by status, draws columns)
- `src/views/components/task-card.ts` — Kanban card component
- `src/views/dnd.ts` — minimal drag-drop helper (HTML5 native, no library)

**Files modified:**
- `src/js/main.ts` — view tab switcher logic
- `src/js/state.ts` — `activeView: 'list' | 'board' | 'timeline' | 'calendar'`
- `src/styles.css` — board + card styles

**DoD:** Click Board tab → see 5 columns (Todo / In Progress / Pending Review / Done / Blocked). Drag card between columns → task status updates via existing patch system. List view unchanged.

---

### **U3 — Timeline View (Gantt-lite)** (2-3 days)
**Scope:** Horizontal timeline, tasks as bars positioned by `createdAt` + estimated duration

**Files created:**
- `src/views/timeline.ts` — Gantt-style renderer using SVG
- `src/views/components/timeline-bar.ts` — task bar component

**Schema decision:**
- Add optional `task.estimatedHours?: number` (no migration needed — optional)
- Tasks without estimate render as point markers; with estimate render as bars

**DoD:** Click Timeline tab → see horizontal time axis (week/month/quarter zoom), tasks plotted by createdAt. Hover bar = tooltip. Click bar = open detail drawer.

---

### **U4 — Saved Views + Bulk Select** (1-2 days)
**Scope:** Per-project saved views (filter + sort + view type) + multi-task select

**Schema change (requires migration v1.1 → v1.2):**
- Add `project.savedViews?: SavedView[]` where:
  ```ts
  interface SavedView {
    id: string;
    name: string;
    icon?: string;
    type: 'list' | 'board' | 'timeline' | 'calendar';
    filters: { status?: TaskStatus[]; agent?: string[]; priority?: TaskPriority[] };
    groupBy?: 'status' | 'agent' | 'priority';
    sortBy?: { field: string; dir: 'asc' | 'desc' };
  }
  ```
- Migration v1.1→v1.2: ensure `project.savedViews` defaults to `[]` (idempotent)

**Files created:**
- `src/migrations/v1_1-to-v1_2.ts`
- `src/views/saved-views-mgr.ts`
- `src/views/components/bulk-select-bar.ts`

**Files modified:**
- `src/index.html` — sidebar saved views section
- `src/js/render.ts` — checkbox column when bulk-mode active

**DoD:** Save current filter+sort+view as named view; appears in sidebar; click loads it. Shift-click multi-select tasks → bulk action bar appears (change status, assign agent, delete).

---

## 7. Migration Strategy (keep app working during)

- **Each phase is independently shippable** — U1 alone improves UX, U2-U4 add views progressively
- **No big-bang rewrite** — existing components stay until replaced
- **Feature flag toggle** in `localStorage` (`pwtask-ui-version: 'legacy' | 'v2'`) for first 2 weeks → can rollback
- **Keep `tests/e2e/smoke.spec.ts`** updated each phase — must pass before merge
- After U1 verified stable for 1 week → remove legacy markup

## 8. Risks + Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Drag-drop breaks on slow Tauri webview | Medium | Use HTML5 native (no lib); if slow, fallback to "Move to..." dropdown |
| Board view re-renders too often (perf) | Medium | Render once per status change; use diff/keyed updates |
| Detail drawer + list both editable → race | Low | Single source of truth = task object; drawer reads/writes via central state |
| User confused by view tabs | Low | Default to List view (matches current behavior); persist last-used per project |
| Timeline zoom complexity | High | Defer to U3 only after U1+U2 ship; if scope blows up, drop Calendar from U3 |
| Saved views schema change | Medium | Migration v1.1→v1.2 must be tested with real `tasks.json` before ship |

## 9. Schedule (estimate)

Based on Sonnet sub-agent execution (~3-5x faster than human):
- **U1:** 1 sub-agent session (Sonnet) ≈ 30-60 min
- **U2:** 1 sub-agent session (Sonnet) ≈ 60-90 min
- **U3:** 1 sub-agent session (Opus, design judgment needed) ≈ 90-120 min
- **U4:** 1 sub-agent session (Sonnet) ≈ 60-90 min

**Total:** ~4-6 hours of agent work, spread across multiple sessions for review

## 10. Pre-flight checklist (before U1 starts)

- [ ] Phase 1.6 backend complete (06-04 + 06-05) — DB layer in Rust = stable IPC for refactor
- [ ] All existing tests passing (vitest + cargo)
- [ ] Backup current `src/index.html` and `src/styles.css` to `outputs/backup-pre-redesign/`
- [ ] Smoke E2E test runs and passes on current code
- [ ] User confirms final visual reference (mockup C is canonical)
- [ ] Light mode confirmed as default (no theme toggle in U1)

## 11. Open Questions

1. **Calendar view** — useful for task scheduling? Or skip in v1? (Mockup shows tab; recommendation: empty placeholder in U3, real impl in v2)
2. **Theme toggle** — light only, or add dark/auto? (Recommendation: defer to U5, ship light-only first)
3. **Logo redesign** — current = 🗂 emoji. New = "P" letter mark. Or full custom SVG mark?
4. **Welcome screen** — redesign? (Recommendation: minor refresh in U1, full redesign in U5 if needed)
5. **Keyboard shortcuts** — Ctrl+K command palette? (Direction A had it; user chose C; defer to v2)

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-03 | Direction C chosen over A/B/D | User preference — "ฉันชอบแบบ Multi-view" |
| 2026-05-03 | Light mode default | Per mockup; matches Atlassian DNA |
| 2026-05-03 | Defer to after Phase 1.6 backend done | Clean separation; stable IPC contract first |
| 2026-05-03 | Inter font kept | Mockup uses it; no need for distinctive display font in C aesthetic |
| 2026-05-03 | Lucide icons replace all emoji | Cross-platform consistency |
