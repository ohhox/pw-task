# AI Task Flow

แอปพลิเคชัน Desktop สำหรับจัดการ workflow การพัฒนาซอฟต์แวร์ร่วมกับ AI Agent สร้างด้วย Tauri 2 + Vanilla JavaScript + Rust

---

## ภาพรวม

**AI Task Flow** ช่วยให้นักพัฒนาจัดการงานที่มอบหมายให้ AI Agent ได้อย่างเป็นระบบ โดยมีปรัชญาหลักคือ **Human oversight + AI autonomy** — AI สร้าง patch files แทนการแก้ไขฐานข้อมูลโดยตรง ส่วน human review และ approve ผ่าน dashboard

### ความสามารถหลัก

- จัดการ project และ task แบบ hierarchical (nested ลึกไม่จำกัด)
- รัน Claude CLI บน task ด้วย streaming output แบบ real-time
- ระบบ patch-based update — AI เขียน patch file แทนการแก้ `tasks.json` โดยตรง
- resume Claude session ข้าม session ได้
- Multi-agent system (Planner, Executor, Reviewer, Quick Fix, Manual)
- Auto-sync patches ทุก 30 วินาที และเมื่อ user กลับมาที่หน้าต่าง
- Activity log, run history, และ review tracking ต่อ task

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Tauri 2 |
| Frontend | Vanilla JavaScript, HTML5, CSS3 |
| Backend | Rust |
| IPC | Tauri invoke/listen |
| Data Storage | JSON files (`tasks.json`, `patches/*.json`) |
| Package Manager | npm |
| AI Integration | Claude CLI (`claude` binary) |

---

## โครงสร้างโปรเจกต์

```
D:\DEV\PwTask\
├── src/
│   ├── index.html                    ← Frontend ทั้งหมด (single-file app)
│   └── js/
│       ├── api.js                    ← Tauri IPC wrappers
│       ├── state.js                  ← Global state
│       ├── data.js                   ← Pure helpers (uuid, date, Markdown)
│       ├── fileops.js                ← File I/O + patch system
│       ├── render.js                 ← Sidebar + task list rendering
│       ├── detail.js                 ← Task detail panel
│       ├── modals.js                 ← Modal dialogs
│       ├── ai.js                     ← Claude execution + streaming
│       ├── main.js                   ← Event bindings + init
│       └── agents/
│           ├── registry.js           ← Agent definitions & CRUD
│           ├── routing.js            ← Agent selection logic
│           ├── execution-service.js  ← Task/project orchestration
│           ├── legacy-mapping.js     ← Backward compatibility
│           └── providers/
│               ├── claude.js         ← Claude adapter
│               └── manual.js         ← Manual agent placeholder
│
├── src-tauri/
│   ├── src/main.rs                   ← Rust backend (Tauri commands)
│   ├── Cargo.toml                    ← Rust dependencies
│   ├── tauri.conf.json               ← App config (window, bundle)
│   └── capabilities/default.json    ← Tauri permissions
│
├── outputs/
│   ├── tasks.json                    ← Task database หลัก
│   ├── patches/                      ← Patch files (AI เขียน, dashboard apply)
│   └── tasks-archive.json           ← Archived tasks
│
├── docs/
│   ├── agent-system-design.md
│   ├── e2e-testing.md                ← Tauri WebDriver smoke suite (Windows)
│   ├── regression-checklist.md
│   └── test-system-design.md
│
├── CLAUDE.md                         ← Instructions สำหรับ Claude agent
└── package.json
```

---

## การติดตั้งและ Build

### Prerequisites

- [Rust](https://rustup.rs/) (minimum 1.77.2)
- [Node.js](https://nodejs.org/) + npm
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (สำหรับ AI execution)
- MinGW64 (Windows) — C compiler สำหรับ Rust

### Setup

```powershell
# Clone โปรเจกต์
git clone https://github.com/ohhox/pw-task.git
cd pw-task

# ติดตั้ง npm dependencies (postinstall จะ bootstrap outputs/tasks.json จาก template ให้อัตโนมัติ)
npm install
```

> **Bootstrap ฐานข้อมูล:** `outputs/tasks.json` ถูก gitignore ไว้ — script `npm run setup` (รันอัตโนมัติหลัง `npm install`) จะ copy `outputs/tasks.template.json` → `outputs/tasks.json` ให้เครื่องใหม่ ถ้าไฟล์มีอยู่แล้วจะข้าม

### Run (Development)

```powershell
# ตั้งค่า PATH ก่อนทุกครั้ง
$env:PATH = "C:\Users\wit00\.cargo\bin;D:\msys64\mingw64\bin;$env:PATH"
$env:CARGO_HOME = "D:\cargo"

cd D:\DEV\PwTask
npm run dev
```

> **หมายเหตุ:** ถ้า build error "os error 32" ให้ kill process เก่าก่อน:
> ```powershell
> taskkill /F /IM ai-task-flow.exe
> ```

### Build (Production)

```powershell
$env:PATH = "C:\Users\wit00\.cargo\bin;D:\msys64\mingw64\bin;$env:PATH"
$env:CARGO_HOME = "D:\cargo"

npm run build
```

---

## Tauri Commands (Rust Backend)

| Command | Arguments | คำอธิบาย |
|---------|-----------|----------|
| `get_config` | — | อ่าน `tasksDir` จาก config.json |
| `set_config` | `tasksDir: String` | บันทึก `tasksDir` ลง config.json |
| `read_text_file` | `path: String` | อ่านไฟล์ข้อความ |
| `write_text_file` | `path, contents: String` | เขียนไฟล์ข้อความ |
| `read_dir` | `path: String` | list ไฟล์ใน directory |
| `remove_file` | `path: String` | ลบไฟล์ |
| `run_claude` | `prompt, model, sessionId?, workingDir?, runId` | รัน Claude CLI พร้อม streaming |

**Events ที่ emit จาก `run_claude`:**
- `run-line:{runId}` — output แต่ละบรรทัดระหว่าง execution
- `run-done:{runId}` — เมื่อ Claude command เสร็จสิ้น

Config ถูกเก็บที่ `%APPDATA%\ai-task-flow\config.json` (Windows)

---

## ระบบ Patch

AI agent **ไม่แก้ `tasks.json` โดยตรง** แต่สร้าง patch file แทน Dashboard จะ merge patches อัตโนมัติ

### รูปแบบชื่อไฟล์

```
outputs/patches/YYYY-MM-DDTHH-MM-SS_AgentName.json
```

ตัวอย่าง: `2026-05-02T10-30-00_Claude.json`

### Patch File Format

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
      "note": "สรุปสั้นๆ ว่า session นี้ทำอะไรไป"
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

### Change Types

| type | fields ที่ต้องมี |
|------|----------------|
| `status_change` | projectId, taskId, from, to, **note (บังคับ)** |
| `add_task` | projectId, parentTaskId (null = root), task (full object) |
| `add_project` | project (full object) |
| `files_modified` | projectId, taskId, files[] |
| `add_log` | projectId, taskId, log {timestamp, agent, action} |

---

## Task Status Lifecycle

```
todo → in_progress → pending_review → done
                   ↘ blocked
```

| Status | ความหมาย | ใครตั้งได้ |
|--------|----------|-----------|
| `todo` | ยังไม่เริ่ม | Human / AI |
| `in_progress` | กำลังทำ | AI (auto เมื่อรัน) |
| `pending_review` | เสร็จแล้ว รอตรวจ | AI |
| `done` | Human approve แล้ว | **Human เท่านั้น** |
| `blocked` | ติดปัญหา รอ dependency | Human / AI |

> AI **ห้ามตั้ง status เป็น `done` เอง** — Human ต้อง approve ผ่าน dashboard เสมอ

---

## Agent System

### Built-in Agents

| Agent ID | Label | Provider | Default Model | บทบาท |
|----------|-------|----------|---------------|-------|
| `planner` | Planner | claude | claude-opus-4-7 | วางแผน แตก task |
| `executor` | Executor | claude | claude-sonnet-4-6 | ลงมือทำ |
| `reviewer` | Reviewer | claude | claude-sonnet-4-6 | ตรวจสอบ code |
| `quickfix` | Quick Fix | claude | claude-haiku-4-5 | แก้ปัญหาเล็กน้อย |
| `manual` | Manual | manual | — | ทำด้วยมือ (ไม่รัน AI) |

### Agent Routing Priority

1. Task มี `agentId` ระบุตรง → ใช้ agent นั้น
2. Task มี legacy `aiAgent` field → map ผ่าน `legacyToAgentId`
3. Task tags มี routing hints (`plan`, `review`, etc.) → เลือก agent ที่เหมาะ
4. Default → `executor`

---

## Claude AI Integration

เมื่อกด ▶ บน task:

1. ตั้ง task status → `in_progress`
2. ส่ง prompt ไปยัง Claude CLI ผ่าน Tauri command `run_claude`
3. Stream output ทีละบรรทัดแสดงใน terminal panel
4. เมื่อเสร็จ:
   - ตั้ง status → `pending_review`
   - บันทึก `lastSessionId` (สำหรับ resume)
   - บันทึก run history (timestamp, model, agentId, sessionId)
   - เพิ่ม activity log

**Session Resume:** task เก็บ `lastSessionId` ไว้ ครั้งถัดไปที่รันจะ resume conversation เดิมกับ Claude

**Project Planning:** กด "✨ Plan" บน project header → Claude Opus วิเคราะห์ goal และสร้าง task list อัตโนมัติ

---

## ไฟล์ Config หลัก

| ไฟล์ | ที่เก็บ | หน้าที่ |
|------|--------|--------|
| `config.json` | `%APPDATA%\ai-task-flow\` | เก็บ path ของ `tasksDir` |
| `tasks.json` | เลือกได้ (default: `outputs/`) | ฐานข้อมูล project + task |
| `tasks-archive.json` | เดียวกับ tasks.json | Archived tasks |
| `patches/*.json` | `outputs/patches/` | AI-generated change logs |
| `CLAUDE.md` | root project | Instructions สำหรับ Claude agent |

---

## UI Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  🗂 AI Task Flow     A⁻ A A⁺  [⚙ Agents] [📂] [📦] [🔄] [💾]  │
├──────────────────┬──────────────────────────────────────────────┤
│  PROJECTS        │  🎯 Project Goal                              │
│  ─────────────   │  📁 /path/to/working/dir                     │
│  ● Project A  3  │                                              │
│  ○ Project B  1  │  [✨ Plan] [Edit] [📋 Export] [Delete]       │
│                  │  ──────────────────────────────────           │
│  SUMMARY         │  🔍 [search...] [status▼] [agent▼] [clear]  │
│  Todo      5     │                                              │
│  Doing     2     │  ▼ Task Title              [badge] [▶]       │
│  Review    1     │    ├─ Subtask 1                              │
│  Done      8     │    └─ Subtask 2                              │
│  Blocked   0     │  ▶ Another Task             [badge] [▶]      │
└──────────────────┴──────────────────────────────────────────────┘
```

---

## สำหรับ AI Agent

ดูคำแนะนำการสร้าง patch และรูปแบบ task/project object ได้ที่ [CLAUDE.md](./CLAUDE.md)

ไฟล์ `tasks.json` มี `_instructions.patchPattern` ที่อธิบายรูปแบบ patch สำหรับ AI โดยเฉพาะ
