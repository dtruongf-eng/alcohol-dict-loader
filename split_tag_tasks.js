// split_tag_tasks.js
import { execSync } from 'child_process';
import fs from 'fs';

const DB_NAME = "alcohol-dictionary";
const TOTAL_WORKERS = 10; // Chia đều nhiệm vụ cho 10 luồng Worker song song

async function run() {
    console.log("🔍 [Vá Nóng] Đang quét và lọc từ vựng JLPT (N5-N1) đạt chuẩn chất lượng từ D1...");
    
    // =========================================================================
    // 🚧 HỆ THỐNG MÀNG LỌC CHẤT LƯỢNG (QUALITY GATES) TRÊN SQL:
    // - Chỉ lấy từ có level JLPT và chưa được gán tags.
    // - Bắt buộc cột từ vựng (word), cách đọc (reading) và nghĩa (meaning) không được trống.
    // - Loại bỏ các thuật ngữ chuyên ngành chứa dấu ngoặc giải thích (), （）.
    // - Loại bỏ các công thức toán học chứa dấu bằng = hoặc dấu cộng +.
    // - Giới hạn độ dài từ vựng dưới 10 ký tự (loại bỏ các định nghĩa dài lê thê).
    // =========================================================================
    const sqlQuery = `
        SELECT id FROM dictionary 
        WHERE level IN ('N5', 'N4', 'N3', 'N2', 'N1') 
          AND (tags IS NULL OR tags = '')
          AND word IS NOT NULL AND trim(word) != ''
          AND reading IS NOT NULL AND trim(reading) != ''
          AND meaning IS NOT NULL AND trim(meaning) != ''
          AND word NOT LIKE '%(%' 
          AND word NOT LIKE '%)%'
          AND word NOT LIKE '%（%'
          AND word NOT LIKE '%）%'
          AND word NOT LIKE '%=%'
          AND word NOT LIKE '%+%'
          AND length(word) <= 10
        ORDER BY id
    `.trim().replace(/\s+/g, ' '); // Nén câu lệnh SQL cho gọn gàng

    const cmd = `npx wrangler d1 execute ${DB_NAME} --remote --command="${sqlQuery}" --json`;
    
    let output;
    try {
        output = execSync(cmd, { maxBuffer: 1024 * 1024 * 100 }).toString();
    } catch (err) {
        console.error("❌ Lỗi kết nối hoặc truy vấn D1 thất bại:", err.message);
        return;
    }

    let cleanJson = output.trim();
    const startIdx = cleanJson.indexOf('[');
    const endIdx = cleanJson.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1) {
        console.log("❌ Không tìm thấy dữ liệu hợp lệ trả về từ D1.");
        return;
    }
    cleanJson = cleanJson.substring(startIdx, endIdx + 1);
    const parsed = JSON.parse(cleanJson);
    const rows = parsed[0]?.results || [];

    if (rows.length === 0) {
        console.log("🎉 Tuyệt vời! Không còn từ vựng đạt chuẩn JLPT nào chưa được gán tags.");
        return;
    }

    const ids = rows.map(r => r.id);
    console.log(`📊 Phát hiện tổng cộng ${ids.length} từ JLPT đạt chuẩn chất lượng chưa gán tags. Đang phân bổ cho ${TOTAL_WORKERS} luồng...`);

    // Khởi tạo mảng nhiệm vụ cho 10 Workers
    const workerLists = Array.from({ length: TOTAL_WORKERS }, () => []);

    // Phân chia nhiệm vụ đều theo cơ chế Round-Robin
    ids.forEach((id, index) => {
        const workerId = index % TOTAL_WORKERS;
        workerLists[workerId].push(id);
    });

    // Ghi nhiệm vụ ra 10 tệp JSON cục bộ (từ todo_tag_worker_0.json đến todo_tag_worker_9.json)
    for (let i = 0; i < TOTAL_WORKERS; i++) {
        const filename = `./todo_tag_worker_${i}.json`;
        fs.writeFileSync(filename, JSON.stringify(workerLists[i], null, 2));
        console.log(`📝 Đã chuẩn bị ${workerLists[i].length} từ chất lượng cho Worker ${i} -> ${filename}`);
    }

    console.log("\n✅ Hoàn thành phân chia công việc gán nhãn đạt chuẩn cho 10 luồng song song.");
}

run().catch(err => console.error(err));
