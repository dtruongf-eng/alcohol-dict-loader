// import_minna_1_sections.js
import fs from 'fs';
import { execSync } from 'child_process';

const DB_NAME = "alcohol-dictionary";
const JSON_FILE = "./minna_no_nihongo_I.json"; // Tên file JSON Minna I của bạn
const BATCH_SIZE = 1000;                       // Gom 1000 lệnh SQL chạy 1 lần để tối ưu hóa tốc độ

// Hàm xử lý loại bỏ ký tự nháy đơn nguy hiểm để tránh lỗi cú pháp SQL
const escapeSQL = (str) => {
    if (!str) return "";
    return str.toString().replace(/'/g, "''");
};

async function run() {
    if (!fs.existsSync(JSON_FILE)) {
        console.error(`❌ Lỗi: Không tìm thấy file JSON Minna I tại đường dẫn: ${JSON_FILE}`);
        process.exit(1);
    }

    console.log("📖 Đang đọc và phân tích cấu trúc tệp giáo trình Minna no Nihongo I...");
    let data;
    try {
        data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    } catch (e) {
        console.error("❌ Lỗi cấu trúc file JSON:", e.message);
        process.exit(1);
    }

    if (!Array.isArray(data)) {
        console.error("❌ Lỗi: File JSON phải ở định dạng mảng các bài học [ {...} ]");
        process.exit(1);
    }

    const PARENT_TAG = "#curriculum_minna_1";
    const PARENT_NAME = "Giáo trình Minna no Nihongo I (Bài 1 - 25)";

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
    // GIAI ĐOẠN 2: TỰ ĐỘNG KHỞI TẠO METADATA CHA & 25 METADATA CON (LESSONS)
    // =========================================================================
    console.log("⚡ Đang tự động biên dịch đề cương chương trình học Minna I (Syllabus)...");
    const metadataSqlStatements = [];

    // 1. Đăng ký nhãn cha
    metadataSqlStatements.push(`
        INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
        VALUES ('${PARENT_TAG}', '${escapeSQL(PARENT_NAME)}', 'Giáo trình', 'minna 1, mina 1, so cap 1, nihongo 1', NULL, 1);
    `.trim().replace(/\s+/g, ' '));

    const wordsToTagPayload = []; // Mảng trung gian lưu vết để gán tags cho từ ở Giai đoạn 3

    // 2. Duyệt qua 25 Bài học để tự động đăng ký 25 Phân đoạn con
    data.forEach(lesson => {
        const lessonNum = lesson.chapter || lesson.lesson || lesson.section; // Hỗ trợ linh hoạt các kiểu đặt tên
        const lessonTitle = lesson.title ? lesson.title.trim() : `Bài ${lessonNum}`;
        
        const childTagId = `${PARENT_TAG}_s${lessonNum}`;
        const displayName = `Minna I - ${lessonTitle}`;
        const searchKeywords = `minna 1, mina 1, bai ${lessonNum}, ${lessonTitle}`.toLowerCase();
        const sortOrder = lessonNum;

        // Đăng ký tag con vào SQL
        metadataSqlStatements.push(`
            INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
            VALUES ('${childTagId}', '${escapeSQL(displayName)}', 'Giáo trình', '${escapeSQL(searchKeywords)}', '${PARENT_TAG}', ${sortOrder});
        `.trim().replace(/\s+/g, ' '));

        // Lưu vết các từ thuộc bài học này để gán nhãn ở Giai đoạn 3
        if (lesson.words && Array.isArray(lesson.words)) {
            lesson.words.forEach(word => {
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
    console.log(`📦 Đang đẩy đề cương ${metadataSqlStatements.length - 1} bài học của Minna I lên Cloud D1...`);
    const tempMetaFile = `./temp_minna_1_meta.sql`;
    fs.writeFileSync(tempMetaFile, metadataSqlStatements.join('\n'));
    try {
        execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempMetaFile}`);
        console.log("✅ Đăng ký Đề cương chương trình học Minna I lên D1 thành công!");
    } catch (err) {
        console.error("❌ Đăng ký Đề cương thất bại:", err.message);
        process.exit(1);
    } finally {
        if (fs.existsSync(tempMetaFile)) fs.unlinkSync(tempMetaFile);
    }

    // =========================================================================
    // GIAI ĐOẠN 3: GÁN NHÃN ĐỒNG THỜI (DOUBLE-TAGGING) CHO TỪ VỰNG D1
    // =========================================================================
    console.log(`\n📊 Bắt đầu gán nhãn tags mới cho ${wordsToTagPayload.length} từ vựng thuộc Minna I...`);
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

        const tempSqlFile = `./temp_minna_1_words.sql`;
        fs.writeFileSync(tempSqlFile, sqlStatements.join('\n'));

        console.log(`⏳ Đang gán tag Minna I cho mẻ từ ${i + 1} đến ${Math.min(i + BATCH_SIZE, wordsToTagPayload.length)}...`);

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
    console.log(`✅ Đã thiết lập xong sơ đồ phân cấp và gán nhãn tags cho ${successCount} từ vựng Minna I trong D1.`);
}

run().catch(err => console.error(err));
