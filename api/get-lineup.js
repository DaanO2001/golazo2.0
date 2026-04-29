export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { fixture } = req.query;
  if (!fixture) return res.status(400).json({ error: 'fixture required' });

  const requestOptions = {
    method: 'GET',
    headers: { 'x-apisports-key': process.env.APISPORTS_KEY },
    redirect: 'follow'
  };

  const response = await fetch(
    `https://v3.football.api-sports.io/fixtures/lineups?fixture=${fixture}`,
    requestOptions
  );

  if (!response.ok) return res.status(response.status).json({ error: 'API error' });

  const data = await response.json();
  res.status(200).json(data);
}
