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

  // messages = [{ player_id, title, body }, ...] voor gepersonaliseerde notificaties
  // title + body = broadcast naar iedereen
  if (messages && Array.isArray(messages)) {
    const playerIds = messages.map(m => m.player_id);
    const { data: rows, error } = await supabase
      .from('push_subscriptions')
      .select('player_id, subscription')
      .in('player_id', playerIds);

    if (error) return res.status(500).json({ error: error.message });

    const results = await Promise.allSettled(
      rows.map(row => {
        const msg = messages.find(m => m.player_id === row.player_id);
        if (!msg) return Promise.resolve();
        return webpush.sendNotification(row.subscription, JSON.stringify({ title: msg.title, body: msg.body }));
      })
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
