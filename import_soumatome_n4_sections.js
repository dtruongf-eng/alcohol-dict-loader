// import_soumatome_n4_sections.js
import fs from 'fs';
import { execSync } from 'child_process';

const DB_NAME = "alcohol-dictionary";
const JSON_FILE = "./soumatome_n4_vocab.json"; // Tên file JSON Soumatome N4 của bạn
const BATCH_SIZE = 1000;                       // Gom 1000 lệnh SQL chạy 1 lần để tối ưu hóa tốc độ

// Hàm xử lý loại bỏ ký tự nháy đơn nguy hiểm để tránh lỗi cú pháp SQL
const escapeSQL = (str) => {
    if (!str) return "";
    return str.toString().replace(/'/g, "''");
};

// 🟢 BỘ GIẢI MÃ TỪ VỰNG SOUMATOME N4 SPECIALIST
// Phân tách động từ ghép suru, giải mã XML, xóa ngoặc vuông/tròn/nhọn phụ cảnh và chuẩn hóa khoảng trắng
const extractCleanWords = (rawWord) => {
    if (!rawWord) return [];
    
    // Tách các biến thể bằng dấu phẩy Nhật `、` hoặc phẩy thường `,`
    let parts = rawWord.split(/[、,]/).map(p => p.trim()).filter(Boolean);
    
    let finalWords = [];
    parts.forEach(p => {
        finalWords.push(p); // Phương án 1: Giữ nguyên từ thô gốc
        
        // Giải mã thực thể XML/HTML (Ví dụ: &lt;する&gt; -> <する>)
        let decoded = p.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        
        // Xóa sạch các phụ chú loại từ (な), (の), ［時間に～］
        let clean = decoded.replace(/<.*?>/g, '')
                             .replace(/＜.*?＞/g, '')
                             .replace(/［.*?］/g, '')
                             .replace(/\[.*?\]/g, '')
                             .replace(/（.*?）/g, '')
                             .replace(/\(.*?\)/g, '')
                             .trim();
        
        // Xóa các ký tự đặt chỗ (placeholders) và ký tự sóng
        clean = clean.replace(/〇〇/g, '').replace(/[〜~]/g, '').trim();
        
        // Chuẩn hóa xóa bỏ khoảng trắng thừa ở giữa từ
        let noSpaceClean = clean.replace(/\s+/g, '');
        
        if (clean && clean !== p) finalWords.push(clean);
        if (noSpaceClean && noSpaceClean !== clean && noSpaceClean !== p) finalWords.push(noSpaceClean);
        
        // BỘ TÁCH ĐỘNG TỪ GHÉP: "勉強する" -> tự tách thêm cả danh từ gốc "勉強" để khớp D1
        if (clean.endsWith("する") && clean.length > 2) {
            let rootNoun = clean.substring(0, clean.length - 2);
            if (rootNoun) finalWords.push(rootNoun);
        }
    });
    
    return [...new Set(finalWords)]; // Khử trùng lặp nội bộ
};

async function run() {
    if (!fs.existsSync(JSON_FILE)) {
        console.error(`❌ Lỗi: Không tìm thấy file JSON Soumatome N4 tại đường dẫn: ${JSON_FILE}`);
        process.exit(1);
    }

    console.log("📖 Đang đọc và phân tích cấu trúc tệp giáo trình Soumatome N4...");
    let data;
    try {
        const fileContent = fs.readFileSync(JSON_FILE, 'utf8');
        
        // 🟢 1. BỘ TỰ ĐỘNG LÀM SẠCH VÀ SỬA LỖI FILE JSON (SELF-SANITIZING):
        // Quét tìm tất cả phím Enter xuống dòng nằm bên trong dấu nháy kép "" và tự động sửa thành "\n" hợp lệ
        const sanitizedContent = fileContent.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, p1) => {
            return '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '') + '"';
        });

        // 2. Parse nội dung đã được làm sạch hoàn toàn
        data = JSON.parse(sanitizedContent);
    } catch (e) {
        console.error("❌ Lỗi cấu trúc file JSON:", e.message);
        process.exit(1);
    }

    const PARENT_TAG = "#curriculum_soumatome_n4";
    const PARENT_NAME = "Từ vựng Soumatome N4";

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
    // GIAI ĐOẠN 2: TỰ ĐỘNG KHỞI TẠO METADATA CHA & 39 METADATA CON (SECTIONS)
    // =========================================================================
    console.log("⚡ Đang tự động biên dịch đề cương chương trình học Soumatome N4 (Syllabus)...");
    const metadataSqlStatements = [];

    // 1. Đăng ký nhãn cha
    metadataSqlStatements.push(`
        INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
        VALUES ('${PARENT_TAG}', '${escapeSQL(PARENT_NAME)}', 'Giáo trình', 'soumatome n4, somatome n4, n4, so cap', NULL, 2);
    `.trim().replace(/\s+/g, ' '));

    const wordsToTagPayload = []; // Mảng trung gian lưu vết để gán tags cho từ ở Giai đoạn 3

    // 2. Duyệt qua mảng phẳng các phân đoạn trong JSON để đăng ký tự động (39 ngày)
    if (data.sections && Array.isArray(data.sections)) {
        data.sections.forEach((item, idx) => {
            const sectionTitle = item.title ? item.title.trim() : `Bài học ${idx + 1}`;
            
            const childTagId = `${PARENT_TAG}_s${idx + 1}`;
            const displayName = `Soumatome N4 - ${sectionTitle}`;
            const searchKeywords = `soumatome n4, somatome n4, ${sectionTitle}`.toLowerCase();
            const sortOrder = idx + 1; // Thứ tự sắp xếp từ 1 đến 39 ngày tương ứng

            // Đăng ký tag con vào SQL
            metadataSqlStatements.push(`
                INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
                VALUES ('${childTagId}', '${escapeSQL(displayName)}', 'Giáo trình', '${escapeSQL(searchKeywords)}', '${PARENT_TAG}', ${sortOrder});
            `.trim().replace(/\s+/g, ' ');

            // Lưu vết các từ thuộc phân đoạn này để gán nhãn ở Giai đoạn 3
            if (item.words && Array.isArray(item.words)) {
                item.words.forEach(word => {
                    const cleanWordList = extractCleanWords(word);
                    cleanWordList.forEach(cleanWord => {
                        wordsToTagPayload.push({
                            word: cleanWord,
                            childTag: childTagId
                        });
                    });
                });
            }
        });
    }

    // Thực thi đăng ký Đề cương lên D1
    console.log(`📦 Đang đẩy đề cương ${metadataSqlStatements.length - 1} phân đoạn của Soumatome N4 lên Cloud D1...`);
    const tempMetaFile = `./temp_soumatome_n4_meta.sql`;
    fs.writeFileSync(tempMetaFile, metadataSqlStatements.join('\n'));
    try {
        execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempMetaFile}`);
        console.log("✅ Đăng ký Đề cương chương trình học Soumatome N4 lên D1 thành công!");
    } catch (err) {
        console.error("❌ Đăng ký Đề cương thất bại:", err.message);
        process.exit(1);
    } finally {
        if (fs.existsSync(tempMetaFile)) fs.unlinkSync(tempMetaFile);
    }

    // =========================================================================
    // GIAI ĐOẠN 3: GÁN NHÃN ĐỒNG THỜI (DOUBLE-TAGGING) CHO TỪ VỰNG D1
    // =========================================================================
    console.log(`\n📊 Bắt đầu gán nhãn tags mới cho từ vựng thuộc Soumatome N4...`);
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

        const tempSqlFile = `./temp_soumatome_n4_words.sql`;
        fs.writeFileSync(tempSqlFile, sqlStatements.join('\n'));

        console.log(`⏳ Đang gán tag Soumatome N4 cho mẻ từ ${i + 1} đến ${Math.min(i + BATCH_SIZE, wordsToTagPayload.length)}...`);

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
    console.log(`✅ Đã thiết lập xong sơ đồ phân cấp và gán nhãn tags chuẩn hóa cho ${successCount} từ vựng Soumatome N4 trong D1.`);
}

run().catch(err => console.error(err));
