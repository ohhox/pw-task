# PwTask — Testing Guide

ระบบทดสอบมี 3 tier: **JS unit tests** (vitest), **Rust integration tests** (cargo test), **E2E smoke** (WebdriverIO + tauri-driver)

---

## 1. รัน Tests ทั้งหมด

```powershell
# ตั้ง PATH ก่อนทุกครั้ง (ตาม CLAUDE.md)
$env:PATH = "C:\Users\wit00\.cargo\bin;D:\msys64\mingw64\bin;$env:PATH"
$env:CARGO_HOME = "D:\cargo"

# รันทุก test (Rust + JS) ผ่าน orchestrator
.\scripts\run-tests.ps1
```

หรือรันแยก tier:

| คำสั่ง | ผล |
|--------|-----|
| `npm test` | JS unit tests (vitest, ~0.6s) |
| `npm run test:coverage` | JS + coverage report ใน `coverage/` |
| `cd src-tauri && cargo test` | Rust integration tests (~3 min ครั้งแรก, ~0.1s หลังจาก) |
| `npm run test:e2e` | E2E smoke — ต้องมี release build + tauri-driver ก่อน (ดู `docs/e2e-testing.md`) |

---

## 2. โครงสร้าง Test Files

```
tests/
  helpers/
    patch-core.js          pure ESM module (applyPatch, autoEscalate, isFullyDone, …)
  fixtures/
    empty/                 db ว่าง — ตรวจ no-crash baseline
    single-project/        1 project, tasks หลากหลาย
    nested-subtasks/       task tree ลึก 3 ระดับ — ทดสอบ autoEscalate
    mixed-status/          1 task ต่อ status (todo/in_progress/pending_review/done/blocked)
    legacy-schema/         schema เก่า — ขาด field ใหม่ (prompt, model, activityLog, …)
    with-pending-patches/  tasks.json + 3 patch files — ทดสอบ applyPatches pipeline
    corrupted/             bad data (unknown_status, null fields, duplicate ids)
  patch-merger.test.js     applyPatch / applyPatches ทุก change type
  task-state.test.js       status transitions, autoEscalate, isFullyDone, findTaskAnywhere
  review-rerun-flow.test.js approve/request-changes/full-cycle/blocked flows
  backward-compat.test.js  legacy + corrupted fixtures — no-crash + graceful fallback
  e2e/
    smoke.spec.ts          launch → load → click → sync patch → restart
    fixtures/smoke-workspace/  workspace จำลองสำหรับ E2E
    wdio.conf.cjs          WebdriverIO config

src-tauri/tests/
  commands_integration.rs  Rust tests สำหรับ FS commands (read, write, remove, config)
```

---

## 3. Mapping Requirements → Tests

| Requirement | Test file | Fixtures ที่ใช้ |
|-------------|-----------|----------------|
| Data loading — JSON parse, version, projects array | `backward-compat.test.js` | legacy-schema, corrupted, empty |
| Patch merge/sync — ทุก change type, ordering, idempotency | `patch-merger.test.js` | with-pending-patches |
| Task state transitions — todo→in_progress→pending_review→done/blocked | `task-state.test.js` | mixed-status |
| Auto-escalate — parent escalate/demote ตาม subtask state | `task-state.test.js` | nested-subtasks (+ in-memory) |
| Review/rerun flow — approve, request-changes, re-submit, full cycle | `review-rerun-flow.test.js` | mixed-status, nested-subtasks |
| Legacy backward compat — missing fields, old reviews format | `backward-compat.test.js` | legacy-schema |
| Tauri FS commands — read/write/remove/dir/config | `src-tauri/tests/commands_integration.rs` | all fixtures |
| E2E smoke — launch, project tree, detail, sync, restart | `tests/e2e/smoke.spec.ts` | smoke-workspace |

---

## 4. เพิ่ม Fixture ใหม่

1. สร้าง folder ใน `tests/fixtures/<name>/`
2. เพิ่ม `tasks.json` ที่มี `"version": "1.0"` และ `"projects": [...]`
3. ถ้ามี patches ให้สร้าง `patches/` subfolder พร้อม JSON files
4. เพิ่ม scenario ใน Rust test `read_dir_lists_all_fixture_scenarios` ถ้าต้องการ verify จาก Rust ด้วย
5. Import ใน test file ที่เกี่ยวข้องผ่าน `fixture('name/tasks.json')`

**Template ขั้นต่ำ:**

```json
{
  "version": "1.0",
  "lastUpdated": "2026-05-02T10:00:00.000Z",
  "projects": [
    {
      "id": "proj-xxx-001",
      "name": "...",
      "color": "#60a5fa",
      "createdAt": "2026-05-02T10:00:00.000Z",
      "tasks": []
    }
  ]
}
```

---

## 5. Coverage

### JS (vitest + V8)

```powershell
npm run test:coverage
# รายงาน HTML → coverage/index.html
# รายงาน text summary → stdout
```

Config อยู่ใน `package.json` (section `"test:coverage"`) — ใช้ `@vitest/coverage-v8` ไม่ต้อง instrument source

**เป้าหมาย**: ≥ 80% statements บน `tests/helpers/patch-core.js`

Coverage ปัจจุบัน:

| Module | Statements | Functions | Branches | Lines |
|--------|-----------|-----------|---------|-------|
| `patch-core.js` | **100%** | **100%** | **75%** | **100%** |

Branch ที่ยังไม่ครอบคลุม: บาง guard condition ใน add_task (เช่น `parentTaskId` ที่ไม่ match ใน sub-subtask tree) — ยอมรับได้เนื่องจาก path นั้นไม่เกิดในการใช้งานจริง

### Rust (cargo-llvm-cov)

```powershell
# ต้องติดตั้งก่อน (ครั้งเดียว):
cargo install cargo-llvm-cov

# รัน coverage:
cd src-tauri
cargo llvm-cov --html --output-dir ../coverage/rust
# report → coverage/rust/index.html
```

**เป้าหมาย**: ≥ 70% lines บน `src/main.rs` command handlers

---

## 6. Troubleshooting บน Windows

| ปัญหา | สาเหตุ | แก้ |
|-------|--------|-----|
| `cargo: command not found` | PATH ไม่รวม `.cargo\bin` | ตั้ง `$env:PATH` ตาม CLAUDE.md ก่อนรัน |
| `os error 32` ตอน build | exe กำลัง run อยู่ | `taskkill /F /IM ai-task-flow.exe` |
| Rust test timeout | package cache lock จาก parallel build | รอให้ build แรกเสร็จก่อน หรือรัน `cargo test` เดี่ยวๆ |
| vitest ไม่เจอ test files | `"type": "module"` missing | ตรวจ `package.json` มี `"type": "module"` |
| E2E: msedgedriver version mismatch | WebView2 runtime อัปเดตแต่ driver ไม่ได้อัปเดต | ดาวน์โหลด `msedgedriver.exe` ที่ตรงกับ WebView2 ใน `winver` → Edge version |
| E2E: app ไม่ launch | ยังไม่ได้ `cargo build --release` | รัน `cargo build --release` ใน `src-tauri/` ก่อน |

---

## 7. Pre-commit Checklist (สั้น)

```powershell
.\scripts\run-tests.ps1   # ต้องผ่านทุก test ก่อน push
```

ถ้าแก้ไขโค้ดใน `tests/helpers/patch-core.js` → ต้องอัปเดต `src/js/fileops.js` ให้ตรงกันด้วย (ทั้งสองต้อง mirror กัน)
