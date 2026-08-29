# LexiDuel production architecture

## Nguồn sự thật

PostgreSQL/Supabase là nguồn sự thật duy nhất của profile, phòng, membership, lease host, trạng thái trận, deadline, câu hỏi, đáp án bí mật, submission, điểm, rating, review card, lỗi học, speaking session và privacy request. React chỉ giữ draft, trạng thái thiết bị và snapshot server mới nhất. Zustand chỉ giữ mute/deafen cục bộ.

Không có data fallback. Khi Supabase, Groq hoặc Gemini thiếu cấu hình, route trả lỗi rõ ràng và không tạo dữ liệu giả.

## Luồng phòng và realtime

```text
ROOM_IDLE -> AI_DISCUSSION -> GENERATING_GAME -> GAME_READY
          -> COUNTDOWN -> ROUND_ACTIVE -> ROUND_RESULT
          -> ROUND_ACTIVE ... -> MATCH_RESULT
```

- Mỗi browser có `clientSessionId` riêng và heartbeat 5 giây.
- Host giữ lease 20 giây. Khi host mất heartbeat, thành viên còn online được bầu host, `host_epoch` và `state_version` tăng.
- Presence chỉ báo online nhanh. Liveness/host authority nằm trong database.
- Realtime Postgres changes và private Broadcast chỉ làm tín hiệu refresh. Snapshot server vẫn quyết định UI.
- Voice signaling đi qua private Broadcast; audio người với người đi trực tiếp WebRTC. TURN credential được phát từ route authenticated.

## Đồng hồ và điểm

`schedule_match_round` khóa match, kiểm tra active host, đặt `round_started_at` và `round_deadline_at` trong cùng transaction, rồi tăng `round_epoch`. Client đo offset bằng nhiều mẫu `/api/clock`, chọn mẫu RTT thấp nhất và hiển thị countdown theo deadline server. Máy nhận Realtime chậm không được thêm hoặc mất thời gian.

`submit_answer` chạy trong PostgreSQL:

1. Khóa match và xác minh round đang active.
2. Chuẩn hóa Unicode/whitespace/punctuation và so exact hoặc typo nhỏ.
3. Kiểm tra deadline server với transport grace 750 ms.
4. Score Engine V3 tính base, accuracy factor, mode factor, difficulty, speed sau grace 20%, streak và hint deduction.
5. Ghi submission và cập nhật match player atomically.

Đáp án text bị chấm sai chuỗi có một lượt semantic review tự động bảo thủ. Chỉ confidence từ 0.86 và nghĩa tương đương chính xác mới đảo verdict/điểm. Mọi lần đảo điểm có `answer_appeals`, model, confidence, score delta và explanation. Người học vẫn có thể gửi appeal thủ công.

## AI và queue

- Gemini Live dùng ephemeral token, giọng Kore, tiếng Việt là ngôn ngữ điều phối mặc định và tool call bắt buộc cho tạo trận/gợi ý.
- `ai_sessions` bảo đảm một coordinator trong phòng; heartbeat giữ lease và WebSocket có session resumption/backoff.
- Route tạo trận chỉ ghi `generation_jobs`. Worker claim bằng `FOR UPDATE SKIP LOCKED`, lease token và checkpoint `generation_job_states`.
- Mỗi Groq call sinh tối đa 4 câu. Thành công checkpoint ngay; 429/invalid batch retry từ câu kế tiếp, không làm lại câu đã lưu.
- Khi đủ câu, worker ghi match, players, public questions và secret answers rồi mới chuyển room sang `GAME_READY`.
- TTS dùng content hash, private Storage, lease chống thundering herd và cache dùng chung giữa hai người.

## Learning intelligence

- Trigger submission tạo `review_cards` và `learning_errors` từ bài làm thật, trừ khi user tắt learning analytics.
- `ts-fsrs` tính lịch FSRS-6 ở server; `record_fsrs_review` idempotent bằng request UUID.
- Study Plan dùng CEFR, stats, unresolved errors, review logs và match history thật; evidence snapshot được lưu cùng plan.
- Completion của plan item là user action có RLS.
- Match completion cập nhật learning history một lần bằng ledger và Elo skill rating một lần bằng transaction/idempotent event.
- Match Review hiển thị cả hai submission, accepted answers, explanation, rubric và attribution nguồn mở trực tiếp.

## Speaking và pronunciation

Speaking Lab gửi blob audio tạm thời thẳng đến Gemini. Server không upload blob micro. Gemini trả transcript, assessment và câu đáp. RPC ghi learner turn + AI turn + session state trong một transaction idempotent. Câu AI được đọc bằng Gemini TTS và cache theo turn.

Rubric trận nói lưu intelligibility, segmental accuracy, word stress, rhythm, intonation, fluency, word-level feedback, phoneme issues và drills. Accent identity không bị phạt.

## Open data provenance

- Tatoeba API: câu Anh-Việt, owner, sentence URL và license từng record.
- CMU Pronouncing Dictionary: ARPABET/stress với upstream license.
- Meta CoVoST 2: TSV chính thức/được cấp quyền, CC0 và provenance Common Voice.
- Authorized Facebook Page: Graph API token server-only, rights holder và public authorization evidence bắt buộc; record chờ moderation.

`questions.learning_content_id` chỉ được gắn khi model trả đúng ID trong tập source context đã cấp. ID bịa bị loại bỏ. Câu AI nguyên bản không được giả là dữ liệu bên ngoài.

## Security và privacy

- Secret answer table không cấp SELECT cho browser roles.
- Mọi reveal kiểm tra membership và room phase.
- Storage buckets audio/export là private; file chỉ được trả qua endpoint authenticated hoặc signed URL 60 giây.
- Facebook/Groq/Gemini/Supabase/TURN secrets là server-only.
- Social update grants chỉ cho `status/responded_at`; requester, recipient và room IDs không thể sửa từ browser.
- User có thể tắt analytics/discovery, tạo JSON export và queue xóa tài khoản có xác nhận.
- Telemetry metadata bị giới hạn độ dài, không ghi answer/audio, và bỏ liên kết user/room/match khi analytics bị tắt.
- Maintenance worker hết hạn invite/export, release TTS lease, đánh dấu connection stale và prune telemetry/operation theo retention.

## Observability và kiểm thử

`telemetry_events` lưu correlation ID, stage, provider, duration và error code. `/api/internal/health` báo queue, stale presence, TTS failure, privacy backlog và lỗi một giờ gần nhất. Cả health và worker đều yêu cầu bearer secret.

Playwright E2E chạy hai browser context với Anonymous Auth thật. Suite kiểm tra join/presence/host migration; suite AI opt-in kiểm tra queue thật, START ở cả hai phía, cùng round và NEXT ROUND ở cả hai phía. SQL production contracts kiểm tra object bắt buộc, private buckets và quyền secret answers mà không chèn row.
# Production verification layer

## Realtime fairness

Mỗi browser gửi delivery receipt có idempotency key theo `question + user + client session + phase`. Server đóng dấu thời gian nhận; clock offset/RTT từ client chỉ là bằng chứng bổ sung, không thay thế thời gian server. PostgreSQL tạo `question_fairness_assessments` từ hai người chơi và phân loại `pending`, `fair`, `review` hoặc `compromised`. Điểm không dựa vào thời gian render local chưa được xác nhận.

## AI quality lifecycle

Generation batch đi qua deterministic Quality Gate trước khi được ghi vào trận: canonical answer, accepted answers, trùng câu, lộ đáp án, mode payload, provenance và cấu trúc lựa chọn đều được kiểm tra. `prompt_version`, `quality_policy_version`, fingerprint và check list được lưu để có thể tái hiện nguyên nhân. Admin eval gọi cùng pipeline/provider production; eval case do người vận hành tạo, không seed dữ liệu giả.

## Control plane

`platform_admins` tách quyền owner/admin/moderator khỏi role người học. Content Studio quản lý nguồn/license/moderation; Operations tổng hợp telemetry và durable alerts; Safety Console xử lý report. Các route control-plane luôn xác thực server-side và dùng service role chỉ sau khi role được kiểm tra.

## PWA reliability

Service worker chỉ cache immutable Next static assets và hình ảnh công khai; không cache navigation, API, transcript, đáp án hoặc dữ liệu phòng. Khi app resume/online, room client làm mới state và delivery receipt. Trong trận, Wake Lock được giữ khi nền tảng hỗ trợ. Push subscription thuộc từng user, secret chỉ đọc được bởi chính user/RLS và sender server; endpoint hết hạn tự bị vô hiệu.
## Adaptive learning control plane

`20260831_adaptive_learning_paths.sql` mở rộng hệ thống bằng một control plane không chứa seed data:

1. Hoạt động thật tạo `skill_evidence_events`; trigger/RPC idempotent cập nhật `learner_skill_mastery` theo alpha/beta và confidence tăng theo số bằng chứng.
2. Placement chỉ gửi public payload của item cho trình duyệt. Transcript nghe, đáp án và accepted answers nằm sau server boundary; mỗi response cập nhật theta, information, SEM và confidence trong một transaction PostgreSQL.
3. Shared goal được tạo ở trạng thái `proposed` mà chưa đọc evidence của partner. Chỉ sau khi partner accept qua guarded RPC, hệ thống mới chuyển `proposed → generating → active`, snapshot mastery/placement/FSRS của đúng hai người và sinh path. RLS lẫn RPC đều vô hiệu hóa path khi một trong hai tài khoản chặn người còn lại.
4. Sau khi round được reveal, intervention policy tạo tối đa hai hành động dạy có ưu tiên từ timeout/rubric/hint/kết quả. Gemini Live nhận instruction này trong phiên đang mở; trước reveal endpoint trả 409 và không sinh event.
5. Match recap là bản tổng hợp deterministic từ questions/submissions, không nhờ model bịa nhận xét. Notification worker enqueue theo due state thật, claim outbox idempotent và tôn trọng quiet hours.
6. Curriculum descriptor chỉ có hiệu lực khi framework enabled và descriptor được moderator approve. Mọi framework cần publisher, source URL, license URL và attribution; hash được tính ở server.

CEFR level trong sản phẩm là diagnostic estimate phục vụ cá nhân hóa, không phải chứng chỉ. Phần curriculum hỗ trợ vocabulary, grammar, reading, listening, writing, speaking, phonology, mediation và online interaction để phản ánh Companion Volume mới hơn thay vì chỉ bốn kỹ năng truyền thống.

## Arena orchestration

`20260901_arena_orchestration.sql` nối game engine với learning control plane mà không tạo content mẫu:

1. Match Studio preset do người dùng sở hữu được bảo vệ bằng RLS. Cấu hình lưu toàn bộ mode mix và policy nhưng không lưu câu hỏi hoặc đáp án.
2. Khi enqueue generation, server tổng hợp mastery và review-card đến hạn của đúng hai thành viên đã cho phép analytics. Worker dùng aggregate không định danh để sắp mode `balanced`, `weakness_first` hoặc `spaced_retrieval`, đồng thời tạo difficulty curve có audit trên `match_adaptive_contexts`.
3. Với trận có nghe/nói, START kiểm tra presence mới, clock RTT và audio preflight. Kết quả thiết bị được ghi vào `room_readiness_events`; client không có quyền tự insert audit row.
4. Trigger sau submission tạo `match_remediation_items` từ evidence thật. Chính sách `WRONG_ONLY` chỉ ghi câu sai/timeout; `AUTO` còn nhận hint dependency, low rubric và slow recall. Người dùng chỉ đổi trạng thái qua guarded RPC.
5. Heartbeat ghi connectivity incident khi mất mạng giữa vòng. Khi client trở lại, PostgreSQL bù downtime vào deadline chung cho cả hai, tối đa 15 giây mỗi incident và 30 giây mỗi vòng để không thể lợi dụng reconnect; toàn bộ incident và phần bù đều có audit.
