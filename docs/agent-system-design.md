# Agent System Design for PwTask

## Goal

เพิ่มระบบ Agent ที่เลือกผู้ช่วยให้เหมาะกับงานได้ โดยไม่ผูก UI ตรงกับ `run_claude` และไม่ทำให้โค้ด frontend บวมกว่าเดิม

หลักการ:
- แยก **Agent Role** ออกจาก **Provider** และ **Model**
- ใช้ **registry กลาง** เพียงจุดเดียวสำหรับนิยาม agent
- ใช้ **adapter/execution service** เป็นตัวกลางเรียก provider จริง
- รองรับการขยายจาก Claude-only ไปหลาย provider โดยไม่ rewrite flow เดิม
- ยังต้องรองรับ `Manual` สำหรับงานที่ human ทำเอง

---

## Current Problem

สถานะปัจจุบันของแอป:
- task มี `aiAgent`, `model`, `prompt`
- UI มีตัวเลือก agent แบบ hardcoded (`Claude`, `ChatGPT`, `Copilot`, `Manual`)
- runtime จริงยังวิ่งผ่าน `run_claude`
- planner และ execution flow ยังรู้จัก Claude โดยตรง

ผลคือ `aiAgent` ตอนนี้เป็นเพียง label ทาง UI มากกว่าจะเป็นระบบ agent runtime จริง

---

## Target Architecture

```text
Task / Project
   -> Agent Resolver
      -> Agent Registry
      -> Routing Rules
   -> Execution Service
      -> Provider Adapter
         -> Claude Adapter
         -> Future: OpenAI Adapter
         -> Future: Copilot Adapter
         -> Manual Adapter
```

---

## Core Concepts

### 1) Agent Role
ความรับผิดชอบเชิงงาน เช่น
- `planner`
- `executor`
- `reviewer`
- `quickfix`
- `manual`

### 2) Provider
ตัว runtime ที่ใช้จริง เช่น
- `claude`
- `openai`
- `copilot`
- `manual`

### 3) Model
รุ่นของโมเดล เช่น
- `claude-haiku-4-5-20251001`
- `claude-sonnet-4-6`
- `claude-opus-4-7`

> ห้ามใช้ค่าตัวเดียวแทนทั้ง role/provider/model เพราะจะทำให้ระบบขยายยาก

---

## Proposed Agent Registry Schema

ไฟล์แนะนำ: `src/app/agents/registry.js`

```js
export const AGENT_REGISTRY = {
  planner: {
    id: 'planner',
    label: 'Planner',
    provider: 'claude',
    defaultModel: 'claude-opus-4-7',
    capabilities: ['plan_project', 'breakdown_tasks'],
    promptStyle: 'structured_planning',
    enabled: true
  },
  executor: {
    id: 'executor',
    label: 'Executor',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    capabilities: ['implement', 'refactor', 'bugfix'],
    promptStyle: 'delivery',
    enabled: true
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    capabilities: ['review', 'risk_check', 'regression_check'],
    promptStyle: 'critical_review',
    enabled: true
  },
  quickfix: {
    id: 'quickfix',
    label: 'Quick Fix',
    provider: 'claude',
    defaultModel: 'claude-haiku-4-5-20251001',
    capabilities: ['small_edit', 'cleanup'],
    promptStyle: 'fast_fix',
    enabled: true
  },
  manual: {
    id: 'manual',
    label: 'Manual',
    provider: 'manual',
    defaultModel: null,
    capabilities: [],
    promptStyle: null,
    enabled: true
  }
};
```

---

## Proposed Task Schema Evolution

### Minimum viable migration
เพิ่ม field ใหม่ โดยยัง backward compatible กับข้อมูลเดิม

```json
{
  "id": "task-xxx",
  "title": "Task title",
  "description": "...",
  "status": "todo",
  "priority": "high",
  "agentId": "executor",
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "prompt": "...",
  "lastSessionId": null,
  "runHistory": []
}
```

### Compatibility rule
- ถ้ามี `agentId` -> ใช้ `agentId`
- ถ้าไม่มี `agentId` แต่มี `aiAgent` -> map ค่าจาก legacy field
- ถ้าไม่มีทั้งคู่ -> default เป็น `manual` หรือ `executor` ตามบริบท

### Legacy mapping ที่แนะนำ
| legacy `aiAgent` | new `agentId` |
|---|---|
| `Claude` | `executor` |
| `ChatGPT` | `reviewer` หรือ `executor` ตาม task type |
| `Copilot` | `quickfix` |
| `Manual` | `manual` |

> หมายเหตุ: ตารางนี้เป็น default migration เท่านั้น ไม่ใช่ source of truth ระยะยาว

---

## Project-Level Defaults

แนะนำให้ project มีค่า default สำหรับ planning/execution ด้วย

```json
{
  "id": "proj-tauri-001",
  "name": "Desktop App (Tauri)",
  "agentDefaults": {
    "planner": "planner",
    "executor": "executor",
    "reviewer": "reviewer"
  }
}
```

ประโยชน์:
- ปุ่ม `✨ Plan` รู้ว่าจะใช้ agent ไหน
- task ใหม่ที่ไม่มี agent ชัดเจนจะมี default อัตโนมัติ

---

## Execution Service Contract

ไฟล์แนะนำ: `src/app/agents/execution-service.js`

```js
async function runTaskWithAgent({ task, promptOverride, sessionIdOverride })
async function planProjectWithAgent({ project, agentIdOverride })
async function reviewTaskWithAgent({ task, comment, sessionIdOverride })
```

### Responsibility
- resolve `agentId` -> registry entry
- resolve provider/model ที่จะใช้จริง
- เลือก adapter ให้ถูก provider
- normalize ผลลัพธ์เป็นรูปแบบเดียวกัน
- surface errors กลับ UI ให้ชัด

### Normalized result
```js
{
  ok: true,
  provider: 'claude',
  agentId: 'executor',
  model: 'claude-sonnet-4-6',
  output: '...',
  sessionId: 'abc123',
  raw: {}
}
```

และเมื่อ fail:
```js
{
  ok: false,
  provider: 'claude',
  agentId: 'executor',
  model: 'claude-sonnet-4-6',
  error: 'Authentication expired',
  exitCode: 1,
  raw: {}
}
```

---

## Provider Adapter Contract

ไฟล์แนะนำ:
- `src/app/agents/providers/claude.js`
- `src/app/agents/providers/manual.js`

ตัวอย่าง contract:

```js
async function run({ prompt, model, sessionId, workingDir, runId }) {
  return {
    ok: true,
    output: '...',
    sessionId: '...',
    raw: {}
  };
}
```

### Claude adapter
ภายในค่อยเรียก `tauriInvoke('run_claude', ...)`

### Manual adapter
ไม่รันจริง แต่คืนสถานะที่ UI เข้าใจได้ เช่น
```js
{ ok: false, error: 'Manual tasks cannot be auto-run' }
```

---

## Routing Rules

ไฟล์แนะนำ: `src/app/agents/routing.js`

Rule เริ่มต้นที่แนะนำ:
- ถ้า task มี `agentId` -> ใช้ค่านั้น
- ถ้า tag มี `plan` -> `planner`
- ถ้า tag มี `review` -> `reviewer`
- ถ้า tag มี `bugfix`, `feature`, `refactor` -> `executor`
- ถ้า tag มี `small`, `cleanup` -> `quickfix`
- ถ้า user เลือกเองจาก UI -> override rules ทั้งหมด

> เริ่มจาก deterministic rules ก่อน ยังไม่ต้องทำ AI auto-router

---

## UI Changes

### Task Detail
เปลี่ยนจาก dropdown hardcoded เป็น render จาก registry
- Agent
- Provider (read-only หรือ advanced)
- Model (override ได้)

### Add/Edit Task Modal
- เลือก `Agent Role`
- optional: แสดง provider/model ที่ resolved ได้

### Project Header
- ปุ่ม Plan ควร resolve agent ผ่าน project defaults/registry ไม่ hardcode Claude ตรง ๆ

### Review / Re-run
- ดึง execution path ผ่าน `runTaskWithAgent()` ไม่เรียก Claude โดยตรง

---

## Suggested File Structure

```text
src/
  index.html
  app/
    main.js
    state.js
    agents/
      registry.js
      routing.js
      execution-service.js
      legacy-mapping.js
      providers/
        claude.js
        manual.js
```

---

## Migration Plan

### Phase 1
- เพิ่ม registry
- เพิ่ม execution service
- เปลี่ยน UI ให้ใช้ registry list แทน hardcoded list
- ยังใช้ Claude adapter ตัวเดียวก่อน

### Phase 2
- เพิ่ม `agentId` ลง schema
- รองรับ legacy mapping จาก `aiAgent`
- เปลี่ยน Plan/Play/Review flow ให้ผ่าน execution service ทั้งหมด

### Phase 3
- เพิ่ม routing rules
- เพิ่ม project-level defaults
- เพิ่ม provider ใหม่ถ้าจำเป็น

---

## Acceptance Criteria

ระบบ Agent ถือว่าใช้ได้เมื่อ:
1. UI ไม่ hardcode รายชื่อ agent กระจัดกระจายหลายจุด
2. ปุ่ม Plan/Run/Review ใช้ execution service กลาง
3. task สามารถระบุ `agentId` ได้
4. legacy tasks ที่มีแค่ `aiAgent` ยังเปิด/แก้ไข/รันได้
5. Claude failure ถูก surface เป็น error ปกติ ไม่ถูกนับเป็น success
6. การเพิ่ม provider ใหม่ไม่ต้องแก้ทุก feature flow

---

## Recommendation for PwTask Now

ลำดับที่เหมาะที่สุด:
1. refactor `src/index.html` ให้ modular ก่อน
2. ดึง execution path ออกเป็น service
3. เพิ่ม agent registry
4. ค่อย migrate task schema

เหตุผล:
- ถ้าเพิ่ม agent system ตอนที่ frontend ยัง monolith จะทำให้จุดผูกกันเยอะขึ้น
- แต่สามารถเริ่มวาง schema/document/task plan ได้ทันทีตั้งแต่ตอนนี้
