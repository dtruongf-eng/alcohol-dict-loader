// import_jlpt_levels.js
import fs from 'fs';
import { execSync } from 'child_process';

const DB_NAME = "alcohol-dictionary";
const JSON_FILE = "./jlpt_vocab_all.json"; // ⚠️ Đổi tên file này trùng với file JSON JLPT của bạn
const BATCH_SIZE = 1000;                // Gom 1000 câu lệnh UPDATE thành 1 file SQL chạy siêu tốc

// Hàm xử lý loại bỏ ký tự nháy đơn nguy hiểm để chống lỗi SQL
const escapeSQL = (str) => {
    if (!str) return "";
    return str.toString().replace(/'/g, "''");
};

async function run() {
    if (!fs.existsSync(JSON_FILE)) {
        console.error(`❌ Lỗi: Không tìm thấy file JSON JLPT tại đường dẫn: ${JSON_FILE}`);
        process.exit(1);
    }

    console.log("📖 Đang đọc file JSON JLPT...");
    let rawData;
    try {
        rawData = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    } catch (e) {
        console.error("❌ Lỗi cấu trúc file JSON:", e.message);
        process.exit(1);
    }

    if (!Array.isArray(rawData)) {
        console.error("❌ Lỗi: File JSON phải là định dạng mảng [ {...} ]");
        process.exit(1);
    }

    // Khử trùng lặp từ vựng ngay trên file JSON trước khi xử lý để tiết kiệm tài nguyên
    const uniqueVocabMap = new Map();
    rawData.forEach(item => {
        const word = item.word ? item.word.trim() : "";
        const level = item.jlpt_level ? item.jlpt_level.trim().toUpperCase() : "";
        if (word && level) {
            uniqueVocabMap.set(word, level);
        }
    });

    const vocabList = Array.from(uniqueVocabMap.entries());
    console.log(`📊 Đã lọc và chuẩn bị xong ${vocabList.length} từ JLPT độc bản.`);

    let successCount = 0;

    // Tiến hành chia nhỏ thành từng mẻ 1000 câu lệnh cập nhật
    for (let i = 0; i < vocabList.length; i += BATCH_SIZE) {
        const chunk = vocabList.slice(i, i + BATCH_SIZE);
        const sqlStatements = [];

        chunk.forEach(([word, level]) => {
            const escapedWord = escapeSQL(word);
            // Gán level JLPT chuẩn dựa trên mặt chữ
            sqlStatements.push(`UPDATE dictionary SET level = '${level}' WHERE word = '${escapedWord}';`);
        });

        const tempSqlFile = `./temp_import_levels.sql`;
        fs.writeFileSync(tempSqlFile, sqlStatements.join('\n'));

        console.log(`⏳ Đang nạp mẻ cấp độ: từ ${i + 1} đến ${Math.min(i + BATCH_SIZE, vocabList.length)}...`);

        try {
            execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempSqlFile}`);
            successCount += chunk.length;
        } catch (err) {
            console.error(`❌ Ghi mẻ SQL bị lỗi ở dòng ${i + 1}:`, err.message);
        } finally {
            if (fs.existsSync(tempSqlFile)) {
                fs.unlinkSync(tempSqlFile); // Dọn dẹp tệp tạm ngay lập tức
            }
        }
    }

    console.log(`\n🎉 HOÀN TẤT TIẾN TRÌNH!`);
    console.log(`✅ Đã cập nhật thành công cấp độ JLPT chuẩn hóa cho ${successCount} từ vựng trong từ điển D1.`);
}

run().catch(err => console.error(err));
