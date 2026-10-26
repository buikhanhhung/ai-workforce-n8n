# Kịch bản demo AI Workforce

Thời lượng: khoảng 20 phút (8 phút slide + 12 phút demo trực tiếp). Đi kèm slide `docs/project-presentation-ai-workforce.html`.

Nguyên tắc: **gửi yêu cầu chạy lâu trước, nói trong lúc chờ**. Một yêu cầu YouTube có 3 agent mất khoảng 5 phút; yêu cầu dữ liệu dán sẵn mất 1–2 phút.

---

## 0. Chuẩn bị (trước giờ demo 20 phút)

- [ ] Ổ C còn trống trên 10 GB, đóng ChatGPT desktop và tab trình duyệt thừa (máy chỉ có 7,7 GB RAM).
- [ ] Mở Docker Desktop, chạy `docker compose up -d` trong thư mục dự án.
- [ ] Kiểm tra: http://localhost:3000 mở được, dòng cuối trang ghi "Đã kết nối n8n".
- [ ] **Chạy thử Gemini một lần** (để biết còn quota): trên thẻ agent *Skill Recommendation*, ô "Giao lại", gõ `Ai nên soạn câu trả lời cho khách hỏi về hoá đơn?` → bấm Giao lại → chờ thẻ báo "xong". Lỗi 429/503 → xem mục 9.
- [ ] Lần đầu thao tác, dashboard hỏi tên người dùng: nhập tên người trình bày (tên này hiện trong lịch sử duyệt).
- [ ] Mở sẵn các tab theo thứ tự:
  1. Slide: `docs/project-presentation-ai-workforce.html` (nhấn `F` để toàn màn hình)
  2. Dashboard: http://localhost:3000/#ceo
  3. n8n (đã đăng nhập): http://localhost:5678/home/executions
- [ ] Mở Notepad chứa sẵn 3 câu lệnh ở mục 2, 3, 4 để copy cho nhanh.
- [ ] Dọn khu "Kết quả gần đây" bằng nút **Dọn hết** để màn hình sạch (kết quả cũ vẫn nằm trong Thư viện).

---

## 1. Mở đầu bằng slide (8 phút)

| Slide | Nói gì (ý chính) |
| --- | --- |
| 1 | "Một công ty vận hành bằng nhân sự AI: CEO AI nhận việc, chia việc, kiểm tra, con người duyệt." |
| 2 | Kể ví dụ YouTube → LinkedIn → video ngắn → ảnh. "Lát nữa mình chạy đúng ví dụ này." |
| 3 | Con số: 16 workflow, 8 agent, chạy local, không tốn phí cloud. |
| 4–5 | Kiến trúc và luồng: nhấn mạnh **database giữ trạng thái** và **người duyệt là bước cuối**. |
| 6–7 | Lướt nhanh: database và danh sách workflow. Chi tiết để phần hỏi đáp. |

Chuyển sang dashboard. Phần ảnh chụp n8n (slide 8–20) dùng sau demo hoặc khi có câu hỏi kỹ thuật.

---

## 2. Demo 1 — CEO giao việc cho nhiều agent (gửi ngay, chạy ~5 phút)

**Ở tab CEO** (http://localhost:3000/#ceo), dán vào ô giao việc rồi bấm **Gửi**:

```
Xem video https://www.youtube.com/watch?v=aircAruvnKk rồi viết một bài LinkedIn bằng tiếng Việt cho quản lý không chuyên kỹ thuật. Từ bài viết đó, chuyển thể thêm thành kịch bản video ngắn và một bản tóm tắt. Đồng thời làm một ảnh phong cách sketch minh hoạ ý chính để đăng kèm bài LinkedIn.
```

**Chỉ cho khán giả thấy:**
1. Banner "CEO đang lập kế hoạch…" có đồng hồ chạy. Ô nhập bị khoá để không gửi chồng. Bấm F5 → banner vẫn còn (trạng thái nằm trong database).
2. Khoảng 20–40 giây sau, banner đổi thành "Đã giao Marketing" với 3 chip: YouTube-to-LinkedIn, Repurpose Studio, Visual Design.
3. Dải kế hoạch: YouTube-to-LinkedIn chạy trước; hai agent còn lại **chờ** vì cần bài viết làm đầu vào.
4. Thẻ agent YouTube-to-LinkedIn sáng viền vàng, "Đang suy luận… m:ss", nhãn "việc CEO".

**Nói:** "CEO không tự làm. Nó chọn agent theo kỹ năng, tự xác định việc nào phải làm trước. Khi bài viết xong, hai agent sau chạy song song."

Không chờ ở đây, chuyển sang Demo 2.

---

## 3. Demo 2 — Phòng ban chỉ giao được việc trong phạm vi (1–2 phút)

Bấm **Vận hành** ở sidebar. Dán và **Gửi**:

```
Kiểm tra giúp tôi tình trạng hệ thống WeCommitDW từ log đêm qua, chỉ ra lỗi, rủi ro và cách khắc phục:
02:00 ETL job dw_sales_load started
02:47 ETL job dw_sales_load finished rows=1,204,331 (avg 7 ngày: 1,190,000)
03:00 ETL job dw_customer_sync started
03:00 ERROR dw_customer_sync: connection timeout to crm-replica (attempt 1/3)
03:05 ERROR dw_customer_sync: connection timeout to crm-replica (attempt 2/3)
03:10 dw_customer_sync finished rows=0
Disk usage /data: 91% (threshold 85%)
Backup job: last successful run 2026-10-10
```

**Chỉ ra:**
- Header đổi thành "Phòng Vận hành", chỉ còn 2 agent của phòng.
- Trưởng phòng lập kế hoạch riêng, không chặn việc của CEO đang chạy (khoá theo phạm vi).
- Việc được giao cho **WeCommitDW System Checker**.

**(Tuỳ chọn, thêm 30 giây)** Vẫn ở tab Vận hành, gửi `Viết một bài LinkedIn giới thiệu hệ thống WeCommitDW` → không agent nào của phòng viết bài được, nên kế hoạch bị từ chối kèm lý do và gợi ý giao cho phòng Marketing (nếu yêu cầu có phần làm được, phần còn lại hiện thành cảnh báo vàng **"Ngoài phạm vi, chưa giao"**). Nói: "Phòng ban không thể giao việc cho agent phòng khác, chặn tận ở database."

---

## 4. Demo 3 — Hỏi CEO "ai nên làm việc này" (1 phút)

Quay về **Tổng quan · CEO**, gửi:

```
Tôi chưa biết nên giao việc này cho ai: cần soát các bình luận khách hàng phàn nàn video bài 5 không phát được trên Safari và soạn câu trả lời. Hãy đề xuất nhân sự và kỹ năng phù hợp, kèm các bước thực hiện.
```

CEO giao cho **Skill Recommendation**. Nói: "Agent này chỉ đề xuất trong danh mục nhân sự thật; agent hay kỹ năng không tồn tại bị lọc bỏ."

---

## 5. Xem kết quả và duyệt (3 phút)

Lúc này Demo 2, 3 thường đã xong, Demo 1 gần xong.

1. Khu **Kết quả gần đây**: bấm **Xem** kết quả WeCommitDW.
   - Chỉ: sức khoẻ hệ thống, mỗi phát hiện có **trích dẫn log gốc** và dấu "✓ bằng chứng khớp dữ liệu". Nói: "Agent không được bịa; trích dẫn được đối chiếu lại với dữ liệu."
2. Khi Demo 1 xong (dải kế hoạch báo "chờ duyệt"), mục **Chờ bạn duyệt** hiện kế hoạch. Bấm **Xem**:
   - Các bước và agent đã làm, **Báo cáo của CEO**.
   - **Xem trước bài LinkedIn**: đúng chữ và ảnh sẽ đăng. Bấm vào ảnh sketch để xem.
3. Bấm **✓ Duyệt**. Nói: "CEO không bao giờ tự đánh dấu xong. Chỉ người duyệt mới chuyển kế hoạch sang hoàn thành."
4. Nút **Đăng lên LinkedIn** xuất hiện. **Không bấm** (LinkedIn chưa kết nối). Nói: "Sau khi kết nối tài khoản, bấm nút này sẽ đăng đúng bản vừa xem trước, mỗi kế hoạch chỉ đăng một lần."

---

## 6. Thư viện nội dung (1 phút)

Bấm tab **📚 Thư viện nội dung**.

- Lọc theo agent, theo trạng thái duyệt, gõ tìm "Safari".
- Mở một kết quả Repurpose: từng định dạng có nút **Sao chép** riêng; nút **Tải .md**.
- Bấm **✓ Đã dùng** trên một thẻ, F5 → trạng thái còn nguyên (lưu chung trong database).
- Chuyển sang tab **Marketing** ở sidebar: thư viện chỉ còn nội dung của phòng Marketing.

---

## 7. Kết nối & tài khoản (30 giây)

Sidebar → **Kết nối & tài khoản**.

- Chỉ thẻ LinkedIn, Circle, WeCommitDW với hướng dẫn từng bước.
- Bấm **Kiểm tra kết nối** ở thẻ Circle → báo lỗi 401 từ máy chủ Circle thật. Nói: "Đây là lệnh gọi thật. Khi có token, agent Circle sẽ tự đọc cộng đồng thay vì chờ dán dữ liệu."
- Nhấn mạnh: mật khẩu và token nhập ở đây đi thẳng vào kho credential mã hoá của n8n, không bao giờ hiện lại.

---

## 8. Hậu trường trong n8n (2 phút)

Chuyển sang tab n8n → **Executions**.

1. Các lần chạy của Demo 1 nằm trên cùng: A · CEO Planning, B · Task Dispatcher, B · Task Runner, C · YouTube-to-LinkedIn Agent, D · CEO Review.
2. Mở execution **C · YouTube-to-LinkedIn Agent**: bấm node **Transcribe YouTube Video** để thấy transcript Gemini trả về, rồi node **Post-process Output** để thấy bài viết cuối.
3. Mở workflow **A · CEO Planning**: chỉ node **CEO Planner Agent** với 2 model Gemini (chính + dự phòng) và **Output Parser**.
4. Nói: "Toàn bộ 16 workflow này sinh ra từ code và deploy bằng một lệnh, không ai kéo thả tay."

Quay về slide 21 trở đi để kết: kiểm thử, hạn chế, bước tiếp theo, rồi slide cuối "Cảm ơn".

---

## 9. Sự cố có thể gặp và cách xử lý

| Tình huống | Dấu hiệu | Xử lý tại chỗ |
| --- | --- | --- |
| Gemini hết quota / quá tải | Thẻ agent báo lỗi 429 hoặc 503 | Bấm **↻ Thử lại** một lần (hệ thống cũng tự thử lại với backoff). Vẫn lỗi → chuyển sang Thư viện, mở kết quả của lần chạy trước. Nói: "Gói Gemini miễn phí có giới hạn; bản thật sẽ bật billing." |
| YouTube trả rỗng | "YouTube transcription failed: empty response" | Hệ thống tự retry, thường lần 2 thành công. Nói đây là ví dụ về retry. |
| Chạy quá lâu | Demo 1 quá 8 phút chưa xong | Tiếp tục mục 6–8 trong lúc chờ; hoặc mở một kế hoạch YouTube cũ trong Lịch sử (nút 🕘). |
| Dashboard báo "Không kết nối được database" | Thông báo 503 màu đỏ | `docker compose up -d`, chờ 20 giây, F5. |
| Docker không lên | Lỗi 500 / "no connected VM" | Kiểm tra ổ C còn trống; `wsl --shutdown` rồi mở lại Docker Desktop. Nếu không kịp: trình bày bằng slide 8–20 (ảnh chụp n8n thật). |
| Lỡ bấm Dừng kế hoạch | Kế hoạch "đã huỷ" | Gửi lại câu lệnh; kết quả cũ vẫn ở Thư viện. |

---

## 10. Câu hỏi thường gặp, trả lời ngắn

- **Agent có bịa không?** Có ràng buộc ở hai lớp: prompt cấm, và code hậu kiểm loại bỏ trích dẫn/mốc giờ/agent không có trong dữ liệu nguồn. Câu không có nguồn thì Knowledge & Support chuyển người xử lý.
- **Hai việc chạy cùng lúc có bị trùng?** Không. PostgreSQL khoá dòng và chỉ cho một lần chạy mỗi task; đã test 8 phiên tranh 6 task, 0 trùng.
- **Sập giữa chừng thì sao?** Trạng thái nằm trong database; dispatcher chạy mỗi phút nhặt lại việc bị kẹt, execution quá 15 phút bị đánh timeout và thử lại.
- **Chi phí?** Chạy local, Gemini gói miễn phí. Bản thật cần bật billing Gemini để dùng model mạnh hơn.
- **Thêm agent mới?** Thêm một module trong `workflows/src/employees/`, chạy lệnh deploy; CEO tự thấy agent mới trong danh mục.
- **Bảo mật tài khoản?** Bí mật chỉ nằm trong credential mã hoá của n8n, mọi cổng chỉ mở trên 127.0.0.1. Chưa có đăng nhập/phân quyền cho dashboard (đang ở danh sách việc tiếp theo).
