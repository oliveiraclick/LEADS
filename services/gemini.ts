
import { GoogleGenAI, Type } from "@google/genai";
import { SearchResult, BusinessInfo, GroundingSource } from "../types";

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// Helper to get API Key defensively
const getApiKey = () => {
  const browserKey = (typeof window !== 'undefined') ? ((window as any).__LP_GEMINI_API_KEY || localStorage.getItem('LP_GEMINI_API_KEY')) : '';
  return browserKey || import.meta.env.VITE_GEMINI_API_KEY || (typeof process !== 'undefined' ? process.env.GEMINI_API_KEY : '');
};

// Função auxiliar para tentar novamente em caso de erro de cota
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      // Se for erro de cota (429), espera e tenta de novo
      if (err.message?.includes('429') || err.status === 429) {
        console.warn(`Cota atingida. Tentativa ${i + 1} de ${maxRetries}. Aguardando...`);
        await delay(5000 * (i + 1)); // Espera 5s, depois 10s...
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

import { neighborhoodsByCity, getStaticNeighborhoods } from "./staticData";

export const fetchNeighborhoods = async (city: string): Promise<string[]> => {
  // Try static data first for speed and reliable fallback
  const staticList = getStaticNeighborhoods(city);
  if (staticList) return staticList;

  return withRetry(async () => {
    // Re-initialize for each call as per guidelines
    const key = getApiKey();
    if (!key) throw new Error("API_KEY_MISSING");
    const ai = new GoogleGenAI({ apiKey: key });
    const prompt = `Liste os 20 principais bairros da cidade de "${city}". Retorne apenas um array JSON de strings com os nomes dos bairros.`;

    const response = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            bairros: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["bairros"]
        }
      },
    });
    const data = JSON.parse(response.text || '{"bairros": []}');
    return data.bairros || [];
  });
};

export const generatePitch = async (niche: string, businessName: string): Promise<string> => {
  return withRetry(async () => {
    // Re-initialize for each call as per guidelines
    const key = getApiKey();
    if (!key) throw new Error("API_KEY_MISSING");
    const ai = new GoogleGenAI({ apiKey: key });
    const prompt = `Crie uma abordagem de vendas curta e persuasiva para o WhatsApp. 
      Empresa alvo: ${businessName} (Nicho: ${niche}). 
      Seja cordial, direto e use emojis. Máximo 300 caracteres.`;

    const response = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
    });
    return response.text || "Abordagem indisponível.";
  });
};

const createNormalizedId = (name: string, phone: string, neighborhood: string) => {
  const cleanName = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 15);
  const cleanPhone = (phone || '').replace(/\D/g, '').slice(-8);
  const cleanNeighborhood = (neighborhood || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 10);
  return `${cleanName}_${cleanNeighborhood}_${cleanPhone}`;
};

export const searchBusinesses = async (
  niche: string,
  city: string,
  neighborhood: string,
  deepSearch: boolean = false,
  location?: { latitude: number; longitude: number }
): Promise<SearchResult> => {
  return withRetry(async () => {
    // Re-initialize for each call as per guidelines
    const key = getApiKey();
    if (!key) throw new Error("API_KEY_MISSING");
    const ai = new GoogleGenAI({ apiKey: key });
    const tools: any[] = [{ googleMaps: {} }];
    if (deepSearch) tools.push({ googleSearch: {} });

    const prompt = `
      Aja como um minerador de dados comercial de elite.
      Objetivo: Listar PELO MENOS 10 empresas DIFERENTES de "${niche}" em "${neighborhood}, ${city}".
      Use as ferramentas para encontrar dados reais e atualizados.
      Formato para CADA empresa (separe com "---"):
      NOME: [Nome]
      TELEFONE: [DDD+Número]
      INSTAGRAM: [@usuario ou url]
      WEBSITE: [url]
      ---
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        tools: tools,
        toolConfig: location ? {
          retrievalConfig: { latLng: { latitude: location.latitude, longitude: location.longitude } }
        } : undefined
      },
    });

    const text = response.text || "";
    const businesses: BusinessInfo[] = [];
    const blocks = text.split(/---/).filter(block => block.trim().length > 10);

    blocks.forEach(block => {
      const name = block.match(/NOME:\s*(.+)/i)?.[1]?.trim();
      const rawPhoneLine = block.match(/TELEFONE:\s*(.+)/i)?.[1]?.trim() || '';
      const phoneMatch = rawPhoneLine.replace(/\D/g, '').match(/(?:55)?(\d{10,11})/);
      const rawPhone = phoneMatch ? phoneMatch[1] : '';

      const instagram = block.match(/INSTAGRAM:\s*(.+)/i)?.[1]?.trim();
      const website = block.match(/WEBSITE:\s*(.+)/i)?.[1]?.trim();

      if (name) {
        const bizId = createNormalizedId(name, rawPhone, neighborhood);
        const isMobile = rawPhone.length === 11 && (rawPhone[2] === '9' || rawPhone[2] === '8');
        businesses.push({
          id: bizId,
          name,
          phone: rawPhone,
          whatsappUrl: `https://wa.me/${rawPhone.startsWith('55') ? rawPhone : '55' + rawPhone}`,
          instagram: instagram && instagram !== 'N/A' ? instagram : undefined,
          website: website && website !== 'N/A' ? website : undefined,
          status: 'new',
          neighborhood,
          type: isMobile ? 'mobile' : 'landline'
        });
      }
    });

    // Extract grounding sources as required by Gemini API guidelines
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    const sources: GroundingSource[] = [];
    if (groundingChunks) {
      groundingChunks.forEach((chunk: any) => {
        if (chunk.web) {
          sources.push({ title: chunk.web.title || 'Web Source', uri: chunk.web.uri });
        }
        if (chunk.maps) {
          sources.push({ title: chunk.maps.title || 'Maps Source', uri: chunk.maps.uri });
        }
      });
    }

    return { text, businesses, sources };
  });
};
