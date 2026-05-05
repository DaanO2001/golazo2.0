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

// Top 5 Europese competities + Eredivisie + Keuken Kampioen Divisie
const ALLOWED_LEAGUES = new Set([39, 140, 78, 135, 61, 88, 89]);
const LIVE_STATUSES   = new Set(['1H','2H','HT','ET','BT','P','LIVE']);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: 'query required' });

    if (!process.env.APISPORTS_KEY) {
      return res.status(500).json({ error: 'API key niet ingesteld' });
    }

    // Stap 1: zoek het team (max 1 API-call)
    let teamsData = await apiGet(
      `https://v3.football.api-sports.io/teams?search=${encodeURIComponent(query)}`,
      process.env.APISPORTS_KEY
    );

    if (teamsData.errors && Object.keys(teamsData.errors).length) {
      return res.status(500).json({ error: Object.values(teamsData.errors).join(', ') });
    }

    // Fallback: zoek zonder voorvoegsel ("FC Den Bosch" → "Den Bosch")
    if (!teamsData.response?.length) {
      const words = query.trim().split(' ');
      if (words.length > 1) {
        teamsData = await apiGet(
          `https://v3.football.api-sports.io/teams?search=${encodeURIComponent(words.slice(1).join(' '))}`,
          process.env.APISPORTS_KEY
        );
      }
    }

    if (!teamsData.response?.length) {
      return res.status(200).json({ fixtures: [], debug: 'Geen team gevonden voor: ' + query });
    }

    const teamId   = teamsData.response[0].team.id;
    const teamName = teamsData.response[0].team.name;

    // Stap 2: haal wedstrijden op van gisteren t/m 3 dagen vooruit (dekt live + komende)
    const now  = new Date();
    const from = new Date(now); from.setDate(from.getDate() - 1);
    const to   = new Date(now); to.setDate(to.getDate() + 3);
    const fromStr = from.toISOString().split('T')[0];
    const toStr   = to.toISOString().split('T')[0];

    const fixturesData = await apiGet(
      `https://v3.football.api-sports.io/fixtures?team=${teamId}&from=${fromStr}&to=${toStr}`,
      process.env.APISPORTS_KEY
    );

    if (fixturesData.errors && Object.keys(fixturesData.errors).length) {
      return res.status(500).json({ error: Object.values(fixturesData.errors).join(', ') });
    }

    // Filter op toegestane competities, sorteer op datum
    const fixtures = (fixturesData.response || [])
      .filter(f => ALLOWED_LEAGUES.has(f.league.id))
      .map(f => ({
        id:       f.fixture.id,
        date:     f.fixture.date,
        home:     f.teams.home.name,
        away:     f.teams.away.name,
        league:   f.league.name,
        status:   f.fixture.status.short,
        gespeeld: ['FT','AET','PEN'].includes(f.fixture.status.short),
        live:     LIVE_STATUSES.has(f.fixture.status.short),
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    if (!fixtures.length) {
      return res.status(200).json({
        fixtures: [],
        debug: `Team gevonden: ${teamName}, maar geen wedstrijden in de ondersteunde competities (de komende 3 dagen).`
      });
    }

    res.status(200).json({ fixtures });
  } catch(e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
