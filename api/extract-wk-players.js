export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { rawText } = req.body;
  if (!rawText?.trim()) return res.status(400).json({ error: 'Geen tekst ontvangen' });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY niet ingesteld' });

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `Extract all football player names from this tournament squad list. Return ONLY a JSON array of the names as they appear on a lineup screenshot or shirt — typically surname or common short name (e.g. "Van de Ven", "Brobbey", "Gakpo"). Include players from all teams. No duplicates, no coaches or staff. Return ONLY the JSON array, no explanation.\n\nText:\n${rawText.slice(0, 12000)}`
        }],
        max_tokens: 2000,
        temperature: 0
      })
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      return res.status(500).json({ error: `Groq fout: ${err}` });
    }

    const groqData = await groqRes.json();
    const content = groqData.choices?.[0]?.message?.content?.trim() || '';
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return res.status(500).json({ error: 'Kon geen namen extraheren uit de tekst' });

    const players = JSON.parse(match[0]).filter(p => typeof p === 'string' && p.trim());
    res.json({ players });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Extractie mislukt' });
  }
}
