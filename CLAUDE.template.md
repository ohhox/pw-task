# CLAUDE.md — AI Task Flow Instructions
#
# วิธีใช้ template นี้:
# 1. Copy ไฟล์นี้ไปวางใน root ของ project ใหม่ แล้ว rename เป็น CLAUDE.md
# 2. แก้ไขส่วน "Config" ให้ตรงกับ project นั้น
# 3. ลบ comment (#) ทั้งหมดก่อนใช้งาน

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
| `files_modified` | projectId, taskId, files[] |
| `add_log` | projectId, taskId, log {timestamp, agent, action} |

> **`note` บังคับ** เมื่อเปลี่ยน status — สรุปสั้นๆ ว่า session นี้ทำอะไรไป Dashboard จะแสดง note นี้ที่ task row ให้ human เห็นทันที

Dashboard จะ merge patches อัตโนมัติตามลำดับเวลาเมื่อเปิดโปรแกรม และลบ patch ที่ apply แล้วทิ้ง

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
# ← แก้ส่วนนี้ทุกครั้งที่ใช้กับ project ใหม่

- **tasks.json**: `D:\DEV\PwTask\outputs\tasks.json`
- **patches folder**: `D:\DEV\PwTask\outputs\patches\`
- **dashboard**: `D:\DEV\PwTask\outputs\dashboard.html`
- **Project ที่ active ใน tasks.json**: (ระบุชื่อ project และ projectId)

---

## กฎเพิ่มเติม

- ดู `projectId` และ `taskId` จาก `tasks.json` ก่อนเขียน patch ทุกครั้ง
- ถ้ายังไม่มี task ที่ตรงกับงาน → เพิ่มผ่าน patch (type: `add_task`) แทนการแก้ไฟล์ตรงๆ
- ถ้างานใหญ่ → แตกเป็น subtasks ก่อน แล้วค่อยเริ่ม
- ถ้าไม่แน่ใจว่า task ไหน active อยู่ → อ่าน `tasks.json` และถามก่อนเสมอ
- ไม่ลบ task เก่าออก — เปลี่ยน status เป็น `done` หรือ `blocked` แทน
