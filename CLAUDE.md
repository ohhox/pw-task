# CLAUDE.md — AI Task Flow Instructions

## ทุก session ต้องทำก่อนเริ่มงาน

1. อ่าน `tasks.json` ตาม path ในส่วน **Config** ด้านล่าง
2. ดู `_instructions.patchPattern` ในไฟล์นั้นเพื่อเข้าใจรูปแบบ patch
3. ถามว่าจะทำ task ไหน หรือ propose task ใหม่จาก goal ที่ได้รับ
4. เริ่มทำงานเมื่อได้รับ confirm แล้วเท่านั้น

---

## ทุก session ต้องทำหลังเสร็จงาน

> ⚠️ **ห้ามแก้ `tasks.json` โดยตรง** — ให้สร้าง patch file ใน `patches/` แทนเสมอ

สร้างไฟล์ใน **patches folder** (ดู path ในส่วน Config) ชื่อไฟล์:
```
YYYY-MM-DDTHH-MM-SS_Claude.json
```
เช่น `2026-05-02T10-30-00_Claude.json`

### รูปแบบ patch file

```json
{
  "version": "1.0",
  "timestamp": "2026-05-02T10:30:00.000Z",
  "agent": "Claude",
  "changes": [
    {
      "type": "status_change",
      "projectId": "proj-xxx",
      "taskId": "task-xxx",
      "from": "in_progress",
      "to": "pending_review",
      "note": "สิ่งที่ทำไปใน session นี้"
    },
    {
      "type": "files_modified",
      "projectId": "proj-xxx",
      "taskId": "task-xxx",
      "files": ["path/to/changed/file.ts"]
    }
  ]
}
```

### Change types ที่ใช้ได้

| type | fields ที่ต้องมี |
|------|-----------------|
| `status_change` | projectId, taskId, from, to, **note (บังคับ)** |
| `add_task` | projectId, parentTaskId (null = root), task (full object) |
| `update_task` | projectId, taskId, updates {field: value, ...}, note? — แก้ field ที่ allowlist: title, description, priority, agentId, aiAgent, model, prompt, tags |
| `files_modified` | projectId, taskId, files[] |
| `add_log` | projectId, taskId, log {timestamp, agent, action} |

> **`note` บังคับ** เมื่อเปลี่ยน status — เขียนสรุปสั้นๆ ว่า session นี้ทำอะไรไป เช่น `"แยก AuthService ออกแล้ว เพิ่ม 3 unit test ยังขาด refreshToken"` Dashboard จะแสดง note นี้ที่ task row และ detail panel ให้ human เห็นทันที

Dashboard จะ merge patches อัตโนมัติตามลำดับเวลาเมื่อเปิดโปรแกรม และลบ patch ที่ apply แล้วทิ้ง

### Schema ของ task object (สำหรับ add_task)

```json
{
  "id": "task-xxx-01",
  "title": "ชื่อ task",
  "description": "รายละเอียด (Markdown รองรับ)",
  "status": "todo",
  "priority": "high",
  "aiAgent": "Claude",
  "model": "claude-sonnet-4-6",
  "prompt": "คำสั่งสำหรับ Claude รัน task นี้",
  "tags": [],
  "reviews": [],
  "subtasks": [],
  "filesModified": [],
  "lastSessionId": null,
  "runHistory": [],
  "activityLog": [{ "timestamp": "...", "agent": "Claude", "action": "created task" }],
  "createdAt": "2026-05-02T10:00:00.000Z"
}
```

### Schema ของ project object (สำหรับ add_project)

```json
{
  "id": "proj-xxx",
  "name": "ชื่อ project",
  "description": "คำอธิบาย",
  "goal": "เป้าหมายหลักของ project",
  "workingDir": "D:\\DEV\\MyProject",
  "color": "#60a5fa",
  "createdAt": "2026-05-02T10:00:00.000Z",
  "tasks": []
}
```

---

## Status ที่ใช้

| Status | ความหมาย |
|--------|----------|
| `todo` | ยังไม่เริ่ม |
| `in_progress` | กำลังทำอยู่ใน session นี้ |
| `pending_review` | ทำเสร็จแล้ว รอ human ตรวจ |
| `done` | human approve แล้ว |
| `blocked` | ติดปัญหา รอ dependency |

> **สำคัญ**: Claude ตั้ง status เป็น `pending_review` ได้ แต่ **ห้ามตั้งเป็น `done` เอง** — ให้ human เป็นคนตัดสินใจผ่าน dashboard

---

## Config

- **tasks.json**: `D:\DEV\PwTask\outputs\tasks.json`
- **patches folder**: `D:\DEV\PwTask\outputs\patches\`
- **desktop app source**: `D:\DEV\PwTask\src\index.html` (frontend) + `D:\DEV\PwTask\src-tauri\src\main.rs` (Rust backend)

### Projects ใน tasks.json

| projectId | name | status |
|-----------|------|--------|
| `proj-tauri-001` | Desktop App (Tauri) | **active** — งานหลักปัจจุบัน |
| `e427a97f-5b25-4fef-bdc0-e5488c0e61e1` | NewsReport | มี task pending_review |

---

## โครงสร้างโปรเจกต์ (D:\DEV\PwTask)

```
src/
  index.html          ← frontend ทั้งหมด (single file)
src-tauri/
  src/main.rs         ← Rust backend, Tauri commands
  Cargo.toml
  tauri.conf.json
  capabilities/default.json
outputs/
  tasks.json          ← task database
  patches/            ← patch files (Claude เขียน, dashboard apply)
  tasks-archive.json  ← archived done tasks
```

### Tauri commands (Rust → JS) ที่มีอยู่แล้ว

| command | args | คำอธิบาย |
|---------|------|----------|
| `get_config` | — | อ่าน tasksDir จาก config.json ข้างๆ exe |
| `set_config` | tasksDir | บันทึก tasksDir ลง config.json |
| `read_text_file` | path | อ่านไฟล์ข้อความ |
| `write_text_file` | path, contents | เขียนไฟล์ข้อความ |
| `read_dir` | path | list ไฟล์ใน directory |
| `remove_file` | path | ลบไฟล์ |
| `run_claude` | prompt, model, sessionId?, workingDir?, runId | รัน claude CLI พร้อม streaming events `run-line:{runId}` และ `run-done:{runId}` |

### Build & Run

```powershell
# ต้องใส่ PATH ก่อนทุกครั้ง
$env:PATH = "C:\Users\wit00\.cargo\bin;D:\msys64\mingw64\bin;$env:PATH"
$env:CARGO_HOME = "D:\cargo"
cd D:\DEV\PwTask
npm run dev
```

> ⚠️ ถ้า build error "os error 32" ให้ kill process เก่าก่อน: `taskkill /F /IM ai-task-flow.exe`

---

## กฎเพิ่มเติม

- ดู `projectId` และ `taskId` จาก `tasks.json` ก่อนเขียน patch ทุกครั้ง
- ถ้ายังไม่มี task ที่ตรงกับงาน → เพิ่มผ่าน patch (type: `add_task`) แทนการแก้ไฟล์ตรงๆ
- ถ้างานใหญ่ → แตกเป็น subtasks ก่อน แล้วค่อยเริ่ม
- ถ้าไม่แน่ใจว่า task ไหน active อยู่ → อ่าน `tasks.json` และถามก่อนเสมอ
- ไม่ลบ task เก่าออก — เปลี่ยน status เป็น `done` หรือ `blocked` แทน
- แก้ `src/index.html` ได้โดยตรง (ไม่ต้องผ่าน patch) — patch ใช้เฉพาะ tasks.json เท่านั้น
