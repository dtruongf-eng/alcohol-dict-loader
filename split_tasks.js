// split_tasks.js
import { execSync } from 'child_process';
import fs from 'fs';

const DB_NAME = "alcohol-dictionary";
const TOTAL_WORKERS = 2;

async function run() {
    console.log("🔍 Đang truy vấn danh sách ID chẵn cần bổ sung ví dụ từ D1...");
    
    // SQL: Chỉ lấy các dòng trống ví dụ và có ID chẵn (Sử dụng phép toán số nguyên chẵn an toàn tuyệt đối cho shell)
    const cmd = `npx wrangler d1 execute ${DB_NAME} --remote --command="SELECT id FROM dictionary WHERE (examples IS NULL OR examples = '[]' OR examples = '') AND (id / 2) * 2 = id ORDER BY id" --json`;
    
    let output;
    try {
        // 🟢 ĐÃ SỬA: Nới rộng maxBuffer lên 100MB để chống lỗi ENOBUFS hoàn toàn
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
        console.log("🎉 Tuyệt vời! Tất cả các từ vựng có ID chẵn đã được bổ sung ví dụ.");
        return;
    }

    const ids = rows.map(r => r.id);
    console.log(`📊 Phát hiện tổng cộng ${ids.length} từ ID chẵn khuyết ví dụ. Đang phân bổ đều cho ${TOTAL_WORKERS} luồng...`);

    // Khởi tạo mảng nhiệm vụ cho từng Worker
    const workerLists = Array.from({ length: TOTAL_WORKERS }, () => []);

    // Phân chia nhiệm vụ theo cơ chế Round-Robin để đảm bảo khối lượng công việc cân bằng nhất
    ids.forEach((id, index) => {
        const workerId = index % TOTAL_WORKERS;
        workerLists[workerId].push(id);
    });

    // Ghi nhiệm vụ ra các file JSON cục bộ
    for (let i = 0; i < TOTAL_WORKERS; i++) {
        const filename = `./todo_worker_${i}.json`;
        fs.writeFileSync(filename, JSON.stringify(workerLists[i], null, 2));
        console.log(`📝 Đã chuẩn bị ${workerLists[i].length} từ cho Worker ${i} -> ${filename}`);
    }

    console.log("\n✅ Đã hoàn thành chuẩn bị nhiệm vụ ID chẵn. Bạn có thể khởi động các luồng Worker.");
}

run().catch(err => console.error(err));