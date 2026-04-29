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
    const { fixture } = req.query;
    if (!fixture) return res.status(400).json({ error: 'fixture required' });

    const data = await apiGet(
      `https://v3.football.api-sports.io/fixtures/lineups?fixture=${fixture}`,
      process.env.APISPORTS_KEY
    );

    res.status(200).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
