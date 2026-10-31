
'use strict';

const crypto = require('crypto');

const sent = new Map();
const TTL = 30 * 60 * 1000;

function classify(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  // スタッフへの直接対応希望
  if (
    /スタッフ|担当者|人間|責任者|店長|直接対応|折り返し|電話して|連絡して/.test(s) &&
    /対応|確認|相談|話|お願い|希望|連絡|電話|代わって|つないで/.test(s)
  ) {
    return 'staff_requested';
  }

  // 苦情・返金・事故等
  if (
    /クレーム|苦情|返金|払い戻し|二重請求|請求間違い|事故|けが|怪我|体調不良|食中毒/.test(s)
  ) {
    return 'urgent_review';
  }

  // アレルギーに関する個別相談
  if (
    /アレルギー|アナフィラキシー/.test(s) &&
    /対応|除去|混入|食べられ|大丈夫|可能|相談|心配/.test(s)
  ) {
    return 'dietary_review';
  }

  // 特別対応
  if (
    /特別対応|個別対応|例外対応|貸切相談|特別なお願い/.test(s)
  ) {
    return 'special_request';
  }

  return null;
}

async function profileFor(id) {
  const token =
    process.env.CHANNEL_ACCESS_TOKEN ||
    process.env.LINE_CHANNEL_ACCESS_TOKEN ||
    process.env.LINE_ACCESS_TOKEN;

  if (!token || !/^U[0-9a-f]+$/i.test(id || '')) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      'https://api.line.me/v2/bot/profile/' +
        encodeURIComponent(id),
      {
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + token
        }
      }
    );

    if (!response.ok) return null;

    const profile = await response.json();

    return {
      line_user_id: id,
      line_display_name: profile.displayName || null,
      line_picture_url: profile.pictureUrl || null
    };
  } catch (error) {
    console.warn('[alert] profile failed', error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function notifyAlert({ text, id, reason }) {
  const url = process.env.RESERVATION_EVENT_API_URL;
  const key = process.env.RESERVATION_EVENT_API_KEY;

  if (!url || !key || !url.startsWith('https://')) {
    throw new Error('Reservation API not configured');
  }

  const dedupeKey = crypto
    .createHash('sha256')
    .update(
      String(id) + '\n' +
      String(reason) + '\n' +
      String(text).trim()
    )
    .digest('hex');

  if ((sent.get(dedupeKey) || 0) > Date.now()) {
    return { duplicate: true };
  }

  const eventId = crypto.randomUUID();
  const profile = await profileFor(id);

  const payload = {
    event_id: eventId,
    event_type: 'inquiry.needs_confirmation',
    source: 'line',
    reservation_id: null,
    occurred_at: new Date().toISOString(),
    requires_confirmation: true,
    confirmation_reason: reason,
    inquiry_details: {
      message: String(text).slice(0, 1500)
    },
    ...(profile || (
      id && id.startsWith('U')
        ? { line_user_id: id }
        : {}
    ))
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Fujiya-Reservation-Key': key.trim()
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(
        'Notification HTTP ' + response.status
      );
    }

    sent.set(dedupeKey, Date.now() + TTL);

    return { duplicate: false };
  } finally {
    clearTimeout(timer);
  }
}

setInterval(() => {
  for (const [key, expiry] of sent) {
    if (expiry <= Date.now()) sent.delete(key);
  }
}, 600000).unref();

module.exports = {
  classify,
  notifyAlert
};
