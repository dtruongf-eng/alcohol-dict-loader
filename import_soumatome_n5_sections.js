// import_soumatome_n5_sections.js
import fs from 'fs';
import { execSync } from 'child_process';

const DB_NAME = "alcohol-dictionary";
const JSON_FILE = "./soumatomeN5_vocab.json"; // Tên file JSON Soumatome N5 của bạn
const BATCH_SIZE = 1000;                       // Gom 1000 lệnh SQL chạy 1 lần để tối ưu hóa tốc độ

// Hàm xử lý loại bỏ ký tự nháy đơn nguy hiểm để tránh lỗi cú pháp SQL
const escapeSQL = (str) => {
    if (!str) return "";
    return str.toString().replace(/'/g, "''");
};

async function run() {
    if (!fs.existsSync(JSON_FILE)) {
        console.error(`❌ Lỗi: Không tìm thấy file JSON Soumatome N5 tại đường dẫn: ${JSON_FILE}`);
        process.exit(1);
    }

    console.log("📖 Đang đọc và phân tích cấu trúc tệp giáo trình Soumatome N5...");
    let data;
    try {
        const fileContent = fs.readFileSync(JSON_FILE, 'utf8');
        
        // 🟢 BỘ TỰ ĐỘNG SỬA LỖI ĐỊNH DẠNG FILE JSON (SELF-SANITIZING):
        // Chỉ quét tìm phím Enter xuống dòng nằm bên trong dấu nháy kép "" và tự động sửa thành "\n" hợp lệ
        // để JSON.parse() hoạt động, TUYỆT ĐỐI không can thiệp hay thay đổi bất kỳ chuỗi từ vựng nào bên trong.
        const sanitizedContent = fileContent.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, p1) => {
            return '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '') + '"';
        });

        // Parse nội dung đã được làm sạch hoàn toàn
        data = JSON.parse(sanitizedContent);
    } catch (e) {
        console.error("❌ Lỗi cấu trúc file JSON:", e.message);
        process.exit(1);
    }

    const PARENT_TAG = "#curriculum_soumatome_n5";
    const PARENT_NAME = "Từ vựng Soumatome N5";

    // =========================================================================
    // GIAI ĐOẠN 1: TỰ ĐỘNG KHỞI TẠO METADATA CHA & 7 METADATA CON (SECTIONS)
    // =========================================================================
    console.log("⚡ Đang tự động biên dịch đề cương chương trình học Soumatome N5 (Syllabus)...");
    const metadataSqlStatements = [];

    // 1. Đăng ký nhãn cha
    metadataSqlStatements.push(`
        INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
        VALUES ('${PARENT_TAG}', '${escapeSQL(PARENT_NAME)}', 'Giáo trình', 'soumatome n5, somatome n5, n5, so cap', NULL, 3);
    `.trim().replace(/\s+/g, ' '));

    const wordsToTagPayload = []; // Mảng trung gian lưu vết để gán tags cho từ ở Giai đoạn 2

    // 2. Duyệt qua mảng phẳng các phân đoạn trong JSON để đăng ký tự động (7 ngày)
    if (data.sections && Array.isArray(data.sections)) {
        data.sections.forEach((item, idx) => {
            const sectionTitle = item.title ? item.title.trim() : `Bài học ${idx + 1}`;
            
            const childTagId = `${PARENT_TAG}_s${idx + 1}`;
            const displayName = `Soumatome N5 - ${sectionTitle}`;
            const searchKeywords = `soumatome n5, somatome n5, ${sectionTitle}`.toLowerCase();
            const sortOrder = idx + 1; // Thứ tự sắp xếp từ 1 đến 7 tương ứng

            // Đăng ký tag con vào SQL (Cú pháp dấu đóng ngoặc đã được kiểm tra chuẩn xác)
            metadataSqlStatements.push(`
                INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
                VALUES ('${childTagId}', '${escapeSQL(displayName)}', 'Giáo trình', '${escapeSQL(searchKeywords)}', '${PARENT_TAG}', ${sortOrder});
            `.trim().replace(/\s+/g, ' '));

            // Lưu vết các từ thuộc phân đoạn này để gán nhãn ở Giai đoạn 2
            if (item.words && Array.isArray(item.words)) {
                item.words.forEach(word => {
                    const cleanWord = word ? word.trim() : ""; // Bảo toàn 100% nguyên trạng mặt chữ gốc
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

    // Thực thi đăng ký Đề cương lên D1
    console.log(`📦 Đang đẩy đề cương ${metadataSqlStatements.length - 1} phân đoạn của Soumatome N5 lên Cloud D1...`);
    const tempMetaFile = `./temp_soumatome_n5_meta.sql`;
    fs.writeFileSync(tempMetaFile, metadataSqlStatements.join('\n'));
    try {
        execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempMetaFile}`);
        console.log("✅ Đăng ký Đề cương chương trình học Soumatome N5 lên D1 thành công!");
    } catch (err) {
        console.error("❌ Đăng ký Đề cương thất bại:", err.message);
        process.exit(1);
    } finally {
        if (fs.existsSync(tempMetaFile)) fs.unlinkSync(tempMetaFile);
    }

    // =========================================================================
    // GIAI ĐOẠN 2: GÁN NHÃN ĐỒNG THỜI (DOUBLE-TAGGING) CHO TỪ VỰNG D1 (TÍCH LŨY)
    // =========================================================================
    console.log(`\n📊 Bắt đầu gán nhãn tags mới cho từ vựng thuộc Soumatome N5...`);
    let successCount = 0;

    for (let i = 0; i < wordsToTagPayload.length; i += BATCH_SIZE) {
        const chunk = wordsToTagPayload.slice(i, i + BATCH_SIZE);
        const sqlStatements = [];

        chunk.forEach(item => {
            const escapedWord = escapeSQL(item.word);
            const childTag = item.childTag;

            // Thuật toán gán đồng thời (Double-tagging) và nối tiếp tích lũy an toàn
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

        const tempSqlFile = `./temp_soumatome_n5_words.sql`;
        fs.writeFileSync(tempSqlFile, sqlStatements.join('\n'));

        console.log(`⏳ Đang gán tag Soumatome N5 cho mẻ từ ${i + 1} đến ${Math.min(i + BATCH_SIZE, wordsToTagPayload.length)}...`);

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
    console.log(`✅ Đã thiết lập xong sơ đồ phân cấp và gán nhãn tags tích lũy cho ${successCount} từ vựng Soumatome N5 trong D1.`);
}

run().catch(err => console.error(err));
