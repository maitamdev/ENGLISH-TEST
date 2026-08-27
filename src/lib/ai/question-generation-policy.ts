export const QUESTION_GENERATION_POLICY = `
QUY TẮC ĐÁP ÁN BẮT BUỘC CHO MỌI CÂU HỎI:
1. canonicalAnswer là đáp án ngắn, tự nhiên và đúng nhất.
2. acceptedAnswers phải chứa canonicalAnswer và TẤT CẢ đáp án tương đương hợp lệ có khả năng người học nhập:
   - biến thể Anh-Anh/Anh-Mỹ phổ biến;
   - danh từ số ít/số nhiều nếu ngữ cảnh đều đúng;
   - từ đồng nghĩa thông dụng thực sự thay thế được trong đúng ngữ cảnh;
   - cách viết có/không có mạo từ a/an/the;
   - với tiếng Việt: cách diễn đạt phổ biến tương đương, nhưng không thêm từ có nghĩa rộng/hẹp khác đáp án.
3. Không thêm đáp án "gần nghĩa" nếu không thể thay thế chính xác trong câu hỏi. Ví dụ sofa/couch có thể tương đương trong câu đồ nội thất; house/home không luôn tương đương.
4. acceptedAnswers không phân biệt hoa thường nhưng phải là mảng chuỗi duy nhất, không trùng lặp, tối đa 12 phần tử.
5. prompt phải chỉ rõ hướng dịch hoặc loại câu trả lời cần nhập. Không tạo câu mơ hồ có nhiều đáp án đúng nhưng lại thiếu alias.
6. explanation phải giải thích ngắn bằng tiếng Việt vì sao đáp án đúng và, nếu có synonym, chúng khác sắc thái thế nào.
7. Không lặp canonicalAnswer giữa các vòng trong cùng một trận, kể cả biến thể số nhiều hoặc chính tả.
`;

export function appendQuestionGenerationPolicy(prompt: string) {
  return `${prompt.trim()}\n\n${QUESTION_GENERATION_POLICY.trim()}`;
}
