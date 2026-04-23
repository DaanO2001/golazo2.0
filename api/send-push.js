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

  const { title, body } = req.body;

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
