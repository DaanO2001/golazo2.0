import https from 'https';

function apiGet(url, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { 'x-apisports-key': apiKey }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Ongeldige API respons: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    if (!process.env.APISPORTS_KEY) {
      return res.status(500).json({ error: 'API key niet ingesteld' });
    }

    const data = await apiGet(
      'https://v3.football.api-sports.io/fixtures?live=all',
      process.env.APISPORTS_KEY
    );

    const fixtures = (data.response || []).map(f => ({
      id: f.fixture.id,
      date: f.fixture.date,
      home: f.teams.home.name,
      away: f.teams.away.name,
      league: f.league.name,
      score: `${f.goals.home ?? 0} - ${f.goals.away ?? 0}`,
      minuut: f.fixture.status.elapsed,
    }));

    res.status(200).json({ fixtures });
  } catch(e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
