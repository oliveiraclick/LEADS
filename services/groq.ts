
// Helper to get Groq API Key
const getGroqKey = () => {
    return localStorage.getItem('LP_GROQ_API_KEY') || '';
};

export const generatePitchWithGroq = async (niche: string, businessName: string): Promise<string> => {
    const key = getGroqKey();
    if (!key) throw new Error("GROQ_KEY_MISSING");

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{
                role: 'user',
                content: `Crie uma abordagem de vendas curta e persuasiva para o WhatsApp. 
          Empresa alvo: ${businessName} (Nicho: ${niche}). 
          Seja cordial, direto e use emojis. Máximo 300 caracteres.`
            }],
            max_tokens: 150
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Erro no Groq');
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || "Abordagem indisponível.";
};
