// import_any_curriculum.js
import fs from 'fs';
import { execSync } from 'child_process';

const DB_NAME = "alcohol-dictionary";
const BATCH_SIZE = 1000;

// Đọc tham số giáo trình truyền vào từ GitHub Actions (Ví dụ: --curriculum=tango_n2)
const args = process.argv.slice(2);
const curriculumArg = args.find(a => a.startsWith('--curriculum='));
const CURRICULUM_KEY = curriculumArg ? curriculumArg.split('=')[1] : null;

// =========================================================================
// BẢNG BẢN ĐỒ CẤU HÌNH CHO TỪNG GIÁO TRÌNH (DYNAMIC MAP)
// =========================================================================
const CURRICULUM_CONFIGS = {
    minna_1: {
        file: "./curriculums/minna_no_nihongo_I.json",
        parentTag: "#curriculum_minna_1",
        parentName: "Giáo trình Minna no Nihongo I (Bài 1 - 25)",
        sortOrder: 1
    },
    minna_2: {
        file: "./curriculums/minna_no_nihongo_II.json",
        parentTag: "#curriculum_minna_2",
        parentName: "Giáo trình Minna no Nihongo II (Bài 26 - 50)",
        sortOrder: 2
    },
    tango_n5: {
        file: "./curriculums/jlpt_n5_tango.json",
        parentTag: "#curriculum_tango_n5",
        parentName: "Từ vựng Tango 1000 N5",
        sortOrder: 3
    },
    tango_n4: {
        file: "./curriculums/jlpt_n4_vocabulary.json",
        parentTag: "#curriculum_tango_n4",
        parentName: "Từ vựng Tango 1500 N4",
        sortOrder: 3
    },
    tango_n2: {
        file: "./curriculums/tango_n2_vocabulary.json",
        parentTag: "#curriculum_tango_n2",
        parentName: "Từ vựng Tango 2500 N2",
        sortOrder: 3
    },
    tango_n1: {
        file: "./curriculums/n1_vocab_all.json",
        parentTag: "#curriculum_tango_n1",
        parentName: "Từ vựng Tango 3000 N1",
        sortOrder: 4
    },
    soumatome_n4: {
        file: "./curriculums/soumatome_n4_vocab.json",
        parentTag: "#curriculum_soumatome_n4",
        parentName: "Từ vựng Soumatome N4",
        sortOrder: 2
    },
    soumatome_n3: {
        file: "./curriculums/soumatome_n3_vocab.json",
        parentTag: "#curriculum_soumatome_n3",
        parentName: "Từ vựng Soumatome N3",
        sortOrder: 3
    },
    soumatome_n5: {
        file: "./curriculums/soumatomeN5_vocab.json",
        parentTag: "#curriculum_soumatome_n5",
        parentName: "Từ vựng Soumatome N5",
        sortOrder: 1
    }
};

const escapeSQL = (str) => {
    if (!str) return "";
    return str.toString().replace(/'/g, "''");
};

async function run() {
    if (!CURRICULUM_KEY || !CURRICULUM_CONFIGS[CURRICULUM_KEY]) {
        console.error(`❌ Lỗi: Tham số giáo trình --curriculum=[key] không hợp lệ hoặc thiếu!`);
        console.error(`Các key hợp lệ: ${Object.keys(CURRICULUM_CONFIGS).join(', ')}`);
        process.exit(1);
    }

    const config = CURRICULUM_CONFIGS[CURRICULUM_KEY];
    const JSON_FILE = config.file;
    const PARENT_TAG = config.parentTag;
    const PARENT_NAME = config.parentName;

    if (!fs.existsSync(JSON_FILE)) {
        console.error(`❌ Lỗi: Không tìm thấy file JSON giáo trình tại đường dẫn: ${JSON_FILE}`);
        process.exit(1);
    }

    console.log(`📖 Đang đọc tệp tin giáo trình [${CURRICULUM_KEY}]: ${JSON_FILE}...`);
    let fileContent = fs.readFileSync(JSON_FILE, 'utf8');
    
    // Tự động chữa lỗi Enter ngầm trong nháy kép của các file JSON bị lỗi format
    const sanitizedContent = fileContent.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, p1) => {
        return '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '') + '"';
    });

    const data = JSON.parse(sanitizedContent);
    const metadataSqlStatements = [];

    // Đăng ký nhãn cha
    metadataSqlStatements.push(`
        INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
        VALUES ('${PARENT_TAG}', '${escapeSQL(PARENT_NAME)}', 'Giáo trình', '${escapeSQL(PARENT_NAME.toLowerCase())}', NULL, ${config.sortOrder});
    `.trim().replace(/\s+/g, ' '));

    const wordsToTagPayload = [];

    // =========================================================================
    // 🧠 SIÊU BỘ LỌC ĐA CẤU TRÚC: Tự động nhận diện 3 kiểu định dạng file JSON của bạn
    // =========================================================================
    if (Array.isArray(data)) {
        // KIỂU 1: Mảng phẳng các phân đoạn (Soumatome N5/N4/N3, Minna I/II, Tango N1, Tango N5/N4)
        data.forEach((item, idx) => {
            const chapterNum = item.chapter;
            const sectionNum = item.section;
            const lessonNum = item.lesson;

            let childTagId = "";
            let displayName = "";
            let sortOrder = idx + 1;
            let searchKeywords = "";

            if (chapterNum !== undefined && sectionNum !== undefined) {
                // Cấu trúc kiểu Tango N5, Tango N4
                childTagId = `${PARENT_TAG}_c${chapterNum}_s${sectionNum}`;
                displayName = `Tango ${PARENT_NAME.slice(-2)} - Chương ${chapterNum} - Phần ${sectionNum}: ${item.title || ""}`;
                sortOrder = (chapterNum - 1) * 10 + sectionNum;
                searchKeywords = `${PARENT_NAME.toLowerCase()}, chuong ${chapterNum}, phan ${sectionNum}, ${item.title || ""}`;
            } else if (lessonNum !== undefined) {
                // Cấu trúc kiểu Minna I, Minna II
                childTagId = `${PARENT_TAG}_s${lessonNum}`;
                displayName = `${PARENT_NAME.includes("Minna no Nihongo I") ? "Minna I" : "Minna II"} - ${item.title || `Bài ${lessonNum}`}`;
                sortOrder = lessonNum;
                searchKeywords = `${PARENT_NAME.toLowerCase()}, bai ${lessonNum}, ${item.title || ""}`;
            } else {
                // Cấu trúc phẳng kiểu Soumatome N5/N4/N3, Tango N1
                childTagId = `${PARENT_TAG}_s${idx + 1}`;
                displayName = `${PARENT_NAME} - ${item.title || `Bài ${idx + 1}`}`;
                sortOrder = idx + 1;
                searchKeywords = `${PARENT_NAME.toLowerCase()}, ${item.title || ""}`;
            }

            metadataSqlStatements.push(`
                INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
                VALUES ('${childTagId}', '${escapeSQL(displayName)}', 'Giáo trình', '${escapeSQL(searchKeywords)}', '${PARENT_TAG}', ${sortOrder});
            `.trim().replace(/\s+/g, ' '));

            if (item.words && Array.isArray(item.words)) {
                item.words.forEach(word => {
                    const cleanWord = word ? word.trim() : ""; // GIỮ NGUYÊN 100% từ của bạn
                    if (cleanWord) {
                        wordsToTagPayload.push({ word: cleanWord, childTag: childTagId });
                    }
                });
            }
        });
    } else if (data.chapters && Array.isArray(data.chapters)) {
        // KIỂU 2: Cấu trúc lồng sâu 2 tầng (Kiểu Tango N2)
        data.chapters.forEach(chapter => {
            const chapterNum = chapter.chapter;
            const chapterTitle = chapter.title ? chapter.title.trim() : "";

            if (chapter.sections && Array.isArray(chapter.sections)) {
                chapter.sections.forEach(section => {
                    const sectionNum = section.section;
                    const sectionTitle = section.title ? section.title.trim() : "";
                    
                    const childTagId = `${PARENT_TAG}_c${chapterNum}_s${sectionNum}`;
                    const displayName = `Tango N2 - Chương ${chapterNum} - Phần ${sectionNum}: ${sectionTitle} (${chapterTitle})`;
                    const searchKeywords = `${PARENT_NAME.toLowerCase()}, chuong ${chapterNum}, bai ${sectionNum}, ${chapterTitle}, ${sectionTitle}`;
                    const sortOrder = (chapterNum - 1) * 5 + sectionNum;

                    metadataSqlStatements.push(`
                        INSERT OR REPLACE INTO thematic_metadata (tag_id, display_name, category, search_keywords, parent_id, sort_order)
                        VALUES ('${childTagId}', '${escapeSQL(displayName)}', 'Giáo trình', '${escapeSQL(searchKeywords)}', '${PARENT_TAG}', ${sortOrder});
                    `.trim().replace(/\s+/g, ' '));

                    if (section.words && Array.isArray(section.words)) {
                        section.words.forEach(word => {
                            const cleanWord = word ? word.trim() : "";
                            if (cleanWord) {
                                wordsToTagPayload.push({ word: cleanWord, childTag: childTagId });
                            }
                        });
                    }
                });
            }
        });
    }

    // 1. Đăng ký đề cương Syllabus lên D1
    console.log(`📦 Đang đẩy đề cương giáo trình [${PARENT_NAME}] gồm ${metadataSqlStatements.length - 1} phân đoạn lên Cloud D1...`);
    const tempMetaFile = `./temp_any_meta.sql`;
    fs.writeFileSync(tempMetaFile, metadataSqlStatements.join('\n'));
    try {
        execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempMetaFile}`);
        console.log("✅ Đăng ký Đề cương Syllabus lên D1 thành công!");
    } catch (err) {
        console.error("❌ Đăng ký Đề cương thất bại:", err.message);
        process.exit(1);
    } finally {
        if (fs.existsSync(tempMetaFile)) fs.unlinkSync(tempMetaFile);
    }

    // 2. Gán nhãn tags mới tích lũy cho từ vựng D1
    console.log(`\n📊 Bắt đầu gán nhãn tags mới cho từ vựng thuộc giáo trình...`);
    let successCount = 0;

    for (let i = 0; i < wordsToTagPayload.length; i += BATCH_SIZE) {
        const chunk = wordsToTagPayload.slice(i, i + BATCH_SIZE);
        const sqlStatements = [];

        chunk.forEach(item => {
            const escapedWord = escapeSQL(item.word);
            const childTag = item.childTag;

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

        const tempSqlFile = `./temp_any_words.sql`;
        fs.writeFileSync(tempSqlFile, sqlStatements.join('\n'));

        console.log(`⏳ Đang gán tags cho mẻ từ ${i + 1} đến ${Math.min(i + BATCH_SIZE, wordsToTagPayload.length)}...`);

        try {
            execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempSqlFile}`);
            successCount += chunk.length;
        } catch (err) {
            console.error(`❌ Ghi mẻ SQL từ vựng thất bại ở dòng thứ ${i + 1}:`, err.message);
        } finally {
            if (fs.existsSync(tempSqlFile)) fs.unlinkSync(tempSqlFile);
        }
    }

    console.log(`\n🎉 TIẾN TRÌNH ĐỒNG BỘ HOÀN TẤT THÀNH CÔNG!`);
    console.log(`✅ Đã thiết lập xong sơ đồ phân cấp và gán nhãn tags tích lũy cho ${successCount} từ vựng thuộc '${PARENT_NAME}' trong D1.`);
}

run().catch(err => console.error(err));
