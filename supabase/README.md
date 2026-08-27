# Supabase deployment

Không có seed hoặc mock data trong thư mục này. Nội dung trận, câu hỏi, đáp án, bài nói, điểm và lịch sử ôn tập chỉ được tạo từ người dùng thật khi ứng dụng chạy.

## Project Supabase mới

Chạy trong SQL Editor theo đúng thứ tự:

1. `schema.sql`
2. `migrations/20260827_game_engine_v2.sql`
3. `migrations/20260827_multiskill_arena.sql`
4. `migrations/20260827_production_hardening.sql`

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

Sau khi chạy SQL, reload schema cache của Supabase nếu dashboard chưa nhận các cột kỹ năng mới. Không cần import dữ liệu mẫu.
