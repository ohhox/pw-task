# PwTask Fixture Workspace Regression — Test System Design

> เอกสารออกแบบสถาปัตยกรรมระบบทดสอบสำหรับ project `proj-test-001` (PwTask Test System)
> เป้าหมายคือยืนยันว่าโค้ด PwTask ยังคงทำงานถูกต้อง 5 ด้าน หลังการแก้ไข:
> (1) data loading, (2) patch merge/sync, (3) task state transitions,
> (4) review/rerun flow, (5) legacy backward compatibility

---

## 1. หลักการออกแบบ (Design Principles)

1. **Fixture-first** — ทุก behavior verify จาก JSON ใน `tests/fixtures/` เพื่อให้ test สะท้อนข้อมูลจริงและ debug ได้ง่าย
2. **Pure-function-first** — สกัด business logic (patch merge, state transitions, helpers) ออกจาก DOM/Tauri ให้ test เรียกตรงได้โดยไม่ต้อง spin up app
3. **Mocked I/O boundary** — `window.__TAURI__.core.invoke` คือ I/O boundary เดียวของ frontend → mock ที่จุดเดียวก็ครอบคลุม fileops, ai, agents
4. **Deterministic timestamps** — freeze time ทุก test ที่ assert timestamp; normalize ก่อน snapshot
5. **Round-trip safety** — legacy fixture ทุกตัวต้อง pass test "load → save → reload" โดยไม่ data loss
6. **Cross-platform-aware** — ทำงานบน Windows (PATH/CARGO_HOME ตาม CLAUDE.md) และไม่พึ่ง bash-only commands

---

## 2. Test Runner Stack

| Layer | Tool | เหตุผลที่เลือก |
|-------|------|---------------|
| JS unit/integration | **Vitest 1.x** | ESM-native, jsdom รองรับ DOM tests, snapshot/coverage built-in, watch mode เร็ว, ใช้ syntax `expect` คล้าย Jest |
| JS DOM environment | **jsdom** (vitest preset) | จำเป็นสำหรับ test `render.js`, `detail.js`, `modals.js` ที่ touch document |
| JS coverage | **@vitest/coverage-v8** | ไม่ต้อง instrument source (V8 native) → numbers ตรงกับ runtime จริง |
| Rust unit/integration | **cargo test** + `tempfile` crate | มาตรฐาน Rust; tempfile ช่วยให้ Tauri command tests มี isolated workspace |
| Rust coverage | **cargo-llvm-cov** | report HTML/LCOV ใช้กับ codecov ได้ |
| Orchestrator | **PowerShell script** `scripts/run-tests.ps1` | ตั้ง PATH/CARGO_HOME ตาม CLAUDE.md ก่อนรัน → ทำงานบน Windows ได้แน่นอน |
| (Optional) E2E | **tauri-driver + WebdriverIO** | เปิด app จริงและทดสอบ UI flow — overhead สูงบน Windows ใส่ไว้เป็น tier 3 (low priority) |

> **ทำไมไม่ใช้ Jest หรือ node:test?** Jest config ESM ยุ่ง, เก่ากว่าและช้ากว่า. `node:test` (Node 20+) ดีพอแต่ snapshot และ coverage ต้องประกอบเอง — เหนื่อยกว่ากำไรที่ได้

---

## 3. Code Refactor ที่ต้องทำก่อน (Pre-flight)

ปัจจุบัน logic ฝังเป็น script-tag globals ใน `src/js/*.js` — ไม่สามารถ `import` จาก vitest ได้ตรง ๆ ต้องแก้ดังนี้:

### 3.1 Dual-mode export footer

แต่ละไฟล์ใน `src/js/` ที่มี logic บริสุทธิ์ (data.js, fileops.js, agents/*) เพิ่มท้ายไฟล์:

```js
// at end of each pure-logic file
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { applyPatch, autoEscalate, findTaskAnywhere, /* ... */ };
}
```

ถ้าโหลดผ่าน `<script>` ใน browser จะ ignore export. ถ้า require จาก vitest จะได้ functions เลย

### 3.2 แยก patch merger ออกเป็น module

แทนที่จะให้ `applyPatch` แตะ global `db` โดยตรง ให้ refactor signature:

```js
function applyPatch(patch, db) { /* ... */ return db; }     // pure
function applyPatches(db, patchFiles) { /* ... */ }          // pure
async function loadAndApplyPatches(baseDir) { /* ... */ }    // I/O wrapper เดิมเรียก pure version
```

> ผลกระทบต่อ production: น้อย — เปลี่ยน internal signature เท่านั้น UI ยังคงเรียก `applyPatches()` ผ่าน wrapper

### 3.3 Logic ที่ต้องสกัด (priority order)

| File | Functions | Status |
|------|-----------|--------|
| `src/js/fileops.js` | `applyPatch`, `applyPatches` | ⚠️ ต้องแยก state จาก global `db` |
| `src/js/data.js` | `autoEscalate`, `findTaskAnywhere`, `calcProgress`, `isFullyDone`, `findNextRunnablePath`, `parsePlanOutput`, `countByStatus` | ✅ พร้อม test (เป็น pure อยู่แล้ว) |
| `src/js/agents/routing.js` | `resolveAgentId`, `resolveModel` | ✅ pure |
| `src/js/agents/legacy-mapping.js` | `legacyToAgentId` | ✅ pure |
| `src/js/agents/registry.js` | `loadAgentsFromDb`, `getAgent` | ⚠️ มี module-level state `_agents` — ใช้ `vi.resetModules()` ระหว่าง test |
| `src/js/ai.js` | `parsePlanOutput`, `runClaude` | ⚠️ runClaude แตะ DOM/state — แยก orchestration ออกจาก side effects |

---

## 4. โครงสร้าง `tests/` Folder

```
tests/
├── fixtures/                                         # ทุก fixture เป็น snapshot ของ workspace ครบชุด
│   ├── empty/
│   │   ├── tasks.json                                # version 1.0, projects: []
│   │   └── patches/.gitkeep
│   ├── baseline-current/                             # snapshot ของ outputs/tasks.json จริง
│   │   ├── tasks.json
│   │   └── patches/.gitkeep
│   ├── with-pending-patches/                         # baseline + ห้า patch files
│   │   ├── tasks.json
│   │   └── patches/
│   │       ├── 2026-05-02T10-00-00_StatusChange.json
│   │       ├── 2026-05-02T10-00-01_AddTask.json
│   │       ├── 2026-05-02T10-00-02_FilesModified.json
│   │       ├── 2026-05-02T10-00-03_AddLog.json
│   │       └── 2026-05-02T10-00-04_AddProject.json
│   ├── corrupt-patches/                              # patches ผิด format ปนกับดี
│   │   ├── tasks.json
│   │   └── patches/
│   │       ├── invalid.json                          # JSON syntax error
│   │       ├── unknown-projectId.json
│   │       └── 2026-05-02T10-00-00_Good.json
│   ├── mixed-status/                                 # tasks ครอบคลุม 5 status + nested subtasks
│   │   └── tasks.json
│   ├── pending-review-flow/                          # tasks ที่ pending_review พร้อม reviews[] เก่า
│   │   └── tasks.json
│   ├── archive-ready/                                # task root + subtasks ทั้งหมด done
│   │   ├── tasks.json
│   │   └── tasks-archive.json                        # archive เก่าที่จะถูก append
│   ├── auto-escalate/                                # parent ที่ทุก subtask done — ต้อง escalate
│   │   └── tasks.json
│   ├── legacy-v0/                                    # ก่อนระบบ agent — มีแค่ aiAgent string
│   │   ├── tasks.json
│   │   └── tasks.expected.json                       # shape หลัง upgrade
│   ├── legacy-no-runhistory/                         # ไม่มี runHistory, lastSessionId, model, reviews
│   │   ├── tasks.json
│   │   └── tasks.expected.json
│   ├── legacy-no-agents-block/                       # ไม่มี top-level "agents" array
│   │   ├── tasks.json
│   │   └── tasks.expected.json
│   ├── legacy-minimal/                               # task มีเฉพาะ id/title/status/createdAt
│   │   ├── tasks.json
│   │   └── tasks.expected.json
│   └── README.md                                     # ตารางระบุว่าแต่ละ fixture ทดสอบอะไร
│
├── helpers/
│   ├── fixture-loader.mjs                            # copyFixtureToTemp(name) → tempDir
│   ├── patch-builder.mjs                             # builders: makeStatusChange(), makeAddTask(), ...
│   ├── tauri-mock.mjs                                # in-memory FS + invoke router
│   ├── time-freeze.mjs                               # freezeAt(iso) ครอบ vi.useFakeTimers
│   └── snapshot-utils.mjs                            # normalizeTimestamps, normalizeUuid, sortBy
│
├── unit/                                             # ไม่แตะ I/O — ทดสอบ pure functions
│   ├── patch-merger.test.mjs                         # applyPatch ทุก change type, idempotency
│   ├── data-helpers.test.mjs                         # findTaskAnywhere, calcProgress, isFullyDone
│   ├── auto-escalate.test.mjs                        # forward + reverse escalation rules
│   ├── routing.test.mjs                              # resolveAgentId via tags/legacy/explicit
│   ├── plan-output.test.mjs                          # parsePlanOutput JSON extraction edge cases
│   └── markdown-render.test.mjs                      # renderMd XSS guard (sanitizeLinkUrl)
│
├── integration/                                      # mock Tauri แต่ใช้ flow จริงของแอป
│   ├── load-flow.test.mjs                            # loadFromDir end-to-end
│   ├── patch-sync.test.mjs                           # apply → save → delete cycle + retry
│   ├── task-state.test.mjs                           # state transitions ผ่าน UI handler จำลอง
│   ├── review-rerun-flow.test.mjs                    # mock claudeProviderRun, assert mutations
│   ├── archive-flow.test.mjs                         # archive + tasks-archive.json append
│   └── plan-project.test.mjs                         # parsePlanOutput → write patch → applyPatches
│
├── compat/                                           # backward compatibility
│   ├── legacy-v0.test.mjs
│   ├── legacy-no-runhistory.test.mjs
│   ├── legacy-no-agents-block.test.mjs
│   ├── legacy-minimal.test.mjs
│   └── round-trip.test.mjs                           # legacy → load → save → reload (no data loss)
│
├── snapshots/                                        # auto-generated โดย vitest --update
│   └── *.snap
│
├── setup.mjs                                         # vitest globals: jsdom stub, window.__TAURI__
└── README.md                                         # how to add new fixture/test

src-tauri/
└── tests/
    ├── commands_integration.rs                       # cargo test สำหรับ Tauri commands
    └── fixtures/                                     # mirror ของ tests/fixtures/ ที่ Rust ต้องอ่าน

scripts/
└── run-tests.ps1                                     # orchestrator (ตั้ง PATH ก่อนรัน vitest + cargo)
```

---

## 5. Fixture Specification

### 5.1 หลักการสร้าง fixture

- **ทุก fixture เป็น workspace ครบชุด** (มี `tasks.json` และ `patches/` directory) เพื่อ copy ไป temp dir แล้วใช้ได้ทันทีโดย Tauri command/loader จริง
- **timestamp ใน fixture คงที่** (เช่น ใช้ `2026-05-02T10:00:00.000Z` ทุกที่ที่เป็น base) — ระบบ verify เปรียบเทียบ timestamp เฉพาะที่ถูกแก้ระหว่าง test
- **ไม่ใช้ template/placeholder** — fixture ต้องเป็นไฟล์ JSON ที่ valid 100% เพื่อให้ editor (และ schema validator) ตรวจได้
- **คู่ `.expected.json`** สำหรับ legacy fixtures เก็บ shape ที่ "ควรจะเป็น" หลัง upgrade
- **ห้ามใช้ symlink** (Windows) — copy ไฟล์เสมอ

### 5.2 ตาราง mapping fixture ↔ test

| Fixture | Tests ที่ใช้ | Invariants |
|---------|--------------|-----------|
| `empty/` | load-flow, patch-sync | ไม่มี project → onDbLoaded แสดง welcome ได้ |
| `baseline-current/` | load-flow, patch-sync (no-op), task-state | DB structure match production |
| `with-pending-patches/` | patch-sync, patch-merger | apply ตามลำดับ timestamp; ลบ patches หลัง save สำเร็จ |
| `corrupt-patches/` | patch-sync error path | skip บรรทัด invalid, log warning, ไม่ crash |
| `mixed-status/` | task-state, render | ทุก status ที่มีต้อง render ได้ |
| `pending-review-flow/` | review-rerun-flow | reviews[] history append-only; lastSessionId resume ได้ |
| `archive-ready/` | archive-flow | filter `isFullyDone`; append เข้า tasks-archive.json |
| `auto-escalate/` | auto-escalate | parent → pending_review เมื่อ subtask ทั้งหมด done |
| `legacy-v0/` | compat/legacy-v0 | aiAgent string → agentId ผ่าน legacyToAgentId |
| `legacy-no-runhistory/` | compat | missing arrays → default `[]` |
| `legacy-no-agents-block/` | compat | bundled DEFAULT_AGENT_IDS active |
| `legacy-minimal/` | compat, round-trip | ฟิลด์ขาดทั้งหมด ต้องมี default + ไม่ data loss |

---

## 6. การ Assert กับ JSON Output

### 6.1 รูปแบบหลัก 3 แบบ

#### A) Property-level `toMatchObject` — สำหรับ test ที่สนใจเฉพาะส่วนที่เปลี่ยน

```js
const db = applyPatch(patch, loadFixture('baseline-current'));
const task = findTaskInProject(db, 'proj-tauri-001', 'task-t-04');

expect(task).toMatchObject({
  status: 'pending_review',
  lastNote: {
    agent: 'Claude',
    summary: expect.stringContaining('done'),
  },
  activityLog: expect.arrayContaining([
    expect.objectContaining({ action: expect.stringMatching(/changed status/) }),
  ]),
});
```

#### B) Deep equality หลัง normalize — สำหรับ fixture ขนาดเล็ก

```js
import { normalize } from '../helpers/snapshot-utils.mjs';

const got      = applyPatches(loadFixture('with-pending-patches'));
const expected = readJSON('tests/fixtures/with-pending-patches.expected.json');
expect(normalize(got)).toEqual(normalize(expected));
```

#### C) Snapshot — สำหรับ shape ใหญ่ที่ verify ได้ยาก

```js
expect(normalize(db)).toMatchSnapshot();
```

### 6.2 Normalization Rules

`helpers/snapshot-utils.mjs` ต้องทำ:

```js
export function normalize(obj) {
  return JSON.parse(JSON.stringify(obj, (key, value) => {
    if (typeof value === 'string') {
      // ISO timestamp
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return '<TS>';
      // UUID v4
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) return '<UUID>';
    }
    return value;
  }));
}
```

### 6.3 Time Freeze Pattern

ทุก test ที่ trigger mutation ของ `now()` ต้อง freeze เวลา:

```js
import { beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-05-02T10:00:00.000Z')));
afterEach(() => vi.useRealTimers());
```

---

## 7. Tauri Mock Strategy

### 7.1 In-memory FS

`tests/helpers/tauri-mock.mjs` provides:

```js
export class TauriMock {
  constructor(seedDir) { /* recursively copy fixture dir to in-memory map */ }

  invoke(cmd, args) {
    switch (cmd) {
      case 'read_text_file':  return this.fs.read(args.path);
      case 'write_text_file': return this.fs.write(args.path, args.contents);
      case 'read_dir':        return this.fs.list(args.path);
      case 'remove_file':     return this.fs.remove(args.path);
      case 'create_dir':      return this.fs.mkdir(args.path);
      case 'get_config':      return this.config.tasksDir ?? '';
      case 'set_config':      return this.config.tasksDir = args.tasksDir;
      case 'run_claude':      return this.claudeStub(args);  // injectable
    }
    throw new Error('Unknown Tauri command: ' + cmd);
  }

  setClaudeStub(fn) { this.claudeStub = fn; }
  flushToDisk(realPath) { /* dump in-memory FS to realPath for snapshot review */ }
}
```

### 7.2 setup.mjs

```js
import { TauriMock } from './helpers/tauri-mock.mjs';

beforeEach((ctx) => {
  const mock = new TauriMock();
  global.window = global.window ?? {};
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => mock.invoke(cmd, args) },
    event: { listen: () => () => {} },
  };
  ctx.tauri = mock;  // expose to test via context
});
```

---

## 8. Review/Rerun Flow Test Pattern

```js
import { runClaude } from '../../src/js/ai.mjs';

test('review re-run with session resume appends review entry and updates lastSessionId', async (ctx) => {
  ctx.tauri.seedFromFixture('pending-review-flow');
  ctx.tauri.setClaudeStub(({ sessionId }) => ({
    output: 'fixed the issues',
    session_id: sessionId ?? 'sess-new-456',
  }));

  const task = findTaskInProject(db, 'proj-x', 'task-rerun');
  const prevSid = task.lastSessionId;

  await runClaude({
    task, prompt: 'Please retry', sessionId: prevSid,
    playBtn: null, statusEl: stub(), terminal: stub(), prevStatus: 'pending_review',
  });

  expect(task.status).toBe('pending_review');
  expect(task.lastSessionId).toBe(prevSid);   // resumed → same sid
  expect(task.runHistory).toHaveLength(2);
  expect(task.activityLog.at(-1).action).toMatch(/run completed/);
});
```

---

## 9. Backward Compatibility Strategy

### 9.1 Round-trip invariant

```
load(legacy/tasks.json) → save() → reload()
   ↓
ผลลัพธ์ต้อง:
  1. ไม่ throw
  2. ทุก field เดิมยังอยู่ (id, title, createdAt, prompt, ฯลฯ)
  3. field ที่ขาด ถูก default-init ด้วย shape ที่ถูกต้อง:
     - subtasks: []
     - activityLog: []
     - reviews: []
     - tags: []
     - filesModified: []
     - runHistory: []
     - lastSessionId: null
  4. agentId resolve ผ่าน legacyToAgentId(aiAgent)
  5. version field ยัง '1.0' (ไม่ขึ้นเลขจน UI จะเปลี่ยน)
```

### 9.2 Test cases ต่อ legacy fixture

| # | Test | Fixture | Assertion |
|---|------|---------|-----------|
| L1 | load v0 schema | legacy-v0 | `db.projects.length > 0`, ไม่ throw |
| L2 | aiAgent → agentId | legacy-v0 | `resolveAgentId(task) === 'executor'` (default mapping) |
| L3 | missing arrays | legacy-no-runhistory | `task.runHistory ?? []` ไม่ทำให้ render crash |
| L4 | missing agents block | legacy-no-agents-block | `getAllAgents().length === 5` (bundled) |
| L5 | round-trip | legacy-minimal | normalize(reloaded) ครอบ normalize(initial-load) |
| L6 | save preserves order | legacy-v0 | `JSON.stringify` ของ projects array ตรง index เดิม |

---

## 10. Rust Integration Tests

### 10.1 commands_integration.rs

```rust
use tempfile::TempDir;

#[test]
fn read_text_file_returns_contents() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("tasks.json");
    std::fs::write(&path, r#"{"version":"1.0"}"#).unwrap();
    let result = read_text_file(path.to_string_lossy().into()).unwrap();
    assert_eq!(result, r#"{"version":"1.0"}"#);
}

#[test]
fn read_text_file_missing_returns_err() {
    let result = read_text_file("D:/does-not-exist.json".into());
    assert!(result.is_err());
}

#[test]
fn set_config_then_get_config_round_trip() {
    let dir = TempDir::new().unwrap();
    std::env::set_var("APPDATA", dir.path());
    set_config(r"D:\workspace".into()).unwrap();
    assert_eq!(get_config(), r"D:\workspace");
}
```

### 10.2 ครอบคลุม

| Command | Happy | Error | Edge |
|---------|:-----:|:-----:|:----:|
| `read_text_file` | ✅ | missing file | UTF-8 BOM |
| `write_text_file` | ✅ | readonly path | overwrite |
| `read_dir` | ✅ | missing dir | empty dir |
| `remove_file` | ✅ | missing | locked file (Windows) |
| `create_dir` | ✅ | already exists | nested |
| `get_config` / `set_config` | ✅ | corrupt config.json | legacy exe-dir fallback |

> **`run_claude` ไม่ test ใน CI** — gate ด้วย feature flag `--features test-claude` และให้ env var `CLAUDE_TEST_BIN` ชี้ไปที่ stub script

---

## 11. Test Orchestrator

### 11.1 scripts/run-tests.ps1

```powershell
$ErrorActionPreference = "Stop"

# ตาม CLAUDE.md
$env:PATH = "C:\Users\wit00\.cargo\bin;D:\msys64\mingw64\bin;$env:PATH"
$env:CARGO_HOME = "D:\cargo"

Write-Host "==> JS tests (vitest)"
npm test
$jsExit = $LASTEXITCODE

Write-Host "==> Rust tests (cargo)"
cargo test --manifest-path src-tauri/Cargo.toml
$rsExit = $LASTEXITCODE

Write-Host ""
Write-Host "Summary:"
Write-Host "  JS:   $(if ($jsExit -eq 0) {'PASS'} else {'FAIL'})"
Write-Host "  Rust: $(if ($rsExit -eq 0) {'PASS'} else {'FAIL'})"

exit ($jsExit + $rsExit)
```

### 11.2 package.json scripts ที่ต้องเพิ่ม

```json
"scripts": {
  "test":            "vitest run",
  "test:watch":      "vitest",
  "test:coverage":   "vitest run --coverage",
  "test:rust":       "cargo test --manifest-path src-tauri/Cargo.toml",
  "test:all":        "powershell -File scripts/run-tests.ps1"
}
```

---

## 12. Coverage Target

| Module group | Target lines | จริง (current est.) |
|--------------|:------------:|:-------------------:|
| `src/js/data.js` (pure helpers) | 90% | 0% |
| `src/js/fileops.js` (patch logic) | 85% | 0% |
| `src/js/agents/*` | 90% | 0% |
| `src/js/ai.js` (orchestration) | 70% | 0% |
| `src/js/render.js`, `detail.js`, `modals.js` (UI) | 50% | 0% |
| `src-tauri/src/main.rs` (Tauri commands) | 75% | 0% |
| `run_claude` Rust | exclude | — |

---

## 13. CI Integration (Future)

```yaml
# .github/workflows/test.yml — เปิดใช้เมื่อพร้อม
on: [push, pull_request]
jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
      - run: npm run test:coverage
      - run: cargo test --manifest-path src-tauri/Cargo.toml
      - uses: codecov/codecov-action@v4
```

---

## 14. การเพิ่ม Fixture/Test ใหม่

### Quick checklist

1. **สร้าง fixture folder** ใน `tests/fixtures/<name>/` — ใส่ `tasks.json` + `patches/.gitkeep`
2. **(ถ้าเป็น legacy)** เพิ่ม `tasks.expected.json` อธิบาย shape หลัง upgrade
3. **อัปเดต `tests/fixtures/README.md`** — บรรยาย invariants
4. **สร้าง test file** ใน `tests/<unit|integration|compat>/<name>.test.mjs`
5. **โหลดผ่าน helper** เสมอ: `loadFixture('<name>')` (จะ copy ไป temp dir)
6. **freeze time** ถ้า assert timestamp
7. **รัน `npm test -- <name>`** ก่อน commit เพื่อ verify

---

## 15. Roadmap & Task Mapping

ทดสอบครอบ 5 requirement ตาม `proj-test-001` goal:

| # | Requirement | Test files | Fixtures หลัก | Priority |
|---|-------------|------------|---------------|:---:|
| 1 | Data loading จาก tasks.json | `unit/data-helpers`, `integration/load-flow` | empty, baseline-current, mixed-status | high |
| 2 | Patch merge/sync | `unit/patch-merger`, `integration/patch-sync` | with-pending-patches, corrupt-patches | high |
| 3 | Task state transitions | `integration/task-state`, `unit/auto-escalate` | mixed-status, auto-escalate | high |
| 4 | Review/rerun flow | `integration/review-rerun-flow` | pending-review-flow | medium |
| 5 | Legacy backward compat | `compat/*`, `compat/round-trip` | legacy-v0, legacy-no-runhistory, legacy-no-agents-block, legacy-minimal | medium |

### Implementation order ที่แนะนำ

1. **เตรียม pre-flight refactor** (§3) — สกัด pure function ออกมา
2. **สร้าง `tests/helpers/`** ทั้งหมดก่อน (fixture-loader, tauri-mock, snapshot-utils)
3. **เริ่ม unit tests** (data-helpers, patch-merger, routing) — เพราะไม่ต้อง mock เยอะ
4. **สร้าง fixture แบบทีละชุด** ตามลำดับ priority — `baseline-current` ก่อน, แล้ว `with-pending-patches`
5. **Integration tests** หลังจาก unit ผ่านแล้ว
6. **Compat tests** สุดท้าย — pile บน foundation ที่นิ่งแล้ว
7. **Rust tests** parallel กับ JS — ไม่ต้องรอ
8. **(Optional) E2E** — กลับมาทำเมื่อทุกอย่างเสถียร

---

## 16. Trade-offs & Risks

| Risk | ผลกระทบ | Mitigation |
|------|---------|-----------|
| Refactor `applyPatch(patch, db)` กระทบ production code | medium | เพิ่ม `applyPatch` แบบใหม่ + wrapper เก่าไว้ก่อน, deprecate ในรอบถัดไป |
| jsdom ไม่ครอบคลุม Tauri-specific API | medium | ทุก Tauri call ผ่าน `tauriInvoke` → mock จุดเดียวพอ |
| Windows path separator (`\` vs `/`) ทำให้ test เปราะ | medium | ใช้ `path.join` / `path.normalize` ใน helper เสมอ |
| Snapshot bloat ทำ review diff ยาก | low | ใช้ `toMatchObject` ก่อน, snapshot เฉพาะ shape ใหญ่ |
| ระดับ refactor สูง → effort สูงในรอบแรก | high | แบ่งเป็น tier: unit ก่อน → integration → compat → e2e |
| Rust `run_claude` test ต้อง spawn process | high | ข้ามใน CI; กำหนด stub binary สำหรับ local manual |

---

## 17. Acceptance Criteria

ระบบทดสอบจะถือว่า "พร้อมใช้" เมื่อ:

- [ ] `npm run test:all` exit 0 บนเครื่อง dev (Windows)
- [ ] ทุก requirement (5 ข้อ) มี test file อย่างน้อย 1 ตัว
- [ ] ทุก fixture มี README entry
- [ ] coverage ผ่าน target ใน §12
- [ ] `docs/testing.md` (เอกสาร user-facing) เขียนเสร็จ
- [ ] Pre-flight refactor (§3) merge แล้วและ regression checklist ใน `docs/regression-checklist.md` ยังผ่านครบ
