// sync_groq_batch.js
import fs from 'fs';
import { execSync } from 'child_process';

// ====================================================
// ĐỌC THAM SỐ ĐẦU VÀO TỪ TERMINAL ĐỂ ĐIỀU PHỐI TIẾN TRÌNH
// ====================================================
const args = process.argv.slice(2);
const workerArg = args.find(a => a.startsWith('--worker='));
const workerId = workerArg ? parseInt(workerArg.split('=')[1]) : 0; // Số hiệu tiến trình (0 đến 6)

// 🔑 DANH SÁCH CÁC API KEYS CỦA BẠN TRÊN CODESPACES
const GROQ_KEYS_POOL = [
    "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", // Worker 0
    "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", // Worker 1
    "cerebras:csk-wnrp46hpvftpk96re59tr49krhnxmh49k3yvd9chte4423cx", // Worker 2
    "cerebras:csk-2vxkv68rrmn56vrwtjxd68wk2y2pc25xv9ppvnmchfnvc8mr", // Worker 3
    "mistral:LLRqw6qYbuza5IMeC6dnkuWOCuvWzPpA",   // Worker 4
    "mistral:1QWbddMULh6YiC7S4cEGPx0TiLFGItmc",   // Worker 5
    
    // 🟢 LUỒNG 6 (Dành cho GitHub Actions): Chứa chuỗi gộp 6 Keys AI phụ của bạn ngăn cách bởi dấu phẩy
    "gsk_KeyGroqPhụ1,gsk_KeyGroqPhụ2,cerebras:KeyCerebrasPhụ1,cerebras:KeyCerebrasPhụ2,mistral:KeyMistralPhụ1,mistral:KeyMistralPhụ2"
];

// Tự động bốc đúng Key dựa trên số hiệu workerId
const GROQ_API_KEY = process.env.GROQ_API_KEY || GROQ_KEYS_POOL[workerId];

if (!GROQ_API_KEY || GROQ_API_KEY.includes("Mã_Key_")) {
    console.error(`❌ [Worker ${workerId}] Lỗi: Bạn chưa cấu hình hoặc điền thiếu API Key số [${workerId}]!`);
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

// HÀM XỬ LÝ HYBRID CHỐNG NGHẼN (Hỗ trợ định tuyến 3 luồng: Groq, Mistral, Cerebras trên Codespaces)
async function generateBatchWithGroq(wordsArray, apiKey) {
  const wordsPayload = wordsArray.map((w) => ({ id: w.id, word: w.word, meaning: w.meaning || "Chưa rõ nghĩa" }));
  const aiPrompt = `Bạn là giáo viên tiếng Nhật. Dưới đây là danh sách các từ vựng cần đặt câu ví dụ:
    ${JSON.stringify(wordsPayload)}
    Yêu cầu: Với mỗi từ vựng, hãy đặt đúng 2 câu ví dụ tiếng Nhật ngắn gọn, tự nhiên và dịch nghĩa sang tiếng Việt.
    BẮT BUỘC chỉ trả về duy nhất một đối tượng JSON. Định dạng mẫu bắt buộc:
    {
      "id_cua_tu_vung": [
        {"jp": "Câu ví dụ 1", "vn": "Dịch nghĩa câu 1"},
        {"jp": "Câu ví dụ 2", "vn": "Dịch nghĩa câu 2"}
      ]
    }`;

  // Cấu hình mặc định cho Groq
  let apiUrl = "https://api.groq.com/openai/v1/chat/completions";
  let modelId = "qwen/qwen3-32b";
  let finalApiKey = apiKey;
  let requestBody = {
    model: modelId,
    messages: [{ role: "user", content: aiPrompt }],
    temperature: 0.2,
    response_format: { type: "json_object" }
  };

  // 1. NẾU LÀ KEY MISTRAL AI (mistral:) -> ĐỊNH TUYẾN SANG MÁY CHỦ MISTRAL (mistral-small-latest)
  if (apiKey.startsWith("mistral:")) {
    apiUrl = "https://api.mistral.ai/v1/chat/completions";
    modelId = "mistral-small-latest";
    finalApiKey = apiKey.replace("mistral:", "");
    requestBody = {
      model: modelId,
      messages: [{ role: "user", content: aiPrompt }],
      temperature: 0.2,
      response_format: { type: "json_object" }
    };
  } 
  // 2. NẾU LÀ KEY CỦA CEREBRAS (cerebras:) -> ĐỊNH TUYẾN SANG CEREBRAS (zai-glm-4.7)
  else if (apiKey.startsWith("cerebras:")) {
    apiUrl = "https://api.cerebras.ai/v1/chat/completions";
    modelId = "zai-glm-4.7"; 
    finalApiKey = apiKey.replace("cerebras:", "");
    requestBody = {
      model: modelId,
      messages: [{ role: "user", content: aiPrompt }],
      temperature: 0.2,
      response_format: { type: "json_object" }
    };
  }
  // 3. NẾU LÀ KEY CỦA GROQ (gsk_) -> ĐỊNH TUYẾN SANG MÁY CHỦ GROQ NHƯ CŨ
  else if (apiKey.startsWith("gsk_")) {
    apiUrl = "https://api.groq.com/openai/v1/chat/completions";
    modelId = "qwen/qwen3-32b";
    requestBody = {
      model: modelId,
      messages: [{ role: "user", content: aiPrompt }],
      temperature: 0.2,
      response_format: { type: "json_object" }
    };
  }

  // KỸ THUẬT CHỐNG NGHẼN: TIMEOUT ABORT CONTROLLER 15 GIÂY AN TOÀN CHO HỆ THỐNG
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); 

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

    // TỰ ĐỘNG BẮT LỖI 429 RATE LIMIT VÀ ĐỢI RECURSIVE RETRY
    if (response.status === 429) {
      const errJson = await response.json().catch(() => ({}));
      const errMsg = errJson.error?.message || "";
      
      let waitSeconds = 25; 
      
      const retryHeader = response.headers.get("retry-after");
      if (retryHeader) {
        waitSeconds = parseInt(retryHeader, 10) + 2;
      } else {
        const minSecMatch = errMsg.match(/try again in (\d+)m([\d\.]+)s/i);
        if (minSecMatch) {
          const minutes = parseInt(minSecMatch[1], 10);
          const seconds = parseFloat(minSecMatch[2]);
          waitSeconds = minutes * 60 + seconds + 2; 
        } else {
          const secMatch = errMsg.match(/try again in ([\d\.]+)s/i);
          if (secMatch) {
            waitSeconds = parseFloat(secMatch[1]) + 2;
          }
        }
      }

      console.log(`\n   ⚠ [Worker ${workerId}] Chạm giới hạn Rate Limit của mô hình ${modelId}.`);
      console.log(`   ⏳ Tự động tạm dừng trong ${Math.round(waitSeconds)} giây để phục hồi tài nguyên...`);
      
      await new Promise(r => setTimeout(r, waitSeconds * 1000));
      
      console.log(`   🔄 Đang tự động gọi đệ quy thử lại mẻ từ vựng này...`);
      return generateBatchWithGroq(wordsArray, apiKey); 
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
    if (jsonStart === -1 || jsonEnd === -1) {
      console.error(`❌ [Format Error] Model ${modelId} sinh câu sai định dạng JSON. Phản hồi gốc:`, responseText);
      return null;
    }
    return JSON.parse(responseText.substring(jsonStart, jsonEnd + 1));
  } catch (e) {
    clearTimeout(timeoutId); 
    if (e.name === "AbortError") {
      console.error(`❌ [Timeout Error] Model ${modelId} phản hồi quá lâu (trên 15s). Đã chủ động ngắt để bảo vệ luồng chính.`);
    } else {
      console.error(`❌ [Network Error] Kết nối tới ${modelId} thất bại:`, e.message);
    }
    return null;
  }
}

async function run() {
    let totalUpdated = 0;
    console.log(`=== BẮT ĐẦU WORKER ${workerId} ===`);
    console.log(`📊 Số lượng từ cần xử lý: ${todoIds.length}`);

    while (todoIds.length > 0) {
        const currentBatchIds = todoIds.slice(0, BATCH_SIZE);
        console.log(`\n[Worker ${workerId}] Lấy dữ liệu cho mẻ gồm ${currentBatchIds.length} từ...`);

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

            // 🟢 ĐOẠN KHAI THÁC SONG SONG TỰ ĐỘNG CHỐNG NGHẼN CHO LUỒNG SỐ 6 (GITHUB ACTIONS)
            const subKeys = GROQ_API_KEY.split(",").map(k => k.trim()).filter(Boolean);

            if (subKeys.length > 1) {
                // 👉 CHẾ ĐỘ CHẠY SONG SONG BẤT ĐỒNG BỘ CHO WORKER 6
                const totalParallelWords = subKeys.length * GROUP_SIZE; // 6 keys x 5 từ = 30 từ mỗi mẻ

                for (let i = 0; i < missingExamplesWords.length; i += totalParallelWords) {
                    const batchWords = missingExamplesWords.slice(i, i + totalParallelWords);
                    
                    // Chia nhỏ mẻ 30 từ thành 6 nhóm nhỏ (mỗi nhóm 5 từ)
                    const subgroups = [];
                    for (let j = 0; j < batchWords.length; j += GROUP_SIZE) {
                        subgroups.push(batchWords.slice(j, j + GROUP_SIZE));
                    }

                    console.log(`👉 [Worker ${workerId}] Đang xử lý SONG SONG ${subgroups.length} nhóm bằng ${subKeys.length} API Keys...`);

                    const promises = subgroups.map((subgroup, keyIndex) => {
                        const apiKey = subKeys[keyIndex % subKeys.length];
                        return generateBatchWithGroq(subgroup, apiKey);
                    });

                    const results = await Promise.all(promises);

                    results.forEach((batchResult, subgroupIndex) => {
                        if (batchResult && typeof batchResult === 'object') {
                            const subgroup = subgroups[subgroupIndex];
                            let successInGroup = 0;
                            const successWords = [];
                            subgroup.forEach(item => {
                                const aiExs = batchResult[item.id] || batchResult[item.id.toString()];
                                if (Array.isArray(aiExs) && aiExs.length > 0) {
                                    const mergedExamples = [...item.existingExamples, ...aiExs].slice(0, TARGET_EXAMPLES);
                                    const escapedJsonStr = JSON.stringify(mergedExamples).replace(/'/g, "''");
                                    sqlUpdates.push(`UPDATE dictionary SET examples = '${escapedJsonStr}' WHERE id = ${item.id};`);
                                    successInGroup++;
                                    successWords.push(item.word);
                                }
                            });
                            console.log(`   ✓ [Worker ${workerId} - Luồng ${subgroupIndex}] Đã hoàn thành ${successInGroup}/${subgroup.length} từ.`);
                        }
                    });

                    await new Promise(r => setTimeout(r, 1800)); // Giãn cách thông lượng chống nghẽn
                }
            } else {
                // 👉 CHẾ ĐỘ CHẠY TUẦN TỰ TIÊU CHUẨN (CHO CÁC WORKER 0 ĐẾN 5 TRÊN CODESPACES)
                for (let i = 0; i < missingExamplesWords.length; i += GROUP_SIZE) {
                    const group = missingExamplesWords.slice(i, i + GROUP_SIZE);
                    const groupWordsList = group.map(g => g.word).join(', ');
                    console.log(`👉 [Worker ${workerId}] Đang xử lý nhóm tuần tự: [ ${groupWordsList} ]...`);
                    
                    const batchResult = await generateBatchWithGroq(group, GROQ_API_KEY);

                    if (batchResult && typeof batchResult === 'object') {
                        let successInGroup = 0;
                        const successWords = [];
                        group.forEach(item => {
                            const aiExs = batchResult[item.id] || batchResult[item.id.toString()];
                            if (Array.isArray(aiExs) && aiExs.length > 0) {
                                const mergedExamples = [...item.existingExamples, ...aiExs].slice(0, TARGET_EXAMPLES);
                                const escapedJsonStr = JSON.stringify(mergedExamples).replace(/'/g, "''");
                                sqlUpdates.push(`UPDATE dictionary SET examples = '${escapedJsonStr}' WHERE id = ${item.id};`);
                                successInGroup++;
                                successWords.push(item.word);
                            }
                        });
                        console.log(`   ✓ [Worker ${workerId}] Đã hoàn thành ${successInGroup}/${group.length} từ.`);
                    }
                    await new Promise(r => setTimeout(r, 1800));
                }
            }

            // Ghi hàng loạt SQL vào D1
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

        todoIds = todoIds.length > 0 ? todoIds.filter(id => !currentBatchIds.includes(id)) : [];
        fs.writeFileSync(TODO_FILE, JSON.stringify(todoIds, null, 2));

        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\n=== WORKER ${workerId} HOÀN TẤT ===`);
    console.log(`Tổng số từ bổ sung thành công: ${totalUpdated}`);
}

run().catch(err => console.error(err));