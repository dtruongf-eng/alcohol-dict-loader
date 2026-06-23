// import_tango_n1_tags.js
import fs from 'fs';
import { execSync } from 'child_process';

const DB_NAME = "alcohol-dictionary";
const JSON_FILE = "./tango_n1.json"; // ⚠️ Đổi tên file này trùng với file JSON Tango N1 của bạn
const BATCH_SIZE = 1000;              // Gom 1000 lệnh UPDATE để thực thi siêu tốc trong 1 request

// Hàm xử lý loại bỏ ký tự nháy đơn nguy hiểm để tránh lỗi cú pháp SQL
const escapeSQL = (str) => {
    if (!str) return "";
    return str.toString().replace(/'/g, "''");
};

async function run() {
    if (!fs.existsSync(JSON_FILE)) {
        console.error(`❌ Lỗi: Không tìm thấy file JSON Tango N1 tại đường dẫn: ${JSON_FILE}`);
        process.exit(1);
    }

    console.log("📖 Đang đọc tệp từ vựng Tango N1...");
    let rawData;
    try {
        rawData = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    } catch (e) {
        console.error("❌ Lỗi cấu trúc file JSON:", e.message);
        process.exit(1);
    }

    if (!Array.isArray(rawData)) {
        console.error("❌ Lỗi: File JSON phải ở định dạng mảng [ {...} ]");
        process.exit(1);
    }

    // Lọc trùng lặp mặt chữ ngay trên RAM trước khi tạo SQL để tối ưu hóa hiệu năng
    const uniqueWordsSet = new Set();
    rawData.forEach(item => {
        // Hỗ trợ bóc tách linh hoạt trường mặt chữ (word hoặc kanji) tùy theo schema của file JSON
        const word = (item.word || item.kanji || "").toString().trim();
        if (word) {
            uniqueWordsSet.add(word);
        }
    });

    const wordsList = Array.from(uniqueWordsSet);
    console.log(`📊 Đã quy hoạch xong danh sách gồm ${wordsList.length} từ vựng Tango N1 độc bản.`);

    const TARGET_TAG = "#curriculum_tango_n1";
    let successCount = 0;

    // Tiến hành chia nhỏ dữ liệu và thực thi theo từng mẻ 1000 từ
    for (let i = 0; i < wordsList.length; i += BATCH_SIZE) {
        const chunk = wordsList.slice(i, i + BATCH_SIZE);
        const sqlStatements = [];

        chunk.forEach(word => {
            const escapedWord = escapeSQL(word);
            
            // 🟢 THUẬT TOÁN SQL AN TOÀN LUỒNG:
            // - CASE WHEN: Nếu cột tags trống thì gán mới, nếu đã có sẵn tag khác thì nối tiếp ',#curriculum_tango_n1' vào cuối.
            // - WHERE ... NOT LIKE: Chỉ cập nhật khi từ đó chưa hề chứa tag này để tránh gán lặp lại.
            const query = `
                UPDATE dictionary 
                SET tags = CASE 
                    WHEN tags IS NULL OR trim(tags) = '' THEN '${TARGET_TAG}' 
                    ELSE tags || ',${TARGET_TAG}' 
                END 
                WHERE word = '${escapedWord}' 
                  AND (tags IS NULL OR ',' || tags || ',' NOT LIKE '%,${TARGET_TAG},%');
            `.trim().replace(/\s+/g, ' ');

            sqlStatements.push(query);
        });

        const tempSqlFile = `./temp_tango_n1.sql`;
        fs.writeFileSync(tempSqlFile, sqlStatements.join('\n'));

        console.log(`⏳ Đang gán tag Tango N1 cho mẻ từ ${i + 1} đến ${Math.min(i + BATCH_SIZE, wordsList.length)}...`);

        try {
            execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempSqlFile}`);
            successCount += chunk.length;
        } catch (err) {
            console.error(`❌ Ghi mẻ SQL bị lỗi ở dòng thứ ${i + 1}:`, err.message);
        } finally {
            if (fs.existsSync(tempSqlFile)) {
                fs.unlinkSync(tempSqlFile); // Giải phóng file tạm tức thì
            }
        }
    }

    console.log(`\n🎉 HOÀN TẤT TIẾN TRÌNH!`);
    console.log(`✅ Đã gán thành công tag '${TARGET_TAG}' cho ${successCount} từ vựng Tango N1 trong D1.`);
}

run().catch(err => console.error(err));
