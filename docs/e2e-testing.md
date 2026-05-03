# E2E Testing — Tauri WebDriver Smoke Suite

> เอกสารนี้อธิบายการรัน E2E suite (`npm run test:e2e`) ของ AI Task Flow และข้อจำกัดของ
> WebDriver บน Windows ที่ต้องรู้ก่อนใช้งาน

---

## 1. Stack ที่เลือก

| Layer | Tool | หมายเหตุ |
|-------|------|----------|
| Driver proxy | **`tauri-driver`** (cargo bin) | proxy ระหว่าง WebdriverIO ↔ `msedgedriver` ที่คุยกับ WebView2 |
| Browser/webview driver | **`msedgedriver.exe`** | ต้องตรงกับเวอร์ชัน WebView2 runtime ที่ติดตั้งบนเครื่อง |
| Test runner | **WebdriverIO v9** + Mocha | spec เขียนเป็น TypeScript (`smoke.spec.ts`) |
| Assertions | `expect-webdriverio` | retry-aware assertions สำหรับ DOM ที่ render แบบ async |

> **ทำไมไม่ใช้ Playwright?** Playwright พูด CDP/WebKit ตรงกับ Chromium/Firefox/WebKit เท่านั้น —
> ไม่รองรับ WebView2 ของ Tauri ที่เปิดผ่าน external WebDriver session ทำให้ไม่สามารถ attach
> ไปยังหน้าต่าง Tauri ได้ การใช้ `tauri-driver` จึงเป็นเส้นทางทางการเดียวบน Windows

---

## 2. ติดตั้ง Pre-requisites (ทำครั้งเดียว)

```powershell
# 1) ตั้ง PATH/CARGO_HOME ตาม CLAUDE.md ก่อนรันทุกคำสั่งใน session นี้
$env:PATH = "C:\Users\wit00\.cargo\bin;D:\msys64\mingw64\bin;$env:PATH"
$env:CARGO_HOME = "D:\cargo"

# 2) ติดตั้ง tauri-driver (binary จะอยู่ที่ %CARGO_HOME%\bin\tauri-driver.exe)
cargo install tauri-driver --locked

# 3) ดาวน์โหลด msedgedriver.exe ให้ตรงกับ WebView2 runtime ที่ติดตั้ง
#    - เช็คเวอร์ชัน WebView2: เปิด "Settings > Apps" ค้นหา "Microsoft Edge WebView2 Runtime"
#    - โหลดจาก: https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver/
#    - เอา msedgedriver.exe ไปวางใน folder ที่อยู่บน PATH (เช่น C:\Users\wit00\.cargo\bin)

# 4) ติดตั้ง npm dev deps (รวม @wdio/* + tsx)
npm install
```

> ❗ ถ้า `msedgedriver` รุ่นไม่ตรงกับ WebView2 runtime จะเจอ error เปิด session ไม่ได้
> หรือ session timeout — ต้อง re-download driver ใหม่

---

## 3. รัน E2E Suite

```powershell
# 1) (ครั้งแรกหรือเมื่อ Rust code เปลี่ยน) build release exe — ใช้เวลา 5–10 นาที
$env:PATH = "C:\Users\wit00\.cargo\bin;D:\msys64\mingw64\bin;$env:PATH"
$env:CARGO_HOME = "D:\cargo"
cargo build --release --manifest-path src-tauri\Cargo.toml

# 2) รัน suite — wdio.conf.cjs จะ skip rebuild ถ้า exe อยู่แล้ว
npm run test:e2e
```

`wdio.conf.cjs` จะจัดการ lifecycle ทั้งหมดให้:
1. `onPrepare` — `cargo build --release` ถ้ายังไม่มี exe
2. `beforeSession` — spawn `tauri-driver` listen ที่ `127.0.0.1:4444`
3. รัน spec — `tauri-driver` launch exe และ proxy ไปยัง `msedgedriver`
4. `afterSession` — kill `tauri-driver` (พร้อมปิดทั้ง pipeline)

---

## 4. โครงสร้างไฟล์

```
tests/e2e/
  wdio.conf.cjs                # WebdriverIO config (CommonJS — เลี่ยงปัญหา type=module)
  tsconfig.json                # TS config สำหรับ spec
  smoke.spec.ts                # spec หลัก 5 scenarios
  fixtures/
    smoke-workspace/
      tasks.json               # 1 project, 3 tasks สถานะคุมได้
      patches/.gitkeep
  .workspace/                  # (auto-generated) สำเนา fixture ที่ใช้รันจริง — gitignore ได้
```

### Scenarios ที่ครอบคลุมใน `smoke.spec.ts`

| # | Scenario | สิ่งที่ assert |
|---|----------|----------------|
| 1 | เปิด app + auto-load workspace fixture | `#project-view` displayed, `.project-item` มี, `#btn-sync` displayed |
| 2 | project list / task tree ตรงกับ tasks.json | sidebar contains "Smoke Project", task list contains 3 titles |
| 3 | คลิก task เห็น detail panel | `#detail-panel` displayed, `.ws-title-input` มี value ตรงกับ task |
| 4 | Sync apply patch | drop patch → click 🔄 Sync → file หาย + status badge เปลี่ยน + `tasks.json` บนดิสก์อัปเดต |
| 5 | Restart auto-apply patch | drop patch → `browser.reloadSession()` → patch หาย + status เปลี่ยน |

---

## 5. ข้อจำกัด WebDriver บน Windows / Tauri (สำคัญ)

### 5.1 Native dialogs ไม่ controllable
Tauri `dialog:open` (ใช้สำหรับปุ่ม "📂 Change Folder") เป็น OS-native file dialog —
**WebDriver ไม่สามารถ click หรือกรอก path ได้** วิธี workaround ของเราคือ **pre-seed**
`%APPDATA%\ai-task-flow\config.json` ก่อน launch ให้ tryRestoreDir() อ่าน path นี้ตอน boot
(ดู `before` hook ใน `smoke.spec.ts`) — ห้าม test flow ที่ต้องเปิด dialog ผ่าน UI

### 5.2 ทุก test ต้องใช้ release build
`tauri-driver` รัน exe ที่ build แล้วเท่านั้น (ไม่ใช่ `tauri dev`) — รอบแรก build ใช้เวลา
หลายนาที รอบถัดไปใช้ incremental cache ของ cargo

### 5.3 msedgedriver version mismatch
WebView2 runtime อัปเดตอัตโนมัติผ่าน Edge updater — ถ้า test เคย pass แล้ว fail ทันที
หลังเครื่อง update Edge ให้ลอง re-download `msedgedriver` ก่อน debug อย่างอื่น

### 5.4 ไม่มี keyboard chord สำหรับ DevTools
WebView2 ใน production build ปิด DevTools — debug ผ่าน screenshot/log เท่านั้น
(`browser.saveScreenshot('out.png')`) ระหว่าง test

### 5.5 Single-instance concurrency
`maxInstances: 1` — Tauri exe ของเราไม่ได้กำหนด single-instance lock แต่ `tauri-driver`
ผูกกับ session เดียวต่อ port การรัน parallel ต้องเปลี่ยน port + binary instance ซึ่งยังไม่
ได้ทดสอบ จึงปิด parallel ไว้

### 5.6 `%APPDATA%` mutation
suite จะ `backup → overwrite → restore` `%APPDATA%\ai-task-flow\config.json` —
ถ้า test ถูก kill กลางคันก่อน `after` hook จะ run, **config เดิมจะหายไป** สำเนาสำรอง
อยู่ที่ `config.e2e-backup.json` — restore manual ถ้าโดน kill

### 5.7 ไม่ Run บน CI ที่ไม่มี GUI
WebView2 ต้อง render จริง — รันบน headless agent ไม่ได้ใช้ self-hosted Windows runner
ที่มี desktop session หรือ skip suite ใน CI ปกติ

### 5.8 ค่อนข้างช้า (~30–60 วินาทีต่อ test)
WebDriver session boot ของ Tauri หนักกว่า Chromium มาก ใส่ test:e2e เป็น nightly /
manual gate ไม่ใช่ pre-commit

---

## 6. Troubleshooting

| อาการ | สาเหตุที่เจอบ่อย | วิธีแก้ |
|-------|-------------------|---------|
| `tauri-driver: command not found` | ไม่ได้ตั้ง CARGO_HOME / PATH | รัน 2 บรรทัดบนสุดของ section 2 ก่อน |
| Session timeout ตอน start | `msedgedriver` คนละเวอร์ชันกับ WebView2 | re-download msedgedriver |
| `os error 32` ตอน build | exe เก่ายัง running | `taskkill /F /IM ai-task-flow.exe` |
| Test 1 fail (project view ไม่ขึ้น) | `%APPDATA%\ai-task-flow\config.json` เสียหาย | ลบไฟล์ + รัน suite ใหม่ |
| Test 4/5 fail แบบ flaky | sync interval auto-fire (30s) ไป apply ก่อน | ตรวจว่า assertion `await listPatches()` ใช้ retry — `waitUntil` มีอยู่แล้ว |
| Spec ไม่ compile | `tsx` ไม่ได้ติดตั้ง | `npm install` หรือ pin `tsx` ในบาง subdir |

---

## 7. ขยายต่อ

- เพิ่ม spec ใหม่: ใส่ใน `tests/e2e/*.spec.ts` แล้วเพิ่ม path เข้า `wdio.conf.cjs::specs`
- เพิ่ม fixture: สร้าง folder ใหม่ใน `tests/e2e/fixtures/<name>/` มี `tasks.json` + `patches/.gitkeep`
- เปลี่ยน fixture ที่ใช้: แก้ตัวแปร `FIXTURE_SRC` ใน spec
- เก็บ screenshot อัตโนมัติเมื่อ fail: เพิ่ม hook `afterTest` ใน `wdio.conf.cjs`
  ```js
  afterTest: async function (test, context, { passed }) {
    if (!passed) await browser.saveScreenshot(`./tests/e2e/.workspace/${test.title}.png`);
  }
  ```
