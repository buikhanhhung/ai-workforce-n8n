# AI Workforce (n8n)

Một "công ty ảo" chạy trên máy cá nhân: **CEO AI** nhận yêu cầu bằng tiếng Việt, lập kế hoạch, giao việc cho **8 agent AI** thuộc 3 phòng ban (Marketing, Vận hành, CSKH & Cộng đồng), tự review kết quả rồi chờ **con người duyệt**. Điều khiển qua một dashboard web.

Xây trên n8n, PostgreSQL, Gemini, chạy bằng Docker Compose.

| Tài liệu | Nội dung |
| --- | --- |
| `docs/workforce-system.md` | Tài liệu kỹ thuật đầy đủ (tiếng Anh): kiến trúc, database, API, test |
| `docs/project-report-ai-workforce.md` | Báo cáo dự án |
| `docs/project-presentation-ai-workforce.html` | Slide trình bày + kịch bản demo (mở bằng trình duyệt) |

---

## 1. Yêu cầu

- **Windows 10/11** có WSL2 (macOS / Linux cũng chạy được, các lệnh PowerShell cần đổi tương ứng).
- **Docker Desktop**: https://www.docker.com/products/docker-desktop
- **Node.js 22** trở lên: https://nodejs.org
- **Gemini API key**: tạo miễn phí tại https://aistudio.google.com/apikey
- Máy: RAM từ 8 GB, **ổ đĩa trống trên 10 GB** (Docker treo khi ổ gần đầy).

## 2. Cài đặt lần đầu

Mở PowerShell trong thư mục dự án:

```powershell
# 1. Tạo file .env với mật khẩu ngẫu nhiên (xem .env.example)
node scripts/init-env.js

# 2. Khởi động 4 container (n8n, PostgreSQL, dashboard, renderer vẽ ảnh)
docker compose up -d
```

3. Mở http://localhost:5678 và **tạo tài khoản owner của n8n** (email + mật khẩu, chỉ lưu trên máy này).

```powershell
# 4. Lấy project id của n8n (chuỗi kiểu 7bpzxPCeX8M2Drwo)
$pid_n8n = powershell -ExecutionPolicy Bypass -File scripts/n8n-project-id.ps1

# 5. Nạp credential: Postgres, Gemini, khoá API nội bộ. Key Gemini chỉ đi qua biến môi trường, không lưu ra file.
$env:GEMINI_API_KEY = '<dán Gemini API key>'
node scripts/import-credentials.js $pid_n8n
Remove-Item Env:GEMINI_API_KEY

# 6. Deploy: tạo bảng database, sinh và import 16 workflow, publish, restart n8n (khoảng 2 phút)
powershell -ExecutionPolicy Bypass -File scripts/deploy-workforce.ps1 -ProjectId $pid_n8n
```

7. Mở **http://localhost:3000**: dòng cuối trang ghi "Đã kết nối n8n" là xong.

Tuỳ chọn, tạo dữ liệu mẫu (6 yêu cầu thật, mỗi agent một kết quả, khoảng 5 phút, tốn quota Gemini):

```powershell
node tests/run-ceo-demo-scenarios.js
```

## 3. Dùng hằng ngày

| Việc | Lệnh / địa chỉ |
| --- | --- |
| Bật | Mở Docker Desktop, rồi `docker compose up -d` |
| Tắt | `docker compose stop` |
| Dashboard | http://localhost:3000 |
| n8n (xem workflow, lịch sử chạy) | http://localhost:5678 |
| Sửa workflow / agent | Sửa trong `workflows/src/`, rồi chạy lại bước 6 (**không sửa trực tiếp trong n8n**: deploy sau sẽ ghi đè) |
| Nhập tài khoản LinkedIn, Circle, WeCommitDW | Dashboard → **Kết nối & tài khoản** |

Mọi cổng chỉ mở trên `127.0.0.1`: chỉ máy này truy cập được.

| Container | Cổng | Vai trò |
| --- | --- | --- |
| `n8n` | 5678 | Chạy workflow và AI agent |
| `wf-postgres` | 5433 | Database: kế hoạch, task, kết quả, thư viện |
| `wf-dashboard` | 3000 | Giao diện web, chuyển tiếp API sang n8n |
| `wf-renderer` | nội bộ | Vẽ ảnh PNG cho agent Visual Design |

## 4. Kiểm tra

```powershell
node tests/code-nodes/run-code-node-tests.js          # logic trong các node Code (không cần Docker)
docker cp db/tests/test-task-state.sql wf-postgres:/tmp/t.sql; docker exec wf-postgres psql -U workforce -d workforce -v ON_ERROR_STOP=1 -f /tmp/t.sql
```

Các bộ test khác: xem mục Testing trong `docs/workforce-system.md`.

## 5. Sao lưu và chuyển sang máy khác

Thư mục này chứa **source code**, nhưng dữ liệu đang chạy nằm trong 2 **Docker volume**, không nằm trong thư mục:

| Volume | Chứa |
| --- | --- |
| `n8n_n8n_data` | Tài khoản n8n, credential (có Gemini key), **khoá mã hoá của n8n**, workflow, lịch sử chạy |
| `n8n_wf_pg_data` | Kế hoạch, kết quả agent, thư viện nội dung, lượt duyệt |

**Cách 1: cài mới (không mang dữ liệu cũ).** Chép thư mục (kể cả file `.env`) sang máy mới và làm lại mục 2 (bỏ bước 1 vì `.env` đã có).

**Cách 2: mang nguyên dữ liệu.** Trên máy cũ:

```powershell
docker compose stop
docker run --rm -v n8n_n8n_data:/v -v "${PWD}/data/backups:/b" alpine tar czf /b/n8n_data.tgz -C /v .
docker run --rm -v n8n_wf_pg_data:/v -v "${PWD}/data/backups:/b" alpine tar czf /b/wf_pg_data.tgz -C /v .
```

Chép cả thư mục sang máy mới (giữ tên thư mục `N8N`: tên volume lấy theo tên thư mục), rồi:

```powershell
docker volume create n8n_n8n_data; docker volume create n8n_wf_pg_data
docker run --rm -v n8n_n8n_data:/v -v "${PWD}/data/backups:/b" alpine tar xzf /b/n8n_data.tgz -C /v
docker run --rm -v n8n_wf_pg_data:/v -v "${PWD}/data/backups:/b" alpine tar xzf /b/wf_pg_data.tgz -C /v
docker compose up -d
```

Giữ nguyên file `.env` cũ: mật khẩu trong đó phải khớp với database đã sao lưu.

> ⚠️ `.env`, `data/` và các file `.tgz` chứa mật khẩu / credential. Chép qua USB hoặc ổ riêng, **không đưa lên Git hay chia sẻ công khai**.

## 6. Xử lý sự cố

| Triệu chứng | Cách xử lý |
| --- | --- |
| Docker Desktop báo lỗi 500 / "no connected VM" | Dọn ổ C (trên 10 GB trống), đóng bớt ứng dụng nặng, `wsl --shutdown`, mở lại Docker Desktop |
| Dashboard: "Không kết nối được database" | `docker compose up -d`, chờ 20 giây, F5 |
| Agent báo lỗi 429 / 503 | Gemini gói miễn phí hết lượt hoặc quá tải: bấm **↻ Thử lại**, hoặc chờ một lúc / bật billing cho Gemini key |
| `docker compose` báo "set WF_POSTGRES_PASSWORD in .env" | Chưa có `.env`: chạy `node scripts/init-env.js` |
| `n8n-project-id.ps1` báo "No n8n owner yet" | Chưa tạo tài khoản owner: mở http://localhost:5678 |
| Tiếng Việt thành dấu `?` khi tự chạy SQL | Không pipe file SQL qua PowerShell; dùng `docker cp` rồi `psql -f` như script deploy |
