export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'Geen afbeelding ontvangen' });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY niet ingesteld op de server' });

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` }
            },
            {
              type: 'text',
              text: 'You are an OCR tool. Read the player names from this football lineup image and copy them EXACTLY as they appear — letter by letter, character by character. Do NOT use your football knowledge to correct, complete, or change any name. Do NOT add or remove letters. If a name looks unusual, still copy it exactly as shown. Return ONLY a valid JSON array of strings, no markdown, no explanation. Example: ["Virgil van Dijk", "B. Brobbey", "Cody Gakpo"]'
            }
          ]
        }],
        max_tokens: 600,
        temperature: 0
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Groq API fout: ${err}` });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';

    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return res.status(500).json({ error: 'AI kon geen spelersnamen vinden in de afbeelding' });

    const rawPlayers = JSON.parse(match[0]);
    if (!Array.isArray(rawPlayers)) throw new Error('Onverwacht formaat van AI-respons');
    const rawNames = rawPlayers.filter(p => typeof p === 'string' && p.trim());

    // Stap 2: corrigeer OCR-fouten met voetbalkennis
    const { teamName } = req.body;
    const correctionRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `These player names were extracted via OCR from a football lineup image${teamName ? ` for ${teamName}` : ''} and may contain OCR errors (wrong, extra, or missing letters). Use your knowledge of professional football players to fix any OCR mistakes. Only correct clear errors — do not change names that look correct. Return ONLY a valid JSON array of corrected name strings, no explanation, no markdown.\n\nRaw OCR names: ${JSON.stringify(rawNames)}`
        }],
        max_tokens: 400,
        temperature: 0
      })
    });

    let players = rawNames;
    if (correctionRes.ok) {
      const corrData = await correctionRes.json();
      const corrContent = corrData.choices?.[0]?.message?.content?.trim() || '';
      const corrMatch = corrContent.match(/\[[\s\S]*\]/);
      if (corrMatch) {
        try {
          const corrected = JSON.parse(corrMatch[0]);
          if (Array.isArray(corrected) && corrected.length === rawNames.length) {
            players = corrected.filter(p => typeof p === 'string' && p.trim());
          }
        } catch(e) { /* gebruik raw names als fallback */ }
      }
    }

    res.json({ players });
  } catch(e) {
    res.status(500).json({ error: e.message || 'Analyse mislukt' });
  }
}
