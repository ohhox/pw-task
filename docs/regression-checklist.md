# Regression Checklist — AI Task Flow Desktop App

เอกสารนี้ใช้สำหรับ verify พฤติกรรมของ app หลัง refactor (task-t-08)
ทดสอบทุก flow ด้านล่าง และติ๊ก ✅ หรือบันทึก ❌ issue ที่พบ

---

## 1. Startup / Folder Selection

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 1.1 | เปิด app ครั้งแรก (ยังไม่มี config) | แสดง Welcome screen, ไม่มี project-view | |
| 1.2 | กด "Change Folder" เลือก folder ที่ไม่มี tasks.json | แสดงข้อความ error ใน welcome-msg | |
| 1.3 | กด "Change Folder" เลือก folder ที่มี tasks.json | โหลด projects ขึ้นใน sidebar ได้ | |
| 1.4 | เปิด app ครั้งที่สอง (มี config เก่า) | restore folder อัตโนมัติ แสดง projects ทันที | |
| 1.5 | ลบ project ทั้งหมด → กด "Delete" project สุดท้าย | กลับไป Welcome screen, detail panel ปิด | |

---

## 2. Patch Sync

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 2.1 | มี .json ไฟล์ใน patches/ เมื่อเปิด app | apply อัตโนมัติ, toast "Applied N patches", patch ถูกลบ | |
| 2.2 | กด "🔄 Sync" เมื่อไม่มี patch ใหม่ | ไม่มี toast, ปุ่มกลับเป็น 🔄 Sync | |
| 2.3 | วาง patch file ระหว่าง app รันอยู่ → กด Sync | apply patch, re-render sidebar + task list | |
| 2.4 | tasks.json write ล้มเหลว (disk full) | toast "Save failed — patches NOT deleted", patch ยังอยู่ใน patches/ | |
| 2.5 | patch file มี JSON ผิดรูปแบบ | skip patch นั้น, log warning ใน console, ไม่ crash | |

---

## 3. Project Management

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 3.1 | กด "＋ New Project" ใส่ชื่อ → Create | project ปรากฏใน sidebar, active ทันที | |
| 3.2 | สร้าง project โดยไม่ใส่ชื่อ → กด Create | toast "Name is required", modal ยังอยู่ | |
| 3.3 | เลือก color swatch ใน New Project modal | สี update, native picker sync | |
| 3.4 | เปลี่ยนสีผ่าน native color input | swatch deselect, สีถูกบันทึก | |
| 3.5 | กด "✏️ Edit" project | modal เปิดพร้อมข้อมูลเดิม, แก้แล้ว Save update ได้ | |
| 3.6 | แก้สี project ใน Edit modal → Save | dot สีใน sidebar/header อัพเดท | |
| 3.7 | กด "🗑 Delete" project → ยืนยัน | project หายจาก sidebar, app ไม่ crash | |
| 3.8 | กด "📋 CLAUDE.md" → ใส่ path → Copy | clipboard มีเนื้อหา CLAUDE.md ถูกต้อง | |

---

## 4. Task List

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 4.1 | กด "＋ New Task" → ใส่ title → Create | task ปรากฏใน list, status = todo | |
| 4.2 | สร้าง task โดยไม่ใส่ title | toast "Title is required", modal ยังอยู่ | |
| 4.3 | กด "＋ Sub" ใต้ task | subtask modal เปิด, subtask อยู่ใต้ parent | |
| 4.4 | กด "▶"/"▼" expand/collapse subtasks | toggle ได้ถูกต้อง, ไม่กระทบ selection | |
| 4.5 | กด task row | detail panel เปิด, row highlight เป็น selected | |
| 4.6 | กด task row อื่น | highlight ย้ายไป row ใหม่ โดยไม่ re-render ทั้ง list | |
| 4.7 | เปลี่ยน status ผ่าน dropdown ใน row | status badge อัพเดท, save trigger | |
| 4.8 | กด "✏️" → แก้ task → Save | title/status/agent อัพเดทใน list | |
| 4.9 | กด "🗑" → ยืนยัน Delete | task หายจาก list, detail panel ปิดถ้า task นั้น selected | |
| 4.10 | task ถูก delete ขณะ selected | selectedTaskPath = null, detail panel ปิด | |

---

## 5. Filter / Search

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 5.1 | พิมพ์ใน search box | filter tasks แบบ real-time | |
| 5.2 | filter ตาม Status | แสดงเฉพาะ task ที่ status ตรง | |
| 5.3 | filter ตาม Agent | แสดงเฉพาะ task ที่ agentId หรือ aiAgent ตรง | |
| 5.4 | filter ตาม Priority | แสดงเฉพาะ task priority ตรง | |
| 5.5 | กด "✕ Clear" | filter reset ทั้งหมด, แสดง task ทั้งหมด | |
| 5.6 | filter แล้วไม่มี task match | แสดง "No tasks match your filter" | |

---

## 6. Detail Panel

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 6.1 | คลิก task → เปิด detail | แสดง title, status, priority, agent, model, prompt | |
| 6.2 | กด "✕" ปิด detail | panel ซ่อน, selected class หายจาก row (ไม่ re-render list) | |
| 6.3 | แก้ title ใน detail (blur/Enter) | list row title อัพเดท, save trigger | |
| 6.4 | เปลี่ยน status ใน detail | list row badge อัพเดท, sidebar count อัพเดท | |
| 6.5 | เปลี่ยน agent ใน detail | model dropdown แสดง default ของ agent ใหม่ | |
| 6.6 | คลิก "Copy ID" | clipboard มี task ID | |
| 6.7 | เพิ่ม/ลบ tag | tag wrap refresh ทันที | |
| 6.8 | เปิด Description → Edit → Save | markdown render ถูกต้อง | |
| 6.9 | เพิ่ม/ลบ file ใน Files Modified | list refresh ทันที | |

---

## 7. AI Run (Play Task)

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 7.1 | task ที่ไม่มี prompt → ปุ่ม Run disabled | ปุ่ม Run เป็น disabled | |
| 7.2 | ใส่ prompt → กด "▶ Run" | terminal แสดง output แบบ streaming | |
| 7.3 | run สำเร็จ | status → pending_review, lastNote บันทึก, sessionId บันทึก | |
| 7.4 | run ล้มเหลว (claude ไม่พร้อม) | toast/statusEl แสดง error, ปุ่ม Run กลับมา enable | |
| 7.5 | task.agentId = 'manual' → กด Run | error "Manual tasks cannot be auto-run" | |

---

## 8. Review Flow

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 8.1 | task status = pending_review → เปิด detail | Review panel แสดง (Approve / Request Changes) | |
| 8.2 | กด "✅ Approve" | status → done, review entry บันทึก | |
| 8.3 | กด "↩️ Request Changes" ไม่ใส่ comment | toast "กรุณาใส่ comment ก่อน" | |
| 8.4 | ใส่ comment → Request Changes | status → in_progress, review entry บันทึก | |
| 8.5 | กด "🔄 Fresh Re-run" | re-run พร้อม feedback ใน prompt | |
| 8.6 | กด "▶ Resume Session" (มี sessionId) | re-run ต่อ session เดิม | |
| 8.7 | กด "▶ Resume Session" ไม่มี sessionId | ปุ่ม disabled | |

---

## 9. Plan Project

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 9.1 | project ไม่มี Goal → กด "✨ Plan" | toast "กรุณาใส่ Goal ก่อน" | |
| 9.2 | project มี Goal → กด "✨ Plan" | modal เปิด, streaming output แสดง | |
| 9.3 | plan สำเร็จ (Claude ตอบ JSON) | tasks ถูกสร้างใน project, toast แสดงจำนวน | |

---

## 10. Save / Persistence

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 10.1 | แก้ task → รอ 1 วิ (auto-save) | save-status แสดง "Saved · just now" | |
| 10.2 | กด Ctrl+S | save ทันที | |
| 10.3 | กด "💾 Save" | save ทันที | |
| 10.4 | เปิด app ใหม่ → ข้อมูลยังอยู่ | data persist ถูกต้อง | |

---

## 11. Archive

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 11.1 | กด "📦 Archive" เมื่อไม่มี fully-done task | toast "ไม่มี task ที่ fully done" | |
| 11.2 | มี task ที่ status=done และ subtasks ทั้งหมด done → Archive | task ย้ายไป tasks-archive.json, หายจาก list | |

---

## 12. Misc

| # | Test case | Expected | Result |
|---|-----------|----------|--------|
| 12.1 | กด "A" (font size toggle) | ขนาดตัวอักษรเปลี่ยน 3 ระดับ (S→M→L→S) | |
| 12.2 | ปิด/เปิด app ใหม่ → font size คงไว้ | localStorage restore ได้ | |
| 12.3 | กด Escape ขณะ modal เปิด | modal ปิด | |
| 12.4 | switch project | task list / header อัพเดท, detail panel ปิด | |
| 12.5 | Tab back มา app | checkPatches() trigger อัตโนมัติ | |
