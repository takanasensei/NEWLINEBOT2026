
'use strict';

const crypto = require('crypto');

const sessions = new Map();
const TTL = 30 * 60 * 1000;

const PHONE = '050-6882-5580';
const POLICY_URL = 'https://houtoutaiken.lp-web.net/rule/';

function actionType(text) {
  if (
    /キャンセルしたい|キャンセルして|キャンセル希望|予約を取り消したい|予約を取消|取り消したい/.test(text)
  ) {
    return 'cancel';
  }

  if (
    /予約変更|予約を変更|変更したい|変更して|人数変更|日時変更|日程変更|時間変更|人数を減ら|人数を増や|日にちを変え|時間を変え/.test(text)
  ) {
    return 'update';
  }

  return null;
}

function guide(type) {
  if (type === 'cancel') {
    return (
      'ご予約のキャンセルを承ります。\n\n' +
      '以下の3点をまとめてお送りください。\n\n' +
      '① 予約者名\n' +
      '② 現在の予約日時\n' +
      '③「キャンセル希望」と記入\n\n' +
      '【記入例】\n' +
      '山田太郎\n' +
      '11月3日 13:00\n' +
      'キャンセル希望\n\n' +
      '【キャンセル料】\n' +
      '6日前まで：無料\n' +
      '5〜2日前：30%\n' +
      '前日：50%\n' +
      '当日：100%\n\n' +
      '規約：' + POLICY_URL + '\n\n' +
      '上記内容を送信するとキャンセルの受付となります。' +
      '予約内容と料金はスタッフが確認し、必要な場合にご連絡します。'
    );
  }

  return (
    'ご予約の変更を承ります！\n\n' +
    '以下の3点をまとめてお送りください。\n\n' +
    '① 予約者名\n' +
    '② 現在の予約日時\n' +
    '③ 変更したい内容\n\n' +
    '【記入例】\n' +
    '山田太郎\n' +
    '11月3日 13:00\n' +
    '7名から5名に変更\n\n' +
    '日時・人数の変更は原則キャンセル料なしで承ります。\n' +
    '問題がある場合のみスタッフからご連絡します。'
  );
}

function parseDetails(text, type) {
  const lines = text
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  if (lines.length < 3) return null;

  const name = lines[0].replace(/^[①1１][.、:：\s]*/, '').trim();
  const original = lines[1].replace(/^[②2２][.、:：\s]*/, '').trim();
  const request = lines.slice(2).join(' ').replace(/^[③3３][.、:：\s]*/, '').trim();

  if (!name || name.length > 80) return null;

  if (!/(\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/.test(original)) {
    return null;
  }

  if (type === 'cancel') {
    if (!/キャンセル希望|キャンセルする|取り消し希望/.test(request)) {
      return null;
    }
  } else if (request.length < 3) {
    return null;
  }

  return { name, original, request };
}

async function notify(s) {
  const url = process.env.RESERVATION_EVENT_API_URL;
  const key = process.env.RESERVATION_EVENT_API_KEY;

  if (!url || !key) {
    throw new Error('Reservation API not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        event_id: s.id,
        event_type: s.type === 'cancel'
          ? 'reservation.cancelled'
          : 'reservation.updated',
        source: 'line',
        reservation_id: null,
        occurred_at: new Date().toISOString()
      })
    });

    if (!response.ok) {
      throw new Error(`Notification HTTP ${response.status}`);
    }

  } finally {
    clearTimeout(timer);
  }
}

async function handle(text, id) {
  const message = String(text || '').trim().slice(0, 1500);

  let session = sessions.get(id);

  if (session && session.expires < Date.now()) {
    sessions.delete(id);
    session = null;
  }

  if (/^(中止|やめる|手続き中止|受付中止)$/.test(message) && session) {
    sessions.delete(id);
    return '手続きを中止しました。';
  }

  if (!session) {
    const type = actionType(message);

    if (!type) return null;

    session = {
      id: crypto.randomUUID(),
      type,
      expires: Date.now() + TTL,
      details: null
    };

    sessions.set(id, session);
    return guide(type);
  }

  if (!session.details) {
    const details = parseDetails(message, session.type);

    if (!details) {
      return (
        '必要事項を確認できませんでした。\n\n' +
        guide(session.type)
      );
    }

    session.details = details;
  }

  try {
    await notify(session);

    sessions.delete(id);

    if (session.type === 'update') {
      return (
        'ご予約の変更を承りました。\n\n' +
        '受付番号：' + session.id.slice(0, 8) + '\n\n' +
        '問題がある場合のみ、スタッフから改めてご連絡します。'
      );
    }

    return (
      'キャンセルのご希望を受け付けました。\n\n' +
      '受付番号：' + session.id.slice(0, 8) + '\n\n' +
      'スタッフが予約内容とキャンセル料を確認し、必要な場合はご連絡します。'
    );

  } catch (error) {
    console.error(
      'reservation_notification_failed',
      session.id,
      error.message
    );

    return (
      '申し訳ありません。現在、受付通知の保存ができませんでした。\n' +
      '手続きはまだ完了していません。\n\n' +
      'もう一度「再送」と送っていただくか、' +
      'お急ぎの場合は ' + PHONE + ' へお電話ください。'
    );
  }
}

setInterval(() => {
  const now = Date.now();

  for (const [id, session] of sessions) {
    if (session.expires < now) {
      sessions.delete(id);
    }
  }
}, 600000).unref();

module.exports = {
  handle,
  actionType
};
