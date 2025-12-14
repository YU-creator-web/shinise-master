import { VertexAI, GenerativeModel } from '@google-cloud/vertexai';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
// Reverting to us-central1 as global failed (returned HTML 404)
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const MODEL_ID = 'gemini-2.5-pro';

let vertexAI: VertexAI | null = null;
let model: GenerativeModel | null = null;

function getModel() {
  if (!model) {
    if (!PROJECT_ID) {
      console.warn("GOOGLE_CLOUD_PROJECT is not set. AI features will fail.");
      return null;
    }
    console.log(`🚀 Initializing Vertex AI (Strict Mode). Project: ${PROJECT_ID}, Location: ${LOCATION}, Model: ${MODEL_ID}`);
    vertexAI = new VertexAI({ project: PROJECT_ID, location: LOCATION });
    model = vertexAI.getGenerativeModel({ 
      model: MODEL_ID,
      generationConfig: {
        maxOutputTokens: 8192,
      },
      tools: [{
        // @ts-ignore
        googleSearch: {}
      }]
    });
  }
  return model;
}

function cleanJson(text: string): string {
  // 1. Try to find content within ```json ... ``` (flexible whitespace)
  let match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match && match[1]) return match[1].trim();

  // 2. Try to find strictly valid JSON object structure { ... }
  // This helps when AI outputs conversational text + JSON without code blocks
  match = text.match(/(\{[\s\S]*\})/);
  if (match && match[1]) return match[1].trim();

  // 3. Fallback: Remove all code block markers and trim
  return text.replace(/```json/g, '').replace(/```/g, '').trim();
}

// Helper to extract text from all parts of the response candidates
function extractResponseText(response: any): string {
    const parts = response.candidates?.[0]?.content?.parts || [];
    return parts.map((p: any) => p.text || "").join("").trim();
}

export type OldShopScoreResult = {
  score: number;
  reasoning: string;
  short_summary: string;
  is_shinise: boolean;
  founding_year: string; // 創業年（例: "1965年"）または "不明"
};

export type ShopGuideResult = {
  history_background: string;
  recommended_points: string;
  atmosphere: string;
  best_time_to_visit: string;
};

export async function generateOldShopScore(shop: {
  name: string;
  address?: string;
  reviews?: string[];
  types?: string[];
}): Promise<OldShopScoreResult> {
  const generativeModel = getModel();
  if (!generativeModel) {
    return { score: 0, reasoning: "AI configuration missing", short_summary: "AI未接続", is_shinise: false, founding_year: "不明" };
  }

  const prompt = `
    あなたは「老舗鑑定の達人」です。
    以下の店舗情報と口コミをもとに、この店がどれくらい「老舗（Shinise）」としての価値があるかを定性的に評価し、JSON形式で回答してください。
    ※ 本日は ${new Date().toLocaleDateString('ja-JP')} です。最新の情報を使って調査してください。

    【判定基準】
    - 単なる営業年数だけでなく、「語られ方」を重視する。
    - 「地元で愛されている」「昭和の雰囲気」「代々受け継がれる味」「看板娘/名物店主」などのナラティブな要素を高く評価する。
    - チェーン店は低く評価する。
    - スコアは0〜100点。80点以上は「認定老舗」。
    - **創業年はWEB検索で必ず調査してください**。見つからない場合は「不明」としてください。

    【入力情報】
    店名: ${shop.name}
    住所: ${shop.address || '不明'}
    ジャンル: ${shop.types?.join(', ') || '不明'}
    口コミ要約: ${shop.reviews?.join('\n') || 'なし'}

    【出力JSONフォーマット】
    {
      "score": number,
      "reasoning": "なぜそのスコアなのか、具体的なエピソードや雰囲気に触れて100文字程度で解説",
      "short_summary": "検索結果カードに表示する、情感あふれるキャッチコピー（20文字以内）",
      "is_shinise": boolean,
      "founding_year": "創業年（例: 1965年創業）。不明な場合は『不明』と記載"
    }
  `;

  try {
    const result = await generativeModel.generateContent(prompt);
    
    console.log("DEBUG: Full Vertex Response:", JSON.stringify(result.response, null, 2));

    const text = extractResponseText(result.response);
    
    if (!text) {
      console.warn("DEBUG: No text in response parts:", result.response.candidates?.[0].content.parts);
      throw new Error("No text response from Vertex AI");
    }

    console.log("DEBUG: Raw AI Response (Score):", JSON.stringify(text)); 
    const cleanText = cleanJson(text);
    console.log("DEBUG: Cleaned JSON:", JSON.stringify(cleanText));

    if (!cleanText) {
        throw new Error("Empty JSON after cleaning");
    }

    return JSON.parse(cleanText) as OldShopScoreResult;
  } catch (error: any) {
    console.error("Vertex AI strict error:", error);
    // Return explicit error state for debugging
    return {
      score: 0,
      reasoning: `AIエラー: ${error.message || "Unknown"}`,
      short_summary: "判定不能",
      is_shinise: false,
      founding_year: "不明"
    };
  }
}

export async function generateShopGuide(shop: {
  name: string;
  address?: string;
  reviews?: string[];
  types?: string[];
}): Promise<ShopGuideResult> {
  const generativeModel = getModel();
  if (!generativeModel) {
    return {
      history_background: "AI接続エラー",
      recommended_points: "",
      atmosphere: "",
      best_time_to_visit: ""
    };
  }

  const prompt = `
    あなたは「老舗鑑定の達人」です。
    以下の店舗情報と口コミをもとに、この店の魅力を語る「店主のガイド」を作成してください。JSON形式で回答してください。
    ※ 本日は ${new Date().toLocaleDateString('ja-JP')} です。WEB検索を活用し、最新の情報（営業状況・メニュー・口コミ等）を反映してください。

    【入力情報】
    店名: ${shop.name}
    住所: ${shop.address || '不明'}
    ジャンル: ${shop.types?.join(', ') || '不明'}
    口コミ要約: ${shop.reviews?.join('\n') || 'なし'}

    【出力JSONフォーマット】
    {
      "history_background": "この店の歴史や背景について、物語調で（150文字程度）",
      "recommended_points": "絶対に食べるべき一品や、見るべきポイント（100文字程度）",
      "atmosphere": "店内の雰囲気や、どんな時間を過ごせるか（50文字程度）",
      "best_time_to_visit": "おすすめの訪問時間帯や混雑状況の推測（30文字程度）"
    }
  `;

  try {
    const result = await generativeModel.generateContent(prompt);
    
    console.log("DEBUG: Full Vertex Response (Guide):", JSON.stringify(result.response, null, 2));

    const text = extractResponseText(result.response);
    
    if (!text) {
      console.warn("DEBUG: No text in response parts (Guide):", result.response.candidates?.[0].content.parts);
      throw new Error("No text response from Vertex AI");
    }

    console.log("DEBUG: Raw AI Response (Guide):", JSON.stringify(text));
    const cleanText = cleanJson(text);

    if (!cleanText) {
        throw new Error("Empty JSON after cleaning");
    }

    return JSON.parse(cleanText) as ShopGuideResult;
  } catch (error: any) {
    console.error("Vertex AI strict error:", error);
    return {
      history_background: `エラー: ${error.message}`,
      recommended_points: "",
      atmosphere: "",
      best_time_to_visit: ""
    };
  }
}

export async function findShiniseCandidates(stationName: string, genre?: string): Promise<string[]> {
  const generativeModel = getModel();
  if (!generativeModel) {
    console.error("Vertex AI not initialized for candidate search");
    return [];
  }

  const queryGenre = genre || "飲食店、総菜屋、甘味処、和菓子屋";
  
  const prompt = `
    あなたの任務は、指定されたエリア（${stationName}周辺）にある「地元で愛される名店（老舗）」を10軒探し出し、その店名のリストを作成することです。
    ※ 本日は ${new Date().toLocaleDateString('ja-JP')} です。最新の情報を使用し、閉店した店は除外してください。

    【検索条件】
    - エリア: ${stationName}駅 周辺
    - カテゴリ: ${queryGenre}
    - 必須条件:
        1. **創業5年以上**（できれば10年以上が望ましい）
        2. **地域密着型**（地元の人に愛されている）
        3. **チェーン店は絶対に除外**してください（大手資本が入っていない個店を優先）。
    
    【優先順位（重要）】
    - **食べログ等のグルメサイトで評価が高い順**（3.5以上を優先）に選出してください。
    - 口コミ数が多い店を優先してください。
    
    【除外対象】
    - 全国展開しているチェーン店
    - フランチャイズ店
    - 商業施設内のフードコート（単独店舗ならOKだが、路面店を優先）
    - 閉店した店舗

    【出力形式: JSON】
    以下のフォーマットで、店名のみを配列で返してください。余計な説明は不要です。
    {
      "candidates": [
        "店名A",
        "店名B",
        ...
      ]
    }
  `;

  try {
    const result = await generativeModel.generateContent(prompt);
    
    const text = extractResponseText(result.response);
    
    if (!text) {
        throw new Error("No candidates text from Vertex AI");
    }

    console.log("DEBUG: Raw Candidates Response:", JSON.stringify(text));
    const cleanText = cleanJson(text);
    console.log("DEBUG: Cleaned Candidates JSON:", cleanText);

    if (!cleanText) return [];

    const parsed = JSON.parse(cleanText) as { candidates: string[] };
    return parsed.candidates || [];

  } catch (error: any) {
    console.error("Vertex AI Candidate Search Error:", error);
    return [];
  }
}
