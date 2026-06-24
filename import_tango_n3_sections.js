// import_tango_n3_sections.js
import fs from 'fs';
import { execSync } from 'child_process';

const DB_NAME = "alcohol-dictionary";
const JSON_FILE = "./jlpt_n3_vocabulary.json"; // Tên file JSON Tango N3 của bạn
const BATCH_SIZE = 1000;                       // Gom 1000 lệnh SQL chạy 1 lần để tối ưu hóa tốc độ

// 🟢 BỘ CHUẨN HÓA TỪ VỰNG CHUYÊN SÂU (SEMANTIC WORD NORMALIZER):
// Tự động gọt dũa các ký tự phụ trợ ngữ pháp trong giáo trình để đưa về dạng mặt chữ Nhật nguyên bản trong D1
const cleanWordForD1 = (rawWord) => {
    if (!rawWord) return "";
    let w = rawWord.trim();
    // 1. Loại bỏ giải thích trong ngoặc đơn/ngoặc vuông (Ví dụ: （人を）ふる -> ふる, ［ご］夫妻 -> 夫妻)
    w = w.replace(/[（(].*?[)）]/g, '');
    w = w.replace(/[［\[].*?[］\]]/g, '');
    // 2. Loại bỏ các hậu tố chỉ loại từ như ＜する＞, ＜な＞, <...>, &gt;
    w = w.replace(/＜.*?＞/g, '');
    w = w.replace(/<.*?>/g, '');
    w = w.replace(/くする&gt;/gi, ''); // Vá lỗi chuỗi html đặc biệt (Ví dụ: 借金くする&gt; -> 借金)
    // 3. Loại bỏ khoảng trắng thừa còn sót lại
    return w.trim();
};

// Hàm xử lý loại bỏ ký tự nháy đơn nguy hiểm để tránh lỗi cú pháp SQL
const escapeSQL = (str) => {
    if (!str) return "";
    return str.toString().replace(/'/g, "''");
};

async function run() {
    if (!fs.existsSync(JSON_FILE)) {
        console.error(`❌ Lỗi: Không tìm thấy file JSON Tango N3 tại đường dẫn: ${JSON_FILE}`);
        process.exit(1);
    }

    console.log("📖 Đang đọc và phân tích cấu trúc tệp giáo trình Tango N3...");
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

    const PARENT_TAG = "#curriculum_tango_n3";
    const PARENT_NAME = "Từ vựng Tango 2000 N3";

    // =========================================================================
    // GIAI ĐOẠN 1: TỰ ĐỘNG DỌN DẸP NHÃN CŨ KHỎI TẤT CẢ CÁC TỪ TRÊN D1 (CLEANING)
    // =========================================================================
    console.log(`🧹 [Dọn dẹp] Đang gỡ bỏ nhãn cũ '${PARENT_TAG}' trên D1 để chuẩn bị làm lại từ đầu...`);
    
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
    // GIAI ĐOẠN 2: TỰ ĐỘNG KHỞI TẠO METADATA CHA & 60 METADATA CON (SECTIONS)
    // =========================================================================
    console.log("\n⚡ Đang tự động biên dịch đề cương chương trình học N3 (Syllabus)...");
    const metadataSqlStatements = [];

    // 1. Đăng ký nhãn cha
    metadataSqlStatements.push(`
        INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
        VALUES ('${PARENT_TAG}', '${escapeSQL(PARENT_NAME)}', 'Giáo trình', 'tango n3, tango 2000, n3, trung cap', NULL, 3);
    `.trim().replace(/\s+/g, ' '));

    const wordsToTagPayload = [];

    // 2. Duyệt qua mảng các phân đoạn trong JSON để đăng ký tự động
    data.forEach((item) => {
        const chapterNum = item.chapter;
        const sectionNum = item.section;
        const sectionTitle = item.title ? item.title.trim() : "";
        
        // Tạo Tag ID và Display Name theo cấu trúc chuẩn
        const childTagId = `${PARENT_TAG}_c${chapterNum}_s${sectionNum}`;
        const displayName = `Chương ${chapterNum} - Bài ${sectionNum}: ${sectionTitle}`;
        const searchKeywords = `tango n3, chuong ${chapterNum}, bai ${sectionNum}, ${sectionTitle}`.toLowerCase();
        const sortOrder = (chapterNum - 1) * 5 + sectionNum; // Thứ tự sắp xếp tăng dần từ 1 đến 60

        // Đăng ký tag con vào SQL
        metadataSqlStatements.push(`
            INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
            VALUES ('${childTagId}', '${escapeSQL(displayName)}', 'Giáo trình', '${escapeSQL(searchKeywords)}', '${PARENT_TAG}', ${sortOrder});
        `.trim().replace(/\s+/g, ' '));

        // Lưu vết các từ thuộc phân đoạn này để gán nhãn ở Giai đoạn 3
        if (item.words && Array.isArray(item.words)) {
            item.words.forEach(word => {
                // Áp dụng bộ chuẩn hóa mặt chữ ngay khi nạp vào bộ nhớ RAM
                const cleanWord = cleanWordForD1(word);
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
    console.log(`📦 Đang đẩy đề cương ${metadataSqlStatements.length - 1} phân đoạn của Tango N3 lên Cloud D1...`);
    const tempMetaFile = `./temp_tango_n3_meta.sql`;
    fs.writeFileSync(tempMetaFile, metadataSqlStatements.join('\n'));
    try {
        execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempMetaFile}`);
        console.log("✅ Đăng ký Đề cương chương trình học N3 lên D1 thành công!");
    } catch (err) {
        console.error("❌ Đăng ký Đề cương thất bại:", err.message);
        process.exit(1);
    } finally {
        if (fs.existsSync(tempMetaFile)) fs.unlinkSync(tempMetaFile);
    }

    // =========================================================================
    // GIAI ĐOẠN 3: GÁN NHÃN ĐỒNG THỜI (DOUBLE-TAGGING) CHO TỪ VỰNG D1
    // =========================================================================
    console.log(`\n📊 Bắt đầu gán nhãn tags mới cho ${wordsToTagPayload.length} từ vựng thuộc Tango N3...`);
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

        const tempSqlFile = `./temp_tango_n3_words.sql`;
        fs.writeFileSync(tempSqlFile, sqlStatements.join('\n'));

        console.log(`⏳ Đang gán tag Tango N3 cho mẻ từ ${i + 1} đến ${Math.min(i + BATCH_SIZE, wordsToTagPayload.length)}...`);

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
    console.log(`✅ Đã đồng bộ mới sơ đồ phân cấp và gán nhãn tags chuẩn xác cho ${successCount} từ vựng Tango N3 trong D1.`);
}

run().catch(err => console.error(err));
