import { GoogleGenAI } from "@google/genai";
import { AIAction } from "../types";

const apiKey = process.env.API_KEY || '';

// Initialize the client only if the key is available to avoid immediate errors, 
// though actual calls will fail if missing.
const ai = new GoogleGenAI({ apiKey });

const MODEL_NAME = 'gemini-3-flash-preview';

export const processTextWithAI = async (text: string, action: AIAction): Promise<string> => {
  if (!text.trim()) return '';
  if (!apiKey) throw new Error("API Key chưa được cấu hình.");

  let systemInstruction = "Bạn là một trợ lý viết lách thông minh bằng tiếng Việt.";
  let prompt = "";

  switch (action) {
    case AIAction.SUMMARIZE:
      prompt = `Hãy tóm tắt ngắn gọn nội dung sau đây (trả về kết quả tóm tắt): \n\n${text}`;
      break;
    case AIAction.FIX_GRAMMAR:
      prompt = `Hãy kiểm tra và sửa lỗi chính tả, ngữ pháp cho văn bản sau, giữ nguyên ý nghĩa gốc nhưng làm văn phong tự nhiên hơn (trả về văn bản đã sửa): \n\n${text}`;
      break;
    case AIAction.CONTINUE_WRITING:
      prompt = `Dựa trên nội dung sau, hãy viết tiếp một đoạn ngắn phù hợp với mạch văn (trả về phần viết tiếp): \n\n${text}`;
      break;
  }

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        systemInstruction,
      }
    });

    return response.text || "";
  } catch (error) {
    console.error("Gemini API Error:", error);
    throw error;
  }
};
