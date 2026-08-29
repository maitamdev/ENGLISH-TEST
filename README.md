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
- Delivery receipts theo từng pha (`received`, `rendered`, `input_enabled`, `audio_ready`, `answer_sent`) và fairness verdict được tính ở PostgreSQL, giúp phát hiện lệch realtime thay vì đoán từ UI.
- AI Quality Gate có policy/prompt version, audit từng batch và bộ eval do quản trị viên tự tạo; không có test case giả được seed vào database.
- Content Admin Studio, Operations Console và Trust & Safety queue dùng trực tiếp dữ liệu Supabase để import, moderation, điều tra report và xử lý alert.
- PWA có lifecycle reconnect, wake lock trong trận, Web Push lời mời phòng và tự vô hiệu subscription đã hết hạn.
- Adaptive CEFR placement sinh từng câu theo theta hiện tại, báo confidence/standard error và luôn ghi rõ đây không phải chứng chỉ CEFR chính thức.
- Mastery graph chỉ cập nhật từ submission, FSRS review, speaking turn và placement response thật; tôn trọng `allow_learning_analytics`.
- Shared Paths chỉ đọc snapshot evidence thật của cả hai sau khi người được mời đồng ý; trạng thái `proposed → generating → active`, theo dõi hoàn thành riêng và tự khóa khi một trong hai tài khoản chặn nhau.
- AI teaching policy phía ứng dụng phát hiện timeout, cả hai cùng sai, rubric thấp, lệ thuộc hint hoặc thời điểm retrieval; chỉ chạy sau khi đáp án vòng đã được mở.
- Match recap và Progress gom lại điểm mạnh, vùng cần ôn, lịch sử evidence và đường dẫn ôn lại chính trận đó.
- Notification outbox bền vững nhắc FSRS/learning path, tôn trọng preference, quiet hours và múi giờ; không áp quota lên người học.
- Curriculum Admin quản lý framework/descriptor thật với source URL, license, attribution, hash chống trùng và moderation audit; migration không seed curriculum.
- Match Studio có Mode Mixer và cho lưu không giới hạn cấu hình cá nhân; mixed/co-op có thể sắp câu theo mastery hoặc FSRS đến hạn, điều chỉnh đường độ khó và lưu adaptive audit theo từng trận.
- Trận nghe/nói có readiness gate theo micro, audio output, TURN và độ trễ; sau mỗi submission, remediation queue tự tạo từ lỗi, timeout, hint, recall chậm hoặc rubric thấp.
- Arena Insights so sánh hai người từ match thật: thắng/hòa/thua, accuracy và tốc độ theo skill, lịch sử gần đây, fairness, reconnect compensation và remediation riêng của người xem.
- Security Center hiển thị trạng thái xác minh, phiên đăng nhập, quyền riêng tư và audit trail 180 ngày chỉ của chính người dùng. Mutation tạo trận có idempotency receipt, worker có constant-time bearer authentication và maintenance lease chống chạy chồng.

## Cài Supabase

1. Tạo project Supabase.
2. Bật Anonymous Sign-Ins trong Authentication. Google OAuth là tùy chọn.
3. Chạy `supabase/schema.sql`, sau đó các migration đúng thứ tự trong `supabase/README.md`.
4. Chạy `supabase/tests/production_contracts.sql`, `supabase/tests/production_verification_contracts.sql`, `supabase/tests/adaptive_learning_contracts.sql`, `supabase/tests/arena_orchestration_contracts.sql`, `supabase/tests/arena_insights_contracts.sql`, rồi `supabase/tests/security_control_plane_contracts.sql` để kiểm tra contract bảo mật, fairness, admin, safety, quality gate và adaptive arena.
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
PLATFORM_ADMIN_USER_IDS=YOUR_AUTH_USER_UUID
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

## Platform Admin và kiểm soát chất lượng

Để bootstrap chủ sở hữu đầu tiên, đặt UUID Supabase Auth của bạn vào `PLATFORM_ADMIN_USER_IDS` (nhiều UUID phân cách bằng dấu phẩy). Sau khi migration `20260830_production_verification.sql` được chạy, owner có thể mở:

- `/admin/content`: chạy importer hợp pháp, bật/tắt nguồn và duyệt provenance.
- `/admin/curriculum`: đăng ký framework có license, import descriptor thật và moderation trước khi placement được phép dùng descriptor đó.
- `/admin/ai-evals`: tạo evaluation case bằng yêu cầu thật, chạy Groq thật và xem quality checks/version.
- `/admin/operations`: theo dõi queue, telemetry, reconnect, audio, fairness và alert bền vững.
- `/admin/safety`: nhận xử lý report, ghi kết quả điều tra và lưu quyết định có audit trail.

Không có admin mặc định và migration không tự cấp quyền cho tài khoản nào. Có thể thêm admin lâu dài trực tiếp vào `platform_admins`, sau đó bỏ bootstrap env nếu muốn.

## Web Push

Web Push là tùy chọn. Tạo một VAPID key pair rồi đặt cùng một public key ở client và server:

```dotenv
NEXT_PUBLIC_VAPID_PUBLIC_KEY=YOUR_PUBLIC_VAPID_KEY
VAPID_PRIVATE_KEY=YOUR_PRIVATE_VAPID_KEY
VAPID_SUBJECT=mailto:admin@your-domain.com
```

Trình duyệt chỉ đăng ký sau khi người dùng chủ động bấm cho phép. Khi có lời mời phòng, shared goal hoặc lịch FSRS đến hạn, maintenance worker đưa sự kiện vào outbox rồi gửi notification thật theo preference/quiet hours; endpoint 404/410 sẽ tự vô hiệu subscription cũ.

## Chạy và kiểm tra cuối

```bash
npm install
npm run lint
npm run typecheck
npm run test
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
6. Mở `/admin/operations`, tạo alert rule phù hợp hạ tầng và chạy Evaluate; hệ thống không áp quota hay chặn người dùng theo các rule này.

Xem `docs/ARCHITECTURE.md` để biết state machine, ranh giới bảo mật và data flow.
