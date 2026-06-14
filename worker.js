var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
var segmenter = new Intl.Segmenter("ja", { granularity: "word" });
function tokenize(text) {
  if (!text) return "";
  return [...segmenter.segment(text)].filter((s) => s.isWordLike).map((s) => s.segment).join(" ");
}
__name(tokenize, "tokenize");
__name2(tokenize, "tokenize");
var worker_default = {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/dict-search") {
        const query = url.searchParams.get("query");
        if (!query) {
          return new Response(JSON.stringify({ error: "Missing query" }), { status: 400, headers: corsHeaders });
        }
        const tokenizedQuery = tokenize(query);
        const { results } = await env.DB.prepare(`
                    SELECT d.* FROM dictionary d
                    JOIN fts_index f ON d.id = f.rowid
                    WHERE fts_index MATCH ?
                    ORDER BY d.popularity DESC, length(d.word) ASC
                    LIMIT 15
                `).bind(tokenizedQuery).all();
        return new Response(JSON.stringify(results), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      if (path === "/api/kanji-detail") {
        const kanji = url.searchParams.get("kanji");
        if (!kanji) {
          return new Response(JSON.stringify({ error: "Missing kanji" }), { status: 400, headers: corsHeaders });
        }
        const kanjiQuery = env.DB.prepare("SELECT * FROM kanji_dictionary WHERE kanji = ?").bind(kanji);
        const compoundsQuery = env.DB.prepare(`
                    SELECT * FROM dictionary 
                    WHERE word LIKE ?
                      AND word NOT GLOB '*[a-zA-Z0-9]*'
                      AND length(word) >= 2 AND length(word) <= 4
                      AND trim(reading, ' \u3000' || char(9) || char(10) || char(13)) != ''
                      AND reading IS NOT NULL
                      AND hv != '' AND hv IS NOT NULL
                    ORDER BY 
                      (level != '' AND level IS NOT NULL) DESC,
                      level DESC,
                      popularity DESC,
                      length(word) ASC
                    LIMIT 30
                `).bind(`%${kanji}%`);
        const [kanjiResult, compoundsResult] = await env.DB.batch([kanjiQuery, compoundsQuery]);
        let finalCompounds = compoundsResult.results || [];
        const isJlpt = /* @__PURE__ */ __name2((lvl) => ["N1", "N2", "N3", "N4", "N5"].includes(lvl), "isJlpt");
        const jlptCount = finalCompounds.filter((r) => isJlpt(r.level)).length;
        if (jlptCount > 20) {
          finalCompounds = finalCompounds.slice(0, 30);
        } else {
          finalCompounds = finalCompounds.slice(0, 20);
        }
        return new Response(JSON.stringify({
          kanjiInfo: kanjiResult.results[0] || null,
          compounds: finalCompounds
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      if (path === "/api/update-examples" && request.method === "POST") {
        const { word, examples } = await request.json();
        if (!word || !examples || !Array.isArray(examples)) {
          return new Response(JSON.stringify({ error: "Invalid payload" }), { status: 400, headers: corsHeaders });
        }
        const cappedExamples = examples.slice(0, 15);
        await env.DB.prepare("UPDATE dictionary SET examples = ? WHERE word = ?").bind(JSON.stringify(cappedExamples), word).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
      if (path === "/api/generate-examples") {
        const word = url.searchParams.get("word");
        const meaning = url.searchParams.get("meaning");
        const id = url.searchParams.get("id");
        if (!word || !id) {
          return new Response(JSON.stringify({ error: "Missing parameters" }), { status: 400, headers: corsHeaders });
        }
        try {
          const cleanWord = word.trim();
          const aiPrompt = `Bạn là giáo viên tiếng Nhật luyện thi JLPT. Hãy tạo đúng 2 câu ví dụ ngắn gọn, tự nhiên chứa từ vựng sau: "${cleanWord}" (Ý nghĩa: ${meaning || "Chưa rõ nghĩa"}).
                    BẮT BUỘC chỉ trả về duy nhất một mảng JSON (không bọc trong markdown, không giải thích thêm). Định dạng mảng chuẩn:
                    [
                      {"jp": "Câu ví dụ tiếng Nhật 1", "vn": "Dịch nghĩa câu 1 sang tiếng Việt"},
                      {"jp": "Câu ví dụ tiếng Nhật 2", "vn": "Dịch nghĩa câu 2 sang tiếng Việt"}
                    ]`;
          const aiResult = await env.AI.run("@cf/qwen/qwen3-30b-a3b-fp8", {
            messages: [
              { role: "user", content: aiPrompt }
            ]
          });
          let responseText = "";
          if (aiResult && aiResult.response) {
            responseText = aiResult.response;
          } else if (aiResult && aiResult.choices && aiResult.choices[0] && aiResult.choices[0].message) {
            responseText = aiResult.choices[0].message.content;
          } else {
            throw new Error(`Cloudflare AI không phản hồi cấu trúc hợp lệ. Trả về: ${JSON.stringify(aiResult)}`);
          }
          responseText = responseText.trim();
          const jsonStart = responseText.indexOf("[");
          const jsonEnd = responseText.lastIndexOf("]");
          if (jsonStart !== -1 && jsonEnd !== -1) {
            responseText = responseText.substring(jsonStart, jsonEnd + 1);
          }
          const generatedExs = JSON.parse(responseText);
          if (Array.isArray(generatedExs) && generatedExs.length > 0) {
            await env.DB.prepare("UPDATE dictionary SET examples = ? WHERE id = ?").bind(JSON.stringify(generatedExs), id).run();
            return new Response(JSON.stringify(generatedExs), {
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          }
          throw new Error("AI trả về sai cấu trúc mảng ví dụ.");
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
        }
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  },
  // =========================================================================
  // 🟢 TIẾN TRÌNH TỰ ĐỘNG HÓA SONG SONG HYBRID THEO CHU KỲ (CRON JOB)
  // =========================================================================
  async scheduled(event, env, ctx) {
    ctx.waitUntil(doParallelAutoSync(env));
  }
};
async function doParallelAutoSync(env) {
  const keys = (env.GROQ_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    console.error("Chưa cấu hình danh sách GROQ_API_KEYS trong Secret!");
    return;
  }
  const GROUP_SIZE = 5;
  const totalWordsToFetch = keys.length * GROUP_SIZE;
  const query = `SELECT id, word, meaning FROM dictionary WHERE (examples IS NULL OR examples = '[]' OR examples = '') AND id % 2 = 1 LIMIT ?`;
  let result;
  try {
    result = await env.DB.prepare(query).bind(totalWordsToFetch).all();
  } catch (err) {
    console.error("Lỗi đọc D1:", err.message);
    return;
  }
  const words = result.results || [];
  if (words.length === 0) {
    console.log("🎉 Tuyệt vời! Không còn từ vựng ID lẻ nào khuyết ví dụ.");
    return;
  }
  const wordGroups = [];
  for (let i = 0; i < words.length; i += GROUP_SIZE) {
    wordGroups.push(words.slice(i, i + GROUP_SIZE));
  }
  console.log(`🤖 Bắt đầu xử lý song song ${wordGroups.length} nhóm bằng ${keys.length} API Keys (Tự nhận diện các nền tảng)...`);
  const promises = wordGroups.map((group, index) => {
    const apiKey = keys[index % keys.length];
    return generateBatchWithGroq(group, apiKey, env);
  });
  const results = await Promise.all(promises);
  const statements = [];
  results.forEach((batchResult, groupIndex) => {
    if (!batchResult || typeof batchResult !== "object") return;
    const group = wordGroups[groupIndex];
    group.forEach((item) => {
      const aiExs = batchResult[item.id] || batchResult[item.id.toString()];
      if (Array.isArray(aiExs) && aiExs.length > 0) {
        const escapedJsonStr = JSON.stringify(aiExs.slice(0, 2));
        statements.push(
          env.DB.prepare(`UPDATE dictionary SET examples = ? WHERE id = ?`).bind(escapedJsonStr, item.id)
        );
      }
    });
  });
  if (statements.length > 0) {
    try {
      await env.DB.batch(statements);
      console.log(`📦 [D1 Batch] Đã tự động cập nhật hàng loạt thành công thêm ${statements.length} từ.`);
    } catch (dbErr) {
      console.error("Lỗi ghi hàng loạt lên D1:", dbErr.message);
    }
  }
}
__name(doParallelAutoSync, "doParallelAutoSync");
__name2(doParallelAutoSync, "doParallelAutoSync");

// HÀM XỬ LÝ HYBRID CHỐNG NGHẼN (Hỗ trợ định tuyến 4 luồng song song, loại bỏ hoàn toàn mớ bòng bong Gemini)
async function generateBatchWithGroq(wordsArray, apiKey, env) {
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

  // 🟢 1. NẾU LÀ KEY ẢO "cf_ai" -> GỌI NATIVE WORKERS AI (GPU NỘI BỘ CLOUDFLARE)
  if (apiKey === "cf_ai") {
    try {
      const aiResult = await env.AI.run("@cf/qwen/qwen3-30b-a3b-fp8", {
        messages: [
          { role: "user", content: aiPrompt }
        ]
      });
      if (aiResult && aiResult.response && typeof aiResult.response === "object") {
        return aiResult.response;
      }
      let responseText = "";
      if (aiResult && typeof aiResult.response === "string") {
        responseText = aiResult.response;
      } else if (aiResult && aiResult.choices && aiResult.choices[0] && aiResult.choices[0].message) {
        responseText = String(aiResult.choices[0].message.content);
      } else if (typeof aiResult === "string") {
        responseText = aiResult;
      } else if (aiResult && aiResult.response) {
        responseText = String(aiResult.response);
      } else {
        return aiResult;
      }
      responseText = responseText.trim();
      const jsonStart = responseText.indexOf("{");
      const jsonEnd = responseText.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) {
        console.error("❌ [Format Error] Cloudflare Workers AI sinh câu sai định dạng JSON. Phản hồi gốc:", responseText);
        return null;
      }
      return JSON.parse(responseText.substring(jsonStart, jsonEnd + 1));
    } catch (e) {
      console.error("❌ [Workers AI Lỗi] Gặp sự cố kết nối GPU nội bộ:", e.message);
      return null;
    }
  }

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

  // 🟢 2. NẾU LÀ KEY MISTRAL AI (mistral:) -> ĐỊNH TUYẾN SANG MÁY CHỦ MISTRAL
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
  // 🟢 3. NẾU LÀ KEY CỦA CEREBRAS (cerebras:) -> ĐỊNH TUYẾN SANG MÁY CHỦ CEREBRAS
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
  // 🟢 4. NẾU LÀ KEY CỦA GROQ (gsk_) -> ĐỊNH TUYẾN SANG MÁY CHỦ GROQ NHƯ CŨ
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 giây an toàn cho hệ thống
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
__name(generateBatchWithGroq, "generateBatchWithGroq");
__name2(generateBatchWithGroq, "generateBatchWithGroq");

export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map