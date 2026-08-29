# Supabase deployment

Không có seed hoặc mock data trong thư mục này. Nội dung trận, câu hỏi, đáp án, bài nói, điểm và lịch sử ôn tập chỉ được tạo từ người dùng thật khi ứng dụng chạy.

## Project Supabase mới

Chạy trong SQL Editor theo đúng thứ tự:

1. `schema.sql`
2. `migrations/20260827_game_engine_v2.sql`
3. `migrations/20260827_multiskill_arena.sql`
4. `migrations/20260827_production_hardening.sql`
5. `migrations/20260829_ai_coordination.sql`
6. `migrations/20260829_learning_labs.sql`
7. `migrations/20260830_platform_v3_foundation.sql`
8. `migrations/20260830_learning_intelligence.sql`

Mỗi file migration được viết theo hướng chạy nâng cấp an toàn bằng `if exists` hoặc `if not exists` ở các phần có thể lặp lại. Không đổi thứ tự vì migration multi-skill sử dụng hàm normalize và broadcast được tạo trong game engine v2.

## Project đã chạy schema trước đây

Chỉ chạy các migration chưa có trong project, vẫn theo thứ tự tên file. Nếu game engine v2 đã được chạy thì tiếp tục với `20260827_multiskill_arena.sql`.

## Biến môi trường Vercel

Đặt đầy đủ các biến trong `.env.example`. Các biến sau chỉ được đặt ở server, không thêm tiền tố `NEXT_PUBLIC_`:

- `SUPABASE_SECRET_KEY`
- `GROQ_API_KEY`
- `GROQ_MODEL`
- `GEMINI_API_KEY`
- `GEMINI_LIVE_MODEL`
- `GEMINI_GRADING_MODEL`
- `GEMINI_TTS_MODEL`

`GEMINI_LIVE_MODEL` phụ trách hội thoại thời gian thực. `GEMINI_GRADING_MODEL` nghe và chấm rubric của bài nói. `GEMINI_TTS_MODEL` đọc nội dung thi nghe chính xác. Tách ba model giúp đổi chất lượng hoặc chi phí từng tác vụ mà không ảnh hưởng phần còn lại.

Migration production hardening thêm tiến độ tạo trận realtime và chuyển transcript câu nghe cũ khỏi payload công khai sang `question_answers.grading_rules`. Vì vậy phải chạy migration này trước khi deploy code mới.

Migration AI coordination đảm bảo mỗi phòng chỉ có một máy điều phối Gemini Live, thêm heartbeat/lease và broadcast trạng thái phiên AI. Migration này cũng phải chạy trước khi deploy phiên bản mới nhất.

Migration learning labs thêm Listening Lab, Minimal Pairs, Story Listening, Shadowing, Sentence Builder, Cloze, Error Correction và Collocation. Migration này đồng thời bắt buộc các câu nói/viết chỉ được lưu qua endpoint chấm rubric được bảo vệ, không chứa dữ liệu mẫu.

Migration platform v3 thêm lease/host migration, đồng hồ vòng authoritative, idempotency, queue tạo trận, cache TTS riêng tư, telemetry, privacy request, bạn bè, lời mời, rating và private Storage buckets. Migration learning intelligence thêm Score Engine V3, semantic appeal, FSRS-6, Error Notebook, AI Study Plan, provenance nguồn mở, speaking nhiều lượt và rubric phát âm chi tiết.

Không chạy importer Facebook nếu chưa có quyền quản trị Page và bằng chứng cho phép tái sử dụng nội dung. Không scrape profile, group, comment hoặc Page của bên thứ ba. Tatoeba, CMUdict và CoVoST được lưu license/attribution đến từng record.

Có thể chạy `tests/production_contracts.sql` sau migration để kiểm tra các table/function và ranh giới quyền quan trọng. File test chỉ đọc catalog và không chèn dữ liệu.

Sau khi chạy SQL, reload schema cache của Supabase nếu dashboard chưa nhận các cột kỹ năng mới. Không cần import dữ liệu mẫu.
