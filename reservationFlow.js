'use strict';

const crypto = require('crypto');

const sessions = new Map();
const TTL = 30 * 60 * 1000;
const PHONE = '050-6882-5580';
const POLICY_URL = 'https://houtoutaiken.lp-web.net/rule/';

function actionType(text) {
  if (/キャンセルしたい|キャンセルして|キャンセル希望|予約を取り消したい|予約を取消|取り消したい/.test(text)) {
    return 'cancel';
  }

  if (/予約変更|予約を変更|変更したい|変更して|人数変更|日時変更|日程変更|時間変更|人数を減ら|人数を増や|日にちを変え|時間を変え/.test(text)) {
    return 'update';
  }

  return null;
}

function guide(type) {
  if (type === 'cancel') {
    return [
      'ご予約のキャンセルを承ります。',
      '',
      '以下の3点をまとめてお送りください。',
      '',
      '① 予約者名',
      '② 現在の予約日時',
      '③「キャンセル希望」と記入',
      '',
      '【記入例】',
      '山田太郎',
      '11月3日 13:00',
      'キャンセル希望',
      '',
      '【キャンセル料】',
      '6日前まで：無料',
      '5〜2日前：30%',
      '前日：50%',
      '当日：100%',
      '',
      '規約：' + POLICY_URL,
      '',
      '予約内容とキャンセル料はスタッフが確認し、',
      '必要な場合にご連絡します。'
    ].join('\n');
  }

  return [
    'ご予約の変更を承ります！',
    '',
    '以下の3点をまとめてお送りください。',
    '',
    '① 予約者名',
    '② 現在の予約日時',
    '③ 変更したい内容',
    '',
    '【記入例】',
    '山田太郎',
    '11月3日 13:00',
    '3名のうち1名をそば打ち体験に変更',
    '',
    '必要事項が確認できましたら、',
    '変更を受け付けます。',
    '',
    '問題がある場合のみスタッフからご連絡します。'
  ].join('\n');
}

function parseDetails(text, type) {
  const lines = text
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  if (lines.length < 3) return null;

  const name = lines[0]
    .replace(/^[①1１][.、:：\s]*/, '')
    .trim();

  const original = lines[1]
    .replace(/^[②2２][.、:：\s]*/, '')
    .trim();

  const request = lines.slice(2)
    .join(' ')
    .replace(/^[③3３][.、:：\s]*/, '')
    .trim();

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

function looksLikeOtherQuestion(message) {
  return /[？?]|営業時間|駐車場|アクセス|料金|所要時間|何時|何分|何歳|アレルギー|ペット|犬|支払い|支払方法|定休日|場所|子供|こども/.test(message);
}

// LINEプロフィール取得
async function getLineProfile(userId) {
  const token =
    process.env.LINE_CHANNEL_ACCESS_TOKEN ||
    process.env.LINE_ACCESS_TOKEN;

  if (!token || !userId || !userId.startsWith('U')) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      'https://api.line.me/v2/bot/profile/' +
        encodeURIComponent(userId),
      {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + token
        }
      }
    );

    if (!response.ok) {
      console.warn(
        '[reservation] LINE profile HTTP',
        response.status
      );
      return null;
    }

    const profile = await response.json();

    return {
      line_user_id: userId,
      line_display_name: profile.displayName || null,
      line_picture_url: profile.pictureUrl || null
    };
  } catch (error) {
    console.warn(
      '[reservation] profile unavailable',
      error.message
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// レジへの通知
async function notify(s) {
  const url = process.env.RESERVATION_EVENT_API_URL;
  const key = process.env.RESERVATION_EVENT_API_KEY;

  if (!url || !key) {
    throw new Error('Reservation API not configured');
  }

  if (!url.startsWith('https://')) {
    throw new Error('Reservation API URL must use HTTPS');
  }

  const profile = await getLineProfile(s.lineUserId);

  const payload = {
    event_id: s.id,
    event_type: s.type === 'cancel'
      ? 'reservation.cancelled'
      : 'reservation.updated',
    source: 'line',
    reservation_id: null,
    occurred_at: s.occurredAt,

    reservation_details: {
      name: s.details.name,
      original: s.details.original,
      request: s.details.request
    },

    ...(profile || {})
  };

  console.log('[reservation] notify attempt', JSON.stringify({
    event_id: s.id,
    event_type: payload.event_type,
    profile_available: Boolean(profile)
  }));

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

    console.log('[reservation] notify response', JSON.stringify({
      event_id: s.id,
      status: response.status,
      ok: response.ok
    }));

    if (!response.ok) {
      throw new Error('Notification HTTP ' + response.status);
    }

    console.log('[reservation] notify success', s.id);
  } finally {
    clearTimeout(timer);
  }
}

async function handle(text, id) {
  const message = String(text || '').trim().slice(0, 1500);
  if (!message) return null;

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
      details: null,
      occurredAt: new Date().toISOString(),
      lineUserId: id
    };

    sessions.set(id, session);
    return guide(type);
  }

  if (session.details) {
    if (message !== '再送') return null;
  } else {
    if (
      looksLikeOtherQuestion(message) &&
      !parseDetails(message, session.type)
    ) {
      return null;
    }

    const details = parseDetails(message, session.type);

    if (!details) {
      return '必要事項を確認できませんでした。\n\n' +
        guide(session.type);
    }

    session.details = details;
    session.occurredAt = new Date().toISOString();
  }

  session.expires = Date.now() + TTL;

  try {
    await notify(session);
    sessions.delete(id);

    if (session.type === 'update') {
      return [
        'ご予約の変更を承りました！',
        '',
        '予約者名：' + session.details.name,
        '元の予約日時：' + session.details.original,
        '変更内容：' + session.details.request,
        '',
        '受付番号：' + session.id.slice(0, 8),
        '',
        '変更内容に問題がある場合のみ、',
        '当店からご連絡いたします。',
        '',
        '当日はお気をつけてお越しください！'
      ].join('\n');
    }

    return [
      'キャンセルのご希望を受け付けました。',
      '',
      '予約者名：' + session.details.name,
      '予約日時：' + session.details.original,
      '',
      '受付番号：' + session.id.slice(0, 8),
      '',
      'スタッフが予約内容とキャンセル料を確認します。',
      'キャンセルはまだ確定していません。'
    ].join('\n');

  } catch (error) {
    console.error(
      '[reservation] notification failed',
      JSON.stringify({
        event_id: session.id,
        error: error.message
      })
    );

    return [
      '申し訳ありません。',
      '現在、受付通知の保存ができませんでした。',
      '手続きはまだ完了していません。',
      '',
      'もう一度「再送」と送っていただくか、',
      'お急ぎの場合は ' + PHONE + ' へお電話ください。'
    ].join('\n');
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

module.exports = { handle, actionType };
