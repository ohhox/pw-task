# Test Fixtures

แต่ละ subfolder คือ scenario อิสระสำหรับทดสอบ dashboard behavior  
ทุก folder มีโครงสร้าง: `tasks.json` + `patches/`

---

## Scenarios

### `empty/`
**ทดสอบ:** การแสดงผล empty state เมื่อไม่มี project เลย

- `tasks.json` — `projects: []` ไม่มี project ใดๆ
- `patches/` — ว่างเปล่า

**Expected behavior:**
- Dashboard แสดง empty state / "No projects" message
- ไม่มี error จากการ loop projects array ว่าง
- ปุ่ม "Create Project" ยังใช้งานได้ปกติ

---

### `single-project/`
**ทดสอบ:** baseline rendering กับ project เดียวที่มี tasks ครบ fields

- `tasks.json` — 1 project, 3 tasks: `done`, `in_progress`, `todo`
- `patches/` — ว่างเปล่า (state สมบูรณ์ใน tasks.json แล้ว)

**Expected behavior:**
- Project card แสดงชื่อ, สี, goal, workingDir
- Task rows แสดง status badge ถูกต้องทุกอัน
- Task ที่ `done` แสดง `completedAt`, `lastNote`, `reviews`
- Task ที่ `in_progress` แสดง `lastSessionId`, `runHistory`

---

### `nested-subtasks/`
**ทดสอบ:** subtask tree ซ้อนกัน 3 ระดับ (task → subtask → sub-subtask)

- `tasks.json` — 1 project, 1 root task มี 3 subtasks; subtask แรกมี sub-subtasks อีก 3 ระดับ
- `patches/` — ว่างเปล่า

**Expected behavior:**
- Dashboard render subtask tree ถูกต้องทุกระดับ
- Expand/collapse subtask tree ทำงานได้
- Status ของ parent task อิสระจาก subtasks (parent=`in_progress` แม้บาง subtask=`done`)
- Sub-subtask ที่ไม่มี `prompt`/`model` ไม่ crash

---

### `with-pending-patches/`
**ทดสอบ:** patch apply logic — dashboard ต้อง merge patches ก่อนแสดงผล

- `tasks.json` — state เริ่มต้น: 2 tasks (`task-p-01`=`in_progress`, `task-p-02`=`pending_review`)
- `patches/` — 3 patch files เรียงตามเวลา:
  1. `10:00` — `status_change` task-p-01: `in_progress` → `pending_review` + `files_modified`
  2. `10:15` — `files_modified` + `add_log` สำหรับ task-p-02
  3. `10:30` — `add_task` เพิ่ม task-p-03 ใหม่ (ไม่มีใน tasks.json เดิม)

**Expected behavior หลัง apply patches:**
- task-p-01 status = `pending_review` (เปลี่ยนจาก `in_progress`)
- task-p-02 มี filesModified 2 ไฟล์ + activityLog เพิ่มขึ้น 1 entry
- task-p-03 ปรากฏขึ้นใหม่ (ถูกเพิ่มโดย patch)
- Patches ถูกลบออกหลัง apply แล้ว

---

### `legacy-schema/`
**ทดสอบ:** backward compatibility กับ data schema เก่าที่ขาด fields ใหม่

- `tasks.json` — ไม่มี `_instructions` ที่ root, ไม่มี `goal`/`workingDir` ใน project, tasks ไม่มี `prompt`/`model`/`lastSessionId`/`runHistory`/`lastNote`
- `patches/` — ว่างเปล่า

**Fields ที่ขาดหายโดยเจตนา:**
| Field | ระดับ | หมายเหตุ |
|-------|-------|----------|
| `_instructions` | root | เพิ่งเพิ่มใน v1.0 |
| `goal`, `workingDir` | project | optional fields |
| `prompt`, `model` | task | optional — task เก่าไม่มี |
| `lastSessionId`, `runHistory`, `lastNote` | task | optional — task เก่าไม่มี |
| `activityLog` | task | task-l-02 ไม่มี field นี้ |
| `createdAt` | task | task-l-03 ไม่มี field นี้ |
| `reviews` | task | task-l-04 เป็น string[] แทน object[] |

**Expected behavior:**
- Dashboard ไม่ crash เมื่อ optional fields หายไป
- Fallback gracefully: `null`, `[]`, หรือ `-` แทน undefined values
- ▶ Play / ✨ Plan ปุ่มไม่แสดงเมื่อ `prompt` ว่าง (หรือ disabled)
- reviews format เก่า (string[]) แสดง fallback แทน crash

---

### `corrupted/`
**ทดสอบ:** error handling เมื่อ data ไม่ถูกต้องหรือ patch file เสีย

- `tasks.json` — มีข้อมูลผิดพลาดโดยเจตนา:
  - `task-c-01` — status ไม่อยู่ใน enum (`"unknown_status"`)
  - `task-c-02` — `priority: null`
  - `task-c-01` (ซ้ำ) — id ซ้ำกับ task แรก
  - `task-c-03` — `subtasks`, `tags`, `reviews`, `filesModified`, `activityLog` ทั้งหมดเป็น `null`
  - `task-c-04` — `activityLog` entries ผิดรูปแบบ (ขาด fields)
  - project id ซ้ำ (`proj-corrupt-001` สองครั้ง)
- `patches/` — 3 patch files ที่เสีย:
  1. `11:00` — อ้าง `taskId` ที่ไม่มีอยู่
  2. `11:15` — JSON syntax error (parse ไม่ได้เลย)
  3. `11:30` — `change type` ที่ระบบไม่รู้จัก + `projectId` ที่ไม่มีอยู่

**Expected behavior:**
- Dashboard ไม่ crash เมื่อเจอ data ผิดปกติ
- Patch ที่ parse ไม่ได้ถูก skip (log error แต่ไม่หยุด)
- Patch ที่อ้าง id ไม่มีอยู่ถูก skip gracefully
- Unknown change type ถูก skip แทนที่จะ throw
- Null arrays ถูก treat เป็น `[]`

---

### `mixed-status/`
**ทดสอบ:** การแสดง status badge, filter, และ color coding ครบทุกค่า

- `tasks.json` — 1 project, 5 tasks หนึ่งอันต่อ status:
  - `task-m-01` → `todo`
  - `task-m-02` → `in_progress`
  - `task-m-03` → `pending_review`
  - `task-m-04` → `done`
  - `task-m-05` → `blocked`
- `patches/` — ว่างเปล่า

**Expected behavior:**
- Status badge แต่ละอันมีสีถูกต้องตาม design
- Filter by status กรอง task ได้ครบทุกค่า
- Summary counts ใน project header ถูกต้อง (1 per status)
- `blocked` task แสดง visual distinction ชัดเจน
- `done` task แสดง `completedAt` และ `reviews`

---

## การใช้งาน

```js
// ตัวอย่าง load fixture ในการทดสอบ
const tasksJson = await readFile('./tests/fixtures/mixed-status/tasks.json', 'utf-8');
const state = JSON.parse(tasksJson);

// apply patches ก่อน (เฉพาะ with-pending-patches scenario)
const patchFiles = await readDir('./tests/fixtures/with-pending-patches/patches/');
const finalState = applyPatches(state, patchFiles);
```

## Schema Reference

ดู [CLAUDE.md](../../CLAUDE.md) สำหรับ full schema ของ task object, project object, และ patch file format
