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
              text: 'This is a football team lineup screenshot. Extract all player names exactly as shown. Return ONLY a valid JSON array of player name strings, no markdown, no explanation. Example: ["Virgil van Dijk", "Memphis Depay", "Cody Gakpo"]'
            }
          ]
        }],
        max_tokens: 600,
        temperature: 0.1
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

    const players = JSON.parse(match[0]);
    if (!Array.isArray(players)) throw new Error('Onverwacht formaat van AI-respons');

    res.json({ players: players.filter(p => typeof p === 'string' && p.trim()) });
  } catch(e) {
    res.status(500).json({ error: e.message || 'Analyse mislukt' });
  }
}
