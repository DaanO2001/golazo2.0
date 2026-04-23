import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL}`,
  process.env.VITE_VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { title, body, messages } = req.body;

  // messages = [{ player_id, title, body }, ...] — één per vraag per speler
  if (messages && Array.isArray(messages)) {
    const playerIds = [...new Set(messages.map(m => m.player_id))];
    const { data: rows, error } = await supabase
      .from('push_subscriptions')
      .select('player_id, subscription')
      .in('player_id', playerIds);

    if (error) return res.status(500).json({ error: error.message });

    const subByPlayer = {};
    rows.forEach(r => { subByPlayer[r.player_id] = r.subscription; });

    const results = await Promise.allSettled(
      messages
        .filter(m => subByPlayer[m.player_id])
        .map(m => webpush.sendNotification(subByPlayer[m.player_id], JSON.stringify({ title: m.title, body: m.body })))
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    return res.status(200).json({ sent, failed });
  }

  // Broadcast naar alle subscriptions
  const { data: rows, error } = await supabase
    .from('push_subscriptions')
    .select('subscription');

  if (error) return res.status(500).json({ error: error.message });

  const payload = JSON.stringify({ title, body });
  const results = await Promise.allSettled(
    rows.map(row => webpush.sendNotification(row.subscription, payload))
  );

  const sent = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  res.status(200).json({ sent, failed });
}
