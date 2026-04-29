export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { fixture } = req.query;
  if (!fixture) return res.status(400).json({ error: 'fixture required' });

  const response = await fetch(`https://v3.api-sports.io/fixtures/lineups?fixture=${fixture}`, {
    headers: { 'x-apisports-key': process.env.APISPORTS_KEY }
  });

  if (!response.ok) return res.status(response.status).json({ error: 'API error' });

  const data = await response.json();
  res.status(200).json(data);
}
