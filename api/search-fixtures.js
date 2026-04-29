export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  if (!process.env.APISPORTS_KEY) {
    return res.status(500).json({ error: 'API key niet ingesteld (APISPORTS_KEY ontbreekt in Vercel)' });
  }

  const requestOptions = {
    method: 'GET',
    headers: { 'x-apisports-key': process.env.APISPORTS_KEY },
    redirect: 'follow'
  };

  const teamsRes = await fetch(
    `https://v3.football.api-sports.io/teams?search=${encodeURIComponent(query)}`,
    requestOptions
  );
  const teamsData = await teamsRes.json();

  if (teamsData.errors && Object.keys(teamsData.errors).length) {
    return res.status(500).json({ error: Object.values(teamsData.errors).join(', ') });
  }

  if (!teamsData.response?.length) {
    return res.status(200).json({ fixtures: [] });
  }

  const teamId = teamsData.response[0].team.id;

  const fixturesRes = await fetch(
    `https://v3.football.api-sports.io/fixtures?team=${teamId}&next=8`,
    requestOptions
  );
  const fixturesData = await fixturesRes.json();

  const fixtures = (fixturesData.response || []).map(f => ({
    id: f.fixture.id,
    date: f.fixture.date,
    home: f.teams.home.name,
    away: f.teams.away.name,
    league: f.league.name,
  }));

  res.status(200).json({ fixtures });
}
