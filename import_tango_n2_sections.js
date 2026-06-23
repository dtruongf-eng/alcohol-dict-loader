// import_tango_n2_sections.js
import fs from 'fs';
import { execSync } from 'child_process';

const DB_NAME = "alcohol-dictionary";
const JSON_FILE = "./tango_n2_vocabulary.json"; // Tên file JSON Tango N2 của bạn
const BATCH_SIZE = 1000;                       // Gom 1000 lệnh SQL chạy 1 lần để tối ưu hóa tốc độ

// Hàm xử lý loại bỏ ký tự nháy đơn nguy hiểm để tránh lỗi cú pháp SQL
const escapeSQL = (str) => {
    if (!str) return "";
    return str.toString().replace(/'/g, "''");
};

async function run() {
    if (!fs.existsSync(JSON_FILE)) {
        console.error(`❌ Lỗi: Không tìm thấy file JSON Tango N2 tại đường dẫn: ${JSON_FILE}`);
        process.exit(1);
    }

    console.log("📖 Đang đọc và phân tích cấu trúc tệp giáo trình Tango N2...");
    let data;
    try {
        data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    } catch (e) {
        console.error("❌ Lỗi cấu trúc file JSON:", e.message);
        process.exit(1);
    }

    const PARENT_TAG = "#curriculum_tango_n2";
    const PARENT_NAME = "Từ vựng Tango 2500 N2";

    // =========================================================================
    // GIAI ĐOẠN 1: TỰ ĐỘNG KHỞI TẠO METADATA CHA & 60 METADATA CON (SECTIONS)
    // =========================================================================
    console.log("⚡ Đang tự động biên dịch đề cương chương trình học (Syllabus)...");
    const metadataSqlStatements = [];

    // 1. Đăng ký nhãn cha
    metadataSqlStatements.push(`
        INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
        VALUES ('${PARENT_TAG}', '${escapeSQL(PARENT_NAME)}', 'Giáo trình', 'tango n2, tango 2500, n2, thuong cap', NULL, 3);
    `.trim().replace(/\s+/g, ' '));

    const wordsToTagPayload = []; // Mảng trung gian lưu vết để gán tags cho từ ở Giai đoạn 2

    // 2. Duyệt qua 12 Chương để tự động đăng ký 60 Phân đoạn con
    if (data.chapters && Array.isArray(data.chapters)) {
        data.chapters.forEach(chapter => {
            const chapterNum = chapter.chapter;
            const chapterTitle = chapter.title ? chapter.title.trim() : "";

            if (chapter.sections && Array.isArray(chapter.sections)) {
                chapter.sections.forEach(section => {
                    const sectionNum = section.section;
                    const sectionTitle = section.title ? section.title.trim() : "";
                    
                    const childTagId = `${PARENT_TAG}_c${chapterNum}_s${sectionNum}`;
                    const displayName = `Chương ${chapterNum} - Bài ${sectionNum}: ${sectionTitle} (${chapterTitle})`;
                    const searchKeywords = `tango n2, chuong ${chapterNum}, bai ${sectionNum}, ${chapterTitle}, ${sectionTitle}`.toLowerCase();
                    const sortOrder = (chapterNum - 1) * 5 + sectionNum; // Thứ tự sắp xếp tăng dần từ 1 đến 60

                    // Đăng ký tag con vào SQL
                    metadataSqlStatements.push(`
                        INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
                        VALUES ('${childTagId}', '${escapeSQL(displayName)}', 'Giáo trình', '${escapeSQL(searchKeywords)}', '${PARENT_TAG}', ${sortOrder});
                    `.trim().replace(/\s+/g, ' '));

                    // Lưu vết các từ thuộc section này để gán nhãn
                    if (section.words && Array.isArray(section.words)) {
                        section.words.forEach(word => {
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
            }
        });
    }

    // Thực thi đăng ký Đề cương lên D1
    console.log(`📦 Đang đẩy đề cương ${metadataSqlStatements.length - 1} phân đoạn của Tango N2 lên Cloud D1...`);
    const tempMetaFile = `./temp_tango_n2_meta.sql`;
    fs.writeFileSync(tempMetaFile, metadataSqlStatements.join('\n'));
    try {
        execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempMetaFile}`);
        console.log("✅ Đăng ký Đề cương chương trình học lên D1 thành công!");
    } catch (err) {
        console.error("❌ Đăng ký Đề cương thất bại:", err.message);
        process.exit(1);
    } finally {
        if (fs.existsSync(tempMetaFile)) fs.unlinkSync(tempMetaFile);
    }

    // =========================================================================
    // GIAI ĐOẠN 2: GÁN NHÃN ĐỒNG THỜI (DOUBLE-TAGGING) CHO TỪ VỰNG D1
    // =========================================================================
    console.log(`\n📊 Bắt đầu gán nhãn tags cho ${wordsToTagPayload.length} từ vựng thuộc Tango N2...`);
    let successCount = 0;

    for (let i = 0; i < wordsToTagPayload.length; i += BATCH_SIZE) {
        const chunk = wordsToTagPayload.slice(i, i + BATCH_SIZE);
        const sqlStatements = [];

        chunk.forEach(item => {
            const escapedWord = escapeSQL(item.word);
            const childTag = item.childTag;

            // 🟢 THUẬT TOÁN GÁN ĐỒNG THỜI (DOUBLE-TAGGING) AN TOÀN LUỒNG:
            // - Lần đầu: Gán đồng thời cả Tag Cha và Tag Con
            // - Lần sau: Nối tiếp cả 2 tag nếu chưa có, bảo toàn các tag cũ đang tồn tại trong D1
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

        const tempSqlFile = `./temp_tango_n2_words.sql`;
        fs.writeFileSync(tempSqlFile, sqlStatements.join('\n'));

        console.log(`⏳ Đang gán tag Tango N2 cho mẻ từ ${i + 1} đến ${Math.min(i + BATCH_SIZE, wordsToTagPayload.length)}...`);

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
    console.log(`✅ Đã thiết lập xong sơ đồ phân cấp và gán nhãn tags cho ${successCount} từ vựng Tango N2 trong D1.`);
}

run().catch(err => console.error(err));
