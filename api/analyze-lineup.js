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
              text: 'You are an OCR tool. For each player name visible in this football lineup image extract: (1) the name EXACTLY as written — letter by letter, no corrections, (2) their approximate position as percentage coordinates from the top-left corner (x: 0-100, y: 0-100). Return ONLY a valid JSON array, no markdown, no explanation. Example: [{"name":"Brobbey","x":48,"y":65},{"name":"Van Dijk","x":20,"y":30}]'
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

    let rawPlayers;
    try {
      const jsonStr = match[0]
        .replace(/,\s*([\]}])/g, '$1')          // trailing commas
        .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":') // unquoted keys
        .replace(/:\s*'([^']*)'/g, ': "$1"');    // single-quoted values
      rawPlayers = JSON.parse(jsonStr);
    } catch {
      // Fallback: extract names with regex regardless of JSON structure
      const nameMatches = [...match[0].matchAll(/"name"\s*:\s*"([^"]+)"/g)];
      if (!nameMatches.length) return res.status(500).json({ error: 'AI kon geen spelersnamen vinden in de afbeelding' });
      rawPlayers = nameMatches.map(m => ({ name: m[1], x: 50, y: 50 }));
    }
    if (!Array.isArray(rawPlayers)) throw new Error('Onverwacht formaat van AI-respons');

    // Normaliseer: ondersteun zowel strings als {name, x, y} objecten
    const normalized = rawPlayers.map(p =>
      typeof p === 'string' ? { name: p, x: 50, y: 50 } : { name: p.name || '', x: p.x ?? 50, y: p.y ?? 50 }
    ).filter(p => p.name.trim());

    const rawNames = normalized.map(p => p.name);

    // Stap 2: corrigeer OCR-fouten, gebruik officiële spelerslijst indien beschikbaar
    const { teamName, wkPlayers } = req.body;
    const listContext = wkPlayers?.length
      ? `\n\nOfficiële spelerslijst voor dit toernooi:\n${JSON.stringify(wkPlayers)}\n\nMatch elke OCR-naam zo nauwkeurig mogelijk aan een naam uit deze lijst. Fix ook afgekapte namen (bijv. "Van de V..." → "Van de Ven", "De Ligt" als "De Li..." staat). Als er écht geen match is, gebruik de OCR-naam.`
      : ' Use your knowledge of professional football players to fix any OCR mistakes. Fix truncated names (e.g. "Van de V..." → "Van de Ven"). Only correct clear errors.';
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
          content: `These player names were extracted via OCR from a football lineup image${teamName ? ` for ${teamName}` : ''} and may contain OCR errors or truncations.${listContext} Return ONLY a valid JSON array of corrected name strings, same order, same length, no explanation.\n\nRaw OCR names: ${JSON.stringify(rawNames)}`
        }],
        max_tokens: 400,
        temperature: 0
      })
    });

    let finalNames = rawNames;
    if (correctionRes.ok) {
      const corrData = await correctionRes.json();
      const corrContent = corrData.choices?.[0]?.message?.content?.trim() || '';
      const corrMatch = corrContent.match(/\[[\s\S]*\]/);
      if (corrMatch) {
        try {
          const corrected = JSON.parse(corrMatch[0]);
          if (Array.isArray(corrected) && corrected.length === rawNames.length) {
            finalNames = corrected.map(p => (typeof p === 'string' ? p : p.name) || '').filter(Boolean);
          }
        } catch(e) { /* gebruik raw names als fallback */ }
      }
    }

    // Merge gecorrigeerde namen terug met coordinaten
    const players = normalized.map((p, i) => ({
      name: finalNames[i] || p.name,
      x: p.x,
      y: p.y
    }));

    res.json({ players });
  } catch(e) {
    res.status(500).json({ error: e.message || 'Analyse mislukt' });
  }
}
