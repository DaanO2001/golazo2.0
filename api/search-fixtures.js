export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  const headers = { 'x-apisports-key': process.env.APISPORTS_KEY };

  // Step 1: find team by name
  const teamsRes = await fetch(
    `https://v3.api-sports.io/teams?search=${encodeURIComponent(query)}`,
    { headers }
  );
  const teamsData = await teamsRes.json();

  if (!teamsData.response?.length) {
    return res.status(200).json({ fixtures: [] });
  }

  // Take the best matching team
  const teamId = teamsData.response[0].team.id;

  // Step 2: get next 8 fixtures for that team
  const fixturesRes = await fetch(
    `https://v3.api-sports.io/fixtures?team=${teamId}&next=8`,
    { headers }
  );
  const fixturesData = await fixturesRes.json();

  const fixtures = (fixturesData.response || []).map(f => ({
    id: f.fixture.id,
    date: f.fixture.date,
    home: f.teams.home.name,
    away: f.teams.away.name,
    league: f.league.name,
    homeLogo: f.teams.home.logo,
    awayLogo: f.teams.away.logo,
  }));

  res.status(200).json({ fixtures });
}
