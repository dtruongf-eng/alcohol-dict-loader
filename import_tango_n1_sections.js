// import_tango_n1_sections.js
import fs from 'fs';
import { execSync } from 'child_process';

const DB_NAME = "alcohol-dictionary";
const JSON_FILE = "./n1_vocab_all.json"; // Đường dẫn tới file JSON Tango N1 của bạn
const BATCH_SIZE = 1000;                // Gom 1000 câu lệnh SQL chạy 1 lần để tối ưu tốc độ

// Hàm loại bỏ ký tự nháy đơn nguy hiểm để tránh lỗi cú pháp SQL
const escapeSQL = (str) => {
    if (!str) return "";
    return str.toString().replace(/'/g, "''");
};

async function run() {
    if (!fs.existsSync(JSON_FILE)) {
        console.error(`❌ Lỗi: Không tìm thấy file JSON Tango N1 tại đường dẫn: ${JSON_FILE}`);
        process.exit(1);
    }

    console.log("📖 Đang đọc và phân tích cấu trúc tệp giáo trình Tango N1...");
    let data;
    try {
        data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    } catch (e) {
        console.error("❌ Lỗi cấu trúc file JSON:", e.message);
        process.exit(1);
    }

    if (!Array.isArray(data)) {
        console.error("❌ Lỗi: File JSON phải ở định dạng mảng các phân đoạn [ {...} ]");
        process.exit(1);
    }

    const PARENT_TAG = "#curriculum_tango_n1";
    const PARENT_NAME = "Từ vựng Tango 3000 N1";

    // =========================================================================
    // GIAI ĐOẠN 1: TỰ ĐỘNG DỌN DẸP NHÃN CŨ KHỎI TẤT CẢ CÁC TỪ TRÊN D1 (CLEANING)
    // =========================================================================
    console.log(`🧹 [Dọn dẹp] Đang gỡ bỏ nhãn cũ '${PARENT_TAG}' trên D1 để chuẩn bị làm lại từ đầu...`);
    
    // Câu lệnh SQL bóc tách và loại bỏ nhãn cũ ra khỏi chuỗi tags ngăn cách bởi dấu phẩy
    const cleanQuery = `
        UPDATE dictionary 
        SET tags = CASE 
            WHEN tags = '${PARENT_TAG}' THEN NULL
            WHEN tags LIKE '${PARENT_TAG},%' THEN REPLACE(tags, '${PARENT_TAG},', '')
            WHEN tags LIKE '%,${PARENT_TAG}' THEN REPLACE(tags, ',${PARENT_TAG}', '')
            WHEN tags LIKE '%,${PARENT_TAG},%' THEN REPLACE(tags, ',${PARENT_TAG},', ',')
            ELSE tags
        END
        WHERE tags LIKE '%${PARENT_TAG}%';
    `.trim().replace(/\s+/g, ' ');

    try {
        execSync(`npx wrangler d1 execute ${DB_NAME} --remote --command="${cleanQuery}"`);
        console.log("✓ Đã dọn dẹp sạch sẽ nhãn cũ thành công!");
    } catch (err) {
        console.error("❌ Lỗi dọn dẹp nhãn cũ:", err.message);
        process.exit(1);
    }

    // =========================================================================
    // GIAI ĐOẠN 2: TỰ ĐỘNG KHỞI TẠO METADATA CHA & 43 METADATA CON (SECTIONS)
    // =========================================================================
    console.log("\n⚡ Đang tự động biên dịch đề cương chương trình học N1 (Syllabus)...");
    const metadataSqlStatements = [];

    // 1. Đăng ký nhãn cha
    metadataSqlStatements.push(`
        INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
        VALUES ('${PARENT_TAG}', '${escapeSQL(PARENT_NAME)}', 'Giáo trình', 'tango n1, tango 3000, n1, cao cap', NULL, 4);
    `.trim().replace(/\s+/g, ' '));

    const wordsToTagPayload = [];

    // 2. Duyệt qua mảng phẳng các phân đoạn trong JSON để đăng ký tự động
    data.forEach((item, idx) => {
        const rawTitle = item.title ? item.title.trim() : `Section ${idx + 1}`;
        
        // Tạo Tag ID và Display Name theo cấu trúc thứ tự mảng phẳng
        const childTagId = `${PARENT_TAG}_s${idx + 1}`;
        const displayName = rawTitle;
        const searchKeywords = `tango n1, ${rawTitle.toLowerCase()}`;
        const sortOrder = idx + 1; // Sắp xếp theo đúng trình tự xuất hiện trong tệp JSON của bạn

        // Đăng ký tag con vào SQL
        metadataSqlStatements.push(`
            INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
            VALUES ('${childTagId}', '${escapeSQL(displayName)}', 'Giáo trình', '${escapeSQL(searchKeywords)}', '${PARENT_TAG}', ${sortOrder});
        `.trim().replace(/\s+/g, ' '));

        // Lưu vết các từ thuộc phân đoạn này để gán nhãn ở Giai đoạn 3
        if (item.words && Array.isArray(item.words)) {
            item.words.forEach(word => {
                const cleanWord = word.trim();
                if (cleanWord) {
                    wordsToTagPayload.push({
                        word: cleanWord,
                        childTag: childTagId
                    });
                }
            });
        }
    });

    // Thực thi đăng ký Đề cương lên D1
    console.log(`📦 Đang đẩy đề cương ${metadataSqlStatements.length - 1} phân đoạn của Tango N1 lên Cloud D1...`);
    const tempMetaFile = `./temp_tango_n1_meta.sql`;
    fs.writeFileSync(tempMetaFile, metadataSqlStatements.join('\n'));
    try {
        execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempMetaFile}`);
        console.log("✅ Đăng ký Đề cương chương trình học N1 lên D1 thành công!");
    } catch (err) {
        console.error("❌ Đăng ký Đề cương thất bại:", err.message);
        process.exit(1);
    } finally {
        if (fs.existsSync(tempMetaFile)) fs.unlinkSync(tempMetaFile);
    }

    // =========================================================================
    // GIAI ĐOẠN 3: GÁN NHÃN ĐỒNG THỜI (DOUBLE-TAGGING) CHO TỪ VỰNG D1
    // =========================================================================
    console.log(`\n📊 Bắt đầu gán nhãn tags mới cho ${wordsToTagPayload.length} từ vựng thuộc Tango N1...`);
    let successCount = 0;

    for (let i = 0; i < wordsToTagPayload.length; i += BATCH_SIZE) {
        const chunk = wordsToTagPayload.slice(i, i + BATCH_SIZE);
        const sqlStatements = [];

        chunk.forEach(item => {
            const escapedWord = escapeSQL(item.word);
            const childTag = item.childTag;

            // Thuật toán gán đồng thời (Double-tagging) và nối tiếp an toàn
            const query = `
                UPDATE dictionary 
                SET tags = CASE 
                    WHEN tags IS NULL OR trim(tags) = '' THEN '${PARENT_TAG},${childTag}' 
                    ELSE tags || ',${PARENT_TAG},${childTag}' 
                END 
                WHERE word = '${escapedWord}' 
                  AND (tags IS NULL OR ',' || tags || ',' NOT LIKE '%,${childTag},%');
            `.trim().replace(/\s+/g, ' ');

            sqlStatements.push(query);
        });

        const tempSqlFile = `./temp_tango_n1_words.sql`;
        fs.writeFileSync(tempSqlFile, sqlStatements.join('\n'));

        console.log(`⏳ Đang gán tag Tango N1 cho mẻ từ ${i + 1} đến ${Math.min(i + BATCH_SIZE, wordsToTagPayload.length)}...`);

        try {
            execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempSqlFile}`);
            successCount += chunk.length;
        } catch (err) {
            console.error(`❌ Ghi mẻ SQL từ vựng bị lỗi ở dòng thứ ${i + 1}:`, err.message);
        } finally {
            if (fs.existsSync(tempSqlFile)) {
                fs.unlinkSync(tempSqlFile); // Giải phóng file tạm tức thì
            }
        }
    }

    console.log(`\n🎉 TIẾN TRÌNH HOÀN TẤT THÀNH CÔNG!`);
    console.log(`✅ Đã đồng bộ mới sơ đồ phân cấp và gán nhãn tags chuẩn xác cho ${successCount} từ vựng Tango N1 trong D1.`);
}

run().catch(err => console.error(err));
