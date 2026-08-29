# LexiDuel

LexiDuel là phòng học tiếng Anh riêng cho đúng hai người. Hai người nói chuyện trực tiếp bằng WebRTC, cùng bật Gemini Live làm giáo viên giọng nói, yêu cầu Groq dựng trận theo chủ đề thật, thi trên cùng đồng hồ server, sau đó ôn lại bằng FSRS, Error Notebook và AI Study Plan.

Repository không có seed, mock user, mock room, mock question, điểm mẫu hay lịch sử học mẫu. Supabase mới sẽ trống cho đến khi người dùng thật tạo dữ liệu hoặc quản trị viên chạy importer nguồn mở có license.

## Tính năng đã có

- Phòng hai người, private Supabase Realtime, presence, WebRTC, TURN credential ngắn hạn, audio preflight và host migration bằng lease.
- Đồng hồ vòng authoritative trong PostgreSQL, thời điểm bắt đầu có lead time chung, deadline chung, idempotency cho START/NEXT ROUND và cả hai người phải xác nhận.
- Gemini Live giọng Kore nói tiếng Việt, nghe liên tục trong trận, gọi tool tạo trận/gợi ý thật và giữ phiên qua reconnect.
- Queue tạo trận theo batch 4 câu, checkpoint sau mỗi batch, retry/backoff, cron recovery và không còn nhánh tạo 30-50 câu trong một request.
- 24 mode: từ vựng, dịch, nghe, chính tả, minimal pairs, audio choice, story listening, shadowing, đọc hiểu, trắc nghiệm, xếp câu, cloze, sửa lỗi, collocation, phát âm, speaking, roleplay, debate và writing.
- Gemini TTS private cache. Bài nghe không dùng giọng `speechSynthesis` của trình duyệt.
- Score Engine V3 ưu tiên đúng trước tốc độ, có grace 20%, hệ số mode/độ khó, streak, phạt gợi ý và breakdown audit.
- Đối chiếu đồng nghĩa tự động bằng Gemini với confidence threshold; người dùng vẫn có phúc khảo thủ công.
- FSRS-6, Error Notebook, kế hoạch 7 ngày dựa trên dữ liệu thật, hoàn thành từng mục học và trang ôn toàn bộ trận của hai người.
- Multi-turn Speaking Lab ghi audio tạm thời, Gemini chấm và tiếp tục hội thoại bằng giọng nói; chỉ transcript/rubric được lưu.
- Rubric phát âm gồm intelligibility, âm đoạn, trọng âm từ, rhythm, intonation, lỗi từ/phoneme và bài luyện.
- Bạn bè theo username chính xác, lời mời phòng, skill Elo rating, lịch sử rating và Community UI.
- Privacy preferences, JSON export riêng tư, xóa tài khoản theo queue, telemetry có opt-out, health/maintenance workers.
- Tatoeba, CMUdict, Meta CoVoST và Facebook Page được phép; provenance và license đến từng record/câu hỏi.

## Cài Supabase

1. Tạo project Supabase.
2. Bật Anonymous Sign-Ins trong Authentication. Google OAuth là tùy chọn.
3. Chạy `supabase/schema.sql`, sau đó các migration đúng thứ tự trong `supabase/README.md`.
4. Chạy `supabase/tests/production_contracts.sql` để kiểm tra contract bảo mật và schema.
5. Lấy Project URL, publishable key và secret/service-role key.

Không chạy `schema.sql` lần hai trên cùng project. Các migration không chèn dữ liệu học.

## Biến môi trường

Copy `.env.example` thành `.env.local`, sau đó điền tối thiểu:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY=YOUR_SERVER_SECRET
GROQ_API_KEY=YOUR_GROQ_KEY
GROQ_MODEL=openai/gpt-oss-20b
GEMINI_API_KEY=YOUR_GEMINI_KEY
CRON_SECRET=LONG_RANDOM_SECRET
CONTENT_IMPORT_SECRET=ANOTHER_LONG_RANDOM_SECRET
```

Không thêm tiền tố `NEXT_PUBLIC_` cho Supabase secret, Groq, Gemini, TURN secret, Facebook token hoặc worker secret.

## TURN production

STUN đủ cho nhiều mạng local nhưng không đủ cho mạng doanh nghiệp, CGNAT hoặc firewall nghiêm ngặt. Cấu hình coturn hoặc nhà cung cấp TURN:

```dotenv
TURN_URL=turns:turn.example.com:5349
TURN_SHARED_SECRET=YOUR_COTURN_STATIC_AUTH_SECRET
```

Server tạo username hết hạn và HMAC credential riêng cho user. Nếu nhà cung cấp không hỗ trợ shared secret, dùng `TURN_USERNAME` và `TURN_CREDENTIAL` server-only. UI Settings trong phòng kiểm tra micro, output device và relay candidate trước trận.

## Nguồn dữ liệu thật

Importer chỉ chạy qua endpoint bảo vệ `POST /api/internal/content-import` với header `Authorization: Bearer CONTENT_IMPORT_SECRET`.

Ví dụ Tatoeba:

```json
{"sourceKey":"tatoeba-en-vi","limit":100,"cursor":{"after":"..."}}
```

Ví dụ CMUdict:

```json
{"sourceKey":"cmudict","limit":500,"cursor":{"line":0}}
```

CoVoST cần `COVOST_TSV_URL` trỏ tới TSV chính thức/được phép và có thể dùng cursor theo dòng. Facebook chỉ hỗ trợ Page do bạn kiểm soát qua Graph API:

```json
{
  "sourceKey":"authorized-facebook-page",
  "limit":50,
  "rightsHolder":"Tên chủ sở hữu Page",
  "authorizationEvidenceUrl":"https://example.com/public-permission-record"
}
```

Post Facebook được lưu ở trạng thái `pending`. Duyệt/reject bằng `POST /api/internal/content-moderation`. Không scrape profile, group, comment, Page bên thứ ba hoặc nội dung không có quyền tái sử dụng. Access token không bao giờ được lưu vào database.

Chi tiết license và quy tắc provenance nằm trong `docs/DATA_SOURCES.md`.

## Chạy và kiểm tra cuối

```bash
npm install
npm run lint
npm run typecheck
npm run build
```

E2E dùng hai browser context và dịch vụ thật, mặc định bị skip để không tự tạo dữ liệu ngoài ý muốn:

```bash
E2E_REAL_SUPABASE=1 npm run test:e2e
E2E_REAL_SUPABASE=1 E2E_REAL_AI=1 npm run test:e2e
```

Test thứ hai gọi Groq/Gemini thật, tạo một trận 5 câu và kiểm tra cả hai phía đều có START/NEXT ROUND.

## Deploy Vercel

1. Import repository vào Vercel và khai báo toàn bộ biến production.
2. Đảm bảo Vercel Cron gửi `CRON_SECRET`; `vercel.json` đã khai báo generation, privacy và maintenance worker.
3. Thêm `https://YOUR_DOMAIN/auth/callback` vào Supabase Auth redirect allow list.
4. Deploy, gọi `/api/internal/health` với `HEALTHCHECK_SECRET`, rồi test bằng hai browser/profile khác nhau.
5. Kiểm tra TURN relay trên ít nhất một mạng di động và một mạng Wi-Fi khác.

Xem `docs/ARCHITECTURE.md` để biết state machine, ranh giới bảo mật và data flow.
