// split_tasks.js
import { execSync } from 'child_process';
import fs from 'fs';

const DB_NAME = "alcohol-dictionary";
const TOTAL_WORKERS = 10; // 🟢 ĐÃ NÂNG CẤP: Sắp xếp phân chia cho 10 luồng Worker song song

async function run() {
    console.log("🔍 Đang truy vấn danh sách TOÀN BỘ từ khuyết ví dụ từ D1 (Không lọc chẵn lẻ)...");
    
    // SQL: Kéo tất cả các từ trống ví dụ (bao gồm cả ID chẵn lẫn lẻ) để xử lý toàn diện
    const cmd = `npx wrangler d1 execute ${DB_NAME} --remote --command="SELECT id FROM dictionary WHERE examples IS NULL OR examples = '[]' OR examples = '' ORDER BY id" --json`;
    
    let output;
    try {
        output = execSync(cmd, { maxBuffer: 1024 * 1024 * 100 }).toString();
    } catch (err) {
        console.error("❌ Lỗi truy vấn D1:", err.message);
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
        console.log("🎉 Tuyệt vời! Tất cả các từ vựng trong từ điển đã được bổ sung ví dụ.");
        return;
    }

    const ids = rows.map(r => r.id);
    console.log(`📊 Phát hiện tổng cộng ${ids.length} từ khuyết ví dụ. Đang phân bổ đều cho ${TOTAL_WORKERS} luồng...`);

    // Khởi tạo mảng nhiệm vụ cho 10 Workers
    const workerLists = Array.from({ length: TOTAL_WORKERS }, () => []);

    // Phân chia nhiệm vụ đều theo cơ chế Round-Robin
    ids.forEach((id, index) => {
        const workerId = index % TOTAL_WORKERS;
        workerLists[workerId].push(id);
    });

    // Ghi nhiệm vụ ra 10 tệp JSON cục bộ (từ todo_worker_0.json đến todo_worker_9.json)
    for (let i = 0; i < TOTAL_WORKERS; i++) {
        const filename = `./todo_worker_${i}.json`;
        fs.writeFileSync(filename, JSON.stringify(workerLists[i], null, 2));
        console.log(`📝 Đã chuẩn bị ${workerLists[i].length} từ cho Worker ${i} -> ${filename}`);
    }

    console.log("\n✅ Đã hoàn thành phân chia công việc cho 10 luồng. Sẵn sàng đẩy lên GitHub.");
}

run().catch(err => console.error(err));