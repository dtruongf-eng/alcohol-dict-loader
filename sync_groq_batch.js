// sync_groq_batch.js
import fs from 'fs';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const workerArg = args.find(a => a.startsWith('--worker='));
const workerId = workerArg ? parseInt(workerArg.split('=')[1]) : 0;

// 🔑 DANH SÁCH 10 API KEYS
const GROQ_KEYS_POOL = [
    "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", // Cấp cho luồng --worker=0
    "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", // Cấp cho luồng --worker=1
];

const GROQ_API_KEY = GROQ_KEYS_POOL[workerId];

if (!GROQ_API_KEY || GROQ_API_KEY.includes("_ở_đây")) {
    console.error(`❌ [Worker ${workerId}] Lỗi: Chưa cấu hình API Key tương ứng!`);
    process.exit(1);
}

const DB_NAME = "alcohol-dictionary"; 
const BATCH_SIZE = 50;                
const GROUP_SIZE = 5;                 
const TARGET_EXAMPLES = 2;            

const TODO_FILE = `./todo_worker_${workerId}.json`;

if (!fs.existsSync(TODO_FILE)) {
    console.error(`❌ [Worker ${workerId}] Lỗi: Không tìm thấy file nhiệm vụ ${TODO_FILE}. Hãy chạy "node split_tasks.js" trước!`);
    process.exit(1);
}

let todoIds = [];
try {
    todoIds = JSON.parse(fs.readFileSync(TODO_FILE, 'utf8'));
} catch (e) {
    console.error(`❌ [Worker ${workerId}] Lỗi đọc tệp nhiệm vụ:`, e.message);
    process.exit(1);
}

async function generateBatchWithGroq(wordsArray) {
    const wordsPayload = wordsArray.map(w => ({
        id: w.id,
        word: w.word,
        meaning: w.meaning || "Chưa rõ nghĩa"
    }));

    const aiPrompt = `Bạn là giáo viên tiếng Nhật. Dưới đây là danh sách các từ vựng cần đặt câu ví dụ:
    ${JSON.stringify(wordsPayload)}

    Yêu cầu:
    Với mỗi từ vựng, hãy đặt đúng 2 câu ví dụ tiếng Nhật ngắn gọn, tự nhiên và dịch nghĩa sang tiếng Việt.
    BẮT BUỘC chỉ trả về duy nhất một đối tượng JSON (không bọc trong markdown, không giải thích thêm).
    Trong đó, khóa (key) là "id" của từ vựng, và giá trị (value) là mảng chứa 2 câu ví dụ.
    Định dạng mẫu bắt buộc bằng cấu trúc JSON:
    {
      "1": [
        {"jp": "Câu ví dụ tiếng Nhật 1", "vn": "Dịch nghĩa câu 1"},
        {"jp": "Câu ví dụ tiếng Nhật 2", "vn": "Dịch nghĩa câu 2"}
      ]
    }`;

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "qwen/qwen3-32b", 
                messages: [{ role: "user", content: aiPrompt }],
                temperature: 0.2,
                response_format: { type: "json_object" }
            })
        });

        if (response.status === 429) {
            const errJson = await response.json().catch(() => ({}));
            const errMsg = errJson.error?.message || "";
            const match = errMsg.match(/try again in ([\d\.]+)s/i);
            const waitSeconds = match ? parseFloat(match[1]) + 2 : 25;
            
            console.log(`\n   ⚠ [Worker ${workerId}] Chạm giới hạn TPM. Tạm nghỉ ${waitSeconds} giây...`);
            await new Promise(r => setTimeout(r, waitSeconds * 1000));
            return generateBatchWithGroq(wordsArray);
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        let responseText = data.choices?.[0]?.message?.content?.trim() || "";
        responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        const jsonStart = responseText.indexOf('{');
        const jsonEnd = responseText.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1) return null;
        return JSON.parse(responseText.substring(jsonStart, jsonEnd + 1));
    } catch (e) {
        console.log(`   ✗ [Worker ${workerId}] Sự cố kết nối API: ${e.message}`);
        return null;
    }
}

async function run() {
    let totalUpdated = 0;
    console.log(`=== BẮT ĐẦU WORKER ${workerId} ===`);
    console.log(`📊 Số lượng từ cần xử lý: ${todoIds.length}`);

    while (todoIds.length > 0) {
        // Lấy ra mẻ ID hiện tại
        const currentBatchIds = todoIds.slice(0, BATCH_SIZE);
        console.log(`\n[Worker ${workerId}] Lấy dữ liệu cho mẻ gồm ${currentBatchIds.length} từ...`);

        // Sử dụng câu lệnh WHERE id IN (...) cực nhanh và tối ưu chi phí D1
        const idListStr = currentBatchIds.join(',');
        const cmdQuery = `npx wrangler d1 execute ${DB_NAME} --remote --command="SELECT id, word, meaning, examples FROM dictionary WHERE id IN (${idListStr})" --json`;
        
        let output;
        try {
            output = execSync(cmdQuery).toString();
        } catch (err) {
            console.error(`❌ [Worker ${workerId}] Lỗi truy vấn D1:`, err.message);
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        let cleanJson = output.trim();
        const startIdx = cleanJson.indexOf('[');
        const endIdx = cleanJson.lastIndexOf(']');
        if (startIdx === -1 || endIdx === -1) break;
        cleanJson = cleanJson.substring(startIdx, endIdx + 1);

        const parsedData = JSON.parse(cleanJson);
        const words = parsedData[0]?.results || [];

        const missingExamplesWords = [];
        for (const item of words) {
            const word = item.word ? item.word.trim() : "";
            if (!word || /^[ぁ-ん]{1,2}$/.test(word)) continue;

            let existingExamples = [];
            if (item.examples) {
                if (Array.isArray(item.examples)) existingExamples = item.examples;
                else if (typeof item.examples === 'string') {
                    try { existingExamples = JSON.parse(item.examples); } catch (e) {}
                }
            }

            if (existingExamples.length < TARGET_EXAMPLES) {
                missingExamplesWords.push({ id: item.id, word, meaning: item.meaning, existingExamples });
            }
        }

        if (missingExamplesWords.length > 0) {
            console.log(`⏳ [Worker ${workerId}] Phát hiện ${missingExamplesWords.length} từ khuyết ví dụ.`);
            const sqlUpdates = [];

            for (let i = 0; i < missingExamplesWords.length; i += GROUP_SIZE) {
                const group = missingExamplesWords.slice(i, i + GROUP_SIZE);
                const groupWordsList = group.map(g => g.word).join(', ');
                console.log(`👉 [Worker ${workerId}] Đang xử lý nhóm: [ ${groupWordsList} ]...`);
                
                const batchResult = await generateBatchWithGroq(group);

                if (batchResult && typeof batchResult === 'object') {
                    let successInGroup = 0;
                    group.forEach(item => {
                        const aiExs = batchResult[item.id] || batchResult[item.id.toString()];
                        if (Array.isArray(aiExs) && aiExs.length > 0) {
                            const mergedExamples = [...item.existingExamples, ...aiExs].slice(0, TARGET_EXAMPLES);
                            const escapedJsonStr = JSON.stringify(mergedExamples).replace(/'/g, "''");
                            sqlUpdates.push(`UPDATE dictionary SET examples = '${escapedJsonStr}' WHERE id = ${item.id};`);
                            successInGroup++;
                        }
                    });
                    console.log(`   ✓ [Worker ${workerId}] Đã hoàn thành ${successInGroup}/${group.length} từ.`);
                }
                await new Promise(r => setTimeout(r, 1800));
            }

            const tempFileName = `./temp_groq_${workerId}.sql`;
            if (sqlUpdates.length > 0) {
                fs.writeFileSync(tempFileName, sqlUpdates.join('\n'));
                try {
                    execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempFileName}`);
                    totalUpdated += sqlUpdates.length;
                    console.log(`📦 [Worker ${workerId}] Đã đồng bộ thành công thêm ${sqlUpdates.length} từ.`);
                } catch (err) {
                    console.error(`❌ [Worker ${workerId}] Ghi mẻ SQL thất bại:`, err.message);
                } finally {
                    if (fs.existsSync(tempFileName)) fs.unlinkSync(tempFileName);
                }
            }
        }

        // Cập nhật tiến độ: Loại bỏ các ID đã xử lý ra khỏi mảng cục bộ và lưu lại file
        todoIds = todoIds.filter(id => !currentBatchIds.includes(id));
        fs.writeFileSync(TODO_FILE, JSON.stringify(todoIds, null, 2));

        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\n=== WORKER ${workerId} HOÀN TẤT ===`);
    console.log(`Tổng số từ bổ sung thành công: ${totalUpdated}`);
}

run().catch(err => console.error(err));