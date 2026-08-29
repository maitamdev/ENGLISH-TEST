# Licensed learning data policy

LexiDuel không tải một bộ “mock vocabulary” vào database. Nội dung ngoài do AI tạo phải được ghi là AI-original. Nội dung từ bên ngoài chỉ được dùng khi importer giữ được nguồn, record ID, license và attribution.

## Tatoeba English-Vietnamese

- Trang dự án: https://tatoeba.org
- API: https://api.tatoeba.org/v1/sentences
- Download/license: https://tatoeba.org/en/downloads
- LexiDuel chỉ lấy câu đã approved và bản dịch trực tiếp `eng -> vie`.
- Mỗi row giữ cả hai sentence ID, owner, URL và license của từng câu. License có thể khác nhau giữa hai record.

## CMU Pronouncing Dictionary

- Repository: https://github.com/cmusphinx/cmudict
- License: https://github.com/cmusphinx/cmudict/blob/master/LICENSE
- LexiDuel giữ entry name, ARPABET, stress pattern, upstream URL và copyright attribution.
- Importer dùng entry name làm record ID ổn định, không dựa vào số dòng.

## Meta CoVoST 2 và Mozilla Common Voice

- CoVoST: https://ai.meta.com/tools/covost/
- Upstream repository: https://github.com/facebookresearch/covost
- Common Voice datasets: https://commonvoice.mozilla.org/en/datasets
- CoVoST được phát hành CC0 và dựa trên Common Voice. Do archive có điều kiện phân phối riêng, LexiDuel không dùng mirror ngẫu nhiên. Operator phải cung cấp `COVOST_TSV_URL` tới archive chính thức hoặc bản mà họ được phép xử lý.
- Importer stream TSV theo cursor, giữ transcript, translation, audio path tham chiếu và provenance URL; nó không tự sao chép audio vào Storage.

## Authorized Facebook Page

- Graph API docs: https://developers.facebook.com/docs/graph-api/
- Chỉ Page do operator kiểm soát, dùng Page access token server-only.
- `rightsHolder` và `authorizationEvidenceUrl` là bắt buộc.
- Chỉ đọc `id,message,permalink_url,created_time,updated_time` từ `/PAGE_ID/posts`.
- Không scrape profile, personal feed, group, comment, member list hoặc Page bên thứ ba.
- Token không được ghi vào logs, attribution hay database.
- Mọi post mới ở trạng thái `pending`; operator phải review và approve qua endpoint moderation trước khi generation worker thấy nội dung.

## Quy tắc dùng trong câu hỏi

Generation worker chỉ load `learning_content.moderation_status = 'approved'`. Model có thể khai báo `privateData.sourceContentId` nhưng server chỉ giữ ID nếu nó nằm trong context đã cấp. ID ngoài context bị xóa. `questions.learning_content_id` cho phép Match Review hiển thị nguồn/license đã dùng trực tiếp.

Nếu không có record phù hợp với chủ đề, model được phép tạo một item giáo dục nguyên bản nhưng không được gắn hoặc tuyên bố nguồn bên ngoài.
