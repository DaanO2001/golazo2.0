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
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: 'query required' });

    if (!process.env.APISPORTS_KEY) {
      return res.status(500).json({ error: 'API key niet ingesteld (APISPORTS_KEY ontbreekt in Vercel)' });
    }

    const teamsData = await apiGet(
      `https://v3.football.api-sports.io/teams?search=${encodeURIComponent(query)}`,
      process.env.APISPORTS_KEY
    );

    if (teamsData.errors && Object.keys(teamsData.errors).length) {
      return res.status(500).json({ error: Object.values(teamsData.errors).join(', ') });
    }

    if (!teamsData.response?.length) {
      return res.status(200).json({ fixtures: [], debug: 'Geen team gevonden voor: ' + query });
    }

    const teamId = teamsData.response[0].team.id;
    const teamName = teamsData.response[0].team.name;

    const fixturesData = await apiGet(
      `https://v3.football.api-sports.io/fixtures?team=${teamId}&next=8`,
      process.env.APISPORTS_KEY
    );

    const fixtures = (fixturesData.response || []).map(f => ({
      id: f.fixture.id,
      date: f.fixture.date,
      home: f.teams.home.name,
      away: f.teams.away.name,
      league: f.league.name,
    }));

    if (!fixtures.length) {
      return res.status(200).json({ fixtures: [], debug: `Team gevonden: ${teamName} (id: ${teamId}), maar geen komende wedstrijden` });
    }

    res.status(200).json({ fixtures });
  } catch(e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
