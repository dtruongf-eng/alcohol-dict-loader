// sync_tag_batch.js
import fs from 'fs';
import { execSync } from 'child_process';

// Đọc số hiệu tiến trình từ Terminal (Ví dụ: --worker=0)
const args = process.argv.slice(2);
const workerArg = args.find(a => a.startsWith('--worker='));
const workerId = workerArg ? parseInt(workerArg.split('=')[1]) : 0;

// Giải nén pool API Keys của luồng này từ Secrets bảo mật
const GROQ_KEYS_POOL = (process.env.GROQ_API_KEY || "").split("|").map(k => k.trim()).filter(Boolean);
const workerPoolString = GROQ_KEYS_POOL[workerId] || "";
const subKeys = workerPoolString.split(",").map(k => k.trim()).filter(Boolean);

if (subKeys.length === 0) {
    console.error(`❌ [Worker ${workerId}] Lỗi: Chưa cấu hình các Keys song song cho luồng này!`);
    process.exit(1);
}

const DB_NAME = "alcohol-dictionary"; 
const BATCH_SIZE = 50;                // 50 từ mỗi mẻ
const GROUP_SIZE = 5;                 // Nhóm 5 từ để gửi AI xử lý nhanh
const TODO_FILE = `./todo_tag_worker_${workerId}.json`;

if (!fs.existsSync(TODO_FILE)) {
    console.error(`❌ [Worker ${workerId}] Lỗi: Không tìm thấy file nhiệm vụ ${TODO_FILE}. Hãy chạy "node split_tag_tasks.js" trước!`);
    process.exit(1);
}

let todoIds = [];
try {
    todoIds = JSON.parse(fs.readFileSync(TODO_FILE, 'utf8'));
} catch (e) {
    console.error(`❌ [Worker ${workerId}] Lỗi đọc tệp nhiệm vụ:`, e.message);
    process.exit(1);
}

// Hàm lấy mảng Metadata danh mục các Tag hợp lệ từ D1 làm khung chuẩn cho AI
async function fetchThematicMetadata() {
    console.log(`[Worker ${workerId}] Đang kéo danh mục Metadata nhãn hợp lệ từ D1...`);
    const cmd = `npx wrangler d1 execute ${DB_NAME} --remote --command="SELECT tag_id, display_name, category, search_keywords FROM thematic_metadata" --json`;
    try {
        const output = execSync(cmd).toString();
        let cleanJson = output.trim();
        const startIdx = cleanJson.indexOf('[');
        const endIdx = cleanJson.lastIndexOf(']');
        if (startIdx === -1 || endIdx === -1) return [];
        cleanJson = cleanJson.substring(startIdx, endIdx + 1);
        const parsed = JSON.parse(cleanJson);
        return parsed[0]?.results || [];
    } catch (e) {
        console.error("❌ Không thể tải Metadata nhãn từ D1:", e.message);
        return [];
    }
}

// Hàm gọi AI phân loại không giới hạn số lượng nhãn hợp lệ
async function tagBatchWithAI(wordsArray, metadataCatalog, apiKey) {
    const wordsPayload = wordsArray.map(w => ({ id: w.id, word: w.word, reading: w.reading || "", meaning: w.meaning || "" }));
    
    const aiPrompt = `Bạn là chuyên gia ngôn ngữ tiếng Nhật và là trợ lý phân loại dữ liệu học tập JLPT.
    Dưới đây là danh mục các nhãn (tags) hợp lệ duy nhất của hệ thống:
    ${JSON.stringify(metadataCatalog.map(m => ({ tag_id: m.tag_id, display_name: m.display_name, category: m.category, keywords: m.search_keywords })))}
    
    Hãy gán tất cả các nhãn (tags) phù hợp nhất cho danh sách các từ vựng tiếng Nhật sau đây:
    ${JSON.stringify(wordsPayload)}
    
    QUY TẮC PHÂN LOẠI NGHIÊM NGẶT:
    1. ĐƯỢC PHÉP GÁN NHIỀU TAG: Một từ có thể thuộc nhiều hơn một chủ đề (Ví dụ: Từ "病気" thuộc cả #health_medical và #daily_life) và có thể thuộc các giáo trình (Ví dụ: thuộc cả #curriculum_tango_n5 và #curriculum_minna_1 nếu từ vựng đó có xuất hiện trong giáo trình đó). Không giới hạn số lượng tag phù hợp cho mỗi từ.
    2. CHỈ DÙNG TAG TRONG DANH MỤC: CẤM TUYỆT ĐỐI tự bịa ra hashtag mới hoặc tự gõ sai chính tả. Chỉ lấy các chuỗi từ trường "tag_id" được cung cấp ở danh mục trên.
    3. KHÔNG GÁN BỪA: Chỉ gán tag khi từ vựng thực sự liên quan mật thiết đến ngữ nghĩa của chủ đề hoặc giáo trình đó. Không được cố gán cho đủ số lượng.
    
    BẮT BUỘC chỉ trả về duy nhất một đối tượng JSON. Định dạng mẫu bắt buộc:
    {
      "id_cua_tu_vung": ["#tag_id_1", "#tag_id_2"]
    }`;

    // Cấu hình định tuyến nhiều máy chủ (Groq, Mistral, Cerebras, Puter)
    let apiUrl = "https://api.groq.com/openai/v1/chat/completions";
    let modelId = "qwen/qwen3-32b";
    let finalApiKey = apiKey;
    let requestBody = {
        model: modelId,
        messages: [{ role: "user", content: aiPrompt }],
        temperature: 0.1,
        response_format: { type: "json_object" }
    };

    if (apiKey.startsWith("mistral:")) {
        apiUrl = "https://api.mistral.ai/v1/chat/completions";
        modelId = "mistral-small-latest";
        finalApiKey = apiKey.replace("mistral:", "");
        requestBody.model = modelId;
    } else if (apiKey.startsWith("cerebras:")) {
        apiUrl = "https://api.cerebras.ai/v1/chat/completions";
        modelId = "zai-glm-4.7";
        finalApiKey = apiKey.replace("cerebras:", "");
        requestBody.model = modelId;
    } else if (apiKey.startsWith("puter:")) {
        apiUrl = "https://api.puter.com/puterai/openai/v1/chat/completions";
        modelId = "qwen/qwen3.6-27b";
        finalApiKey = apiKey.replace("puter:", "");
        requestBody = { model: modelId, messages: [{ role: "user", content: aiPrompt }], temperature: 0.1 };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // Ngắt kết nối sau 15s để chống treo luồng

    try {
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${finalApiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 429) {
            console.error(`❌ [API Limit 429] Luồng con này tạm ngắt do chạm hạn mức.`);
            return null;
        }

        if (!response.ok) {
            const errText = await response.text();
            console.error(`❌ [API Error] Model ${modelId} lỗi ${response.status}: ${errText}`);
            return null;
        }

        const data = await response.json();
        let responseText = data.choices?.[0]?.message?.content?.trim() || "";
        responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        
        const jsonStart = responseText.indexOf("{");
        const jsonEnd = responseText.lastIndexOf("}");
        if (jsonStart === -1 || jsonEnd === -1) return null;
        
        return JSON.parse(responseText.substring(jsonStart, jsonEnd + 1));
    } catch (e) {
        clearTimeout(timeoutId);
        console.error(`❌ [Connection Error] Lỗi kết nối model ${modelId}:`, e.message);
        return null;
    }
}

async function run() {
    const metadataCatalog = await fetchThematicMetadata();
    if (metadataCatalog.length === 0) {
        console.error(`❌ [Worker ${workerId}] Không thể tiếp tục do không nạp được danh mục Metadata nhãn.`);
        process.exit(1);
    }

    let totalUpdated = 0;
    console.log(`=== BẮT ĐẦU WORKER GÁN TAG ${workerId} ===`);
    console.log(`📊 Số lượng từ JLPT cần gán nhãn: ${todoIds.length}`);

    while (todoIds.length > 0) {
        const currentBatchIds = todoIds.slice(0, BATCH_SIZE);
        const idListStr = currentBatchIds.join(',');
        
        const cmdQuery = `npx wrangler d1 execute ${DB_NAME} --remote --command="SELECT id, word, reading, meaning FROM dictionary WHERE id IN (${idListStr})" --json`;
        
        let output;
        try {
            output = execSync(cmdQuery).toString();
        } catch (err) {
            console.error(`❌ [Worker ${workerId}] Lỗi truy vấn từ vựng D1:`, err.message);
            await new Promise(r => setTimeout(r, 500));
            continue;
        }

        let cleanJson = output.trim();
        const startIdx = cleanJson.indexOf('[');
        const endIdx = cleanJson.lastIndexOf(']');
        if (startIdx === -1 || endIdx === -1) break;
        cleanJson = cleanJson.substring(startIdx, endIdx + 1);

        const parsedData = JSON.parse(cleanJson);
        const words = parsedData[0]?.results || [];

        if (words.length > 0) {
            const sqlUpdates = [];
            const totalParallelWords = subKeys.length * GROUP_SIZE; // Ví dụ: 6 keys x 5 từ = 30 từ song song

            for (let i = 0; i < words.length; i += totalParallelWords) {
                const batchWords = words.slice(i, i + totalParallelWords);
                
                const subgroups = [];
                for (let j = 0; j < batchWords.length; j += GROUP_SIZE) {
                    subgroups.push(batchWords.slice(j, j + GROUP_SIZE));
                }

                console.log(`👉 [Worker ${workerId}] Đang phân loại SONG SONG ${subgroups.length} nhóm bằng các API Keys...`);

                const promises = subgroups.map((subgroup, keyIndex) => {
                    const apiKey = subKeys[keyIndex % subKeys.length];
                    return tagBatchWithAI(subgroup, metadataCatalog, apiKey);
                });

                const results = await Promise.all(promises);

                results.forEach((batchResult, subgroupIndex) => {
                    if (batchResult && typeof batchResult === 'object') {
                        const subgroup = subgroups[subgroupIndex];
                        let successInGroup = 0;
                        const successWords = [];

                        subgroup.forEach(item => {
                            const aiTags = batchResult[item.id] || batchResult[item.id.toString()];
                            if (Array.isArray(aiTags) && aiTags.length > 0) {
                                // Gộp các tag thành chuỗi phân tách bằng dấu phẩy
                                const tagsString = aiTags.map(t => t.trim()).filter(Boolean).join(',');
                                sqlUpdates.push(`UPDATE dictionary SET tags = '${tagsString}' WHERE id = ${item.id};`);
                                successInGroup++;
                                successWords.push(`${item.word} (${aiTags.length} tags)`);
                            }
                        });
                        console.log(`   ✓ [Worker ${workerId} - Nhánh ${subgroupIndex}] Đã hoàn thành ${successInGroup}/${subgroup.length} từ [ ${successWords.join(', ')} ].`);
                    }
                });

                await new Promise(r => setTimeout(r, 1500)); // Delay tránh chạm rate limit
            }

            // Ghi hàng loạt SQL gán tag vào D1
            const tempFileName = `./temp_tag_wrk_${workerId}.sql`;
            if (sqlUpdates.length > 0) {
                fs.writeFileSync(tempFileName, sqlUpdates.join('\n'));
                try {
                    execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${tempFileName}`);
                    totalUpdated += sqlUpdates.length;
                    console.log(`📦 [Worker ${workerId}] Đã đồng bộ thành công nhãn tags cho ${sqlUpdates.length} từ.`);
                } catch (err) {
                    console.error(`❌ [Worker ${workerId}] Ghi mẻ SQL gán tags thất bại:`, err.message);
                } finally {
                    if (fs.existsSync(tempFileName)) fs.unlinkSync(tempFileName);
                }
            }
        }

        // Lọc bớt ID đã hoàn tất khỏi hàng đợi để tránh lặp
        todoIds = todoIds.length > 0 ? todoIds.filter(id => !currentBatchIds.includes(id)) : [];
        fs.writeFileSync(TODO_FILE, JSON.stringify(todoIds, null, 2));

        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\n=== WORKER GÁN TAG ${workerId} HOÀN TẤT ===`);
    console.log(`Tổng số từ gán nhãn tags thành công: ${totalUpdated}`);
}

run().catch(err => console.error(err));
