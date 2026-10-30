
'use strict';

const crypto = require('crypto');

const sessions = new Map();
const TTL = 30 * 60 * 1000;
const PHONE = '050-6882-5580';
const POLICY_URL = 'https://houtoutaiken.lp-web.net/rule/';

function actionType(text) {
  if (/キャンセルしたい|キャンセルして|キャンセル希望|予約を取り消したい|予約を取消|取り消したい/.test(text)) return 'cancel';
  if (/予約変更|予約を変更|変更したい|変更して|人数変更|日時変更|日程変更|時間変更|人数を減ら|人数を増や|日にちを変え|時間を変え/.test(text)) return 'update';
  return null;
}

function guide(type) {
  if (type === 'cancel') {
    return 'ご予約のキャンセルを承ります。\n\n以下の3点をまとめてお送りください。\n\n① 予約者名\n② 現在の予約日時\n③「キャンセル希望」と記入\n\n【記入例】\n山田太郎\n11月3日 13:00\nキャンセル希望\n\n【キャンセル料】\n6日前まで：無料\n5〜2日前：30%\n前日：50%\n当日：100%\n\n規約：' + POLICY_URL + '\n\n上記内容を送信するとキャンセルの受付となります。予約内容と料金はスタッフが確認し、必要な場合にご連絡します。';
  }

  return 'ご予約の変更を承ります！\n\n以下の3点をまとめてお送りください。\n\n① 予約者名\n② 現在の予約日時\n③ 変更したい内容\n\n【記入例】\n山田太郎\n11月3日 13:00\n7名から5名に変更\n\n日時・人数の変更は原則キャンセル料なしで承ります。\n問題がある場合のみスタッフからご連絡します。';
}

function parseDetails(text, type) {
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (lines.length < 3) return null;

  const name = lines[0].replace(/^[①1１][.、:：\s]*/, '').trim();
  const original = lines[1].replace(/^[②2２][.、:：\s]*/, '').trim();
  const request = lines.slice(2).join(' ').replace(/^[③3３][.、:：\s]*/, '').trim();

  if (!name || name.length > 80) return null;
  if (!/(\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/.test(original)) return null;
  if (type === 'cancel' ? !/キャンセル希望|キャンセルする|取り消し希望/.test(request) : request.length < 3) return null;

  return { name, original, request };
}

function looksLikeOtherQuestion(message) {
  return /[？?]|営業時間|駐車場|アクセス|料金|所要時間|何時|何分|何歳|アレルギー|ペット|犬|支払い|支払方法|定休日|場所|子供|こども/.test(message);
}

async function notify(s) {
  const url = process.env.RESERVATION_EVENT_API_URL;
  const key = process.env.RESERVATION_EVENT_API_KEY;

  console.log('[reservation] notify attempt', JSON.stringify({
    event_id: s.id,
    url_configured: Boolean(url),
    key_configured: Boolean(key),
    event_type: s.type,
    url_host: (() => {
      try { return url ? new URL(url).host : null; }
      catch { return 'invalid_url'; }
    })()
  }));

  if (!url || !key) {
    throw new Error('Reservation API not configured');
  }

  if (!url.startsWith('https://')) {
    throw new Error('Reservation API URL must use HTTPS');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Fujiya-Reservation-Key': key.trim()
      },
      body: JSON.stringify({
        event_id: s.id,
        event_type: s.type === 'cancel'
          ? 'reservation.cancelled'
          : 'reservation.updated',
        source: 'line',
        reservation_id: null,
        occurred_at: s.occurredAt
      })
    });

    const responseText = await response.text();

    console.log('[reservation] notify response', JSON.stringify({
      event_id: s.id,
      status: response.status,
      ok: response.ok,
      response_length: responseText.length
    }));

    if (!response.ok) {
      throw new Error(`Notification HTTP ${response.status}`);
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
      occurredAt: new Date().toISOString()
    };

    sessions.set(id, session);
    return guide(type);
  }

  if (session.details) {
    if (message !== '再送') return null;
  } else {
    if (looksLikeOtherQuestion(message) && !parseDetails(message, session.type)) {
      return null;
    }

    const details = parseDetails(message, session.type);

    if (!details) {
      return '必要事項を確認できませんでした。\n\n' + guide(session.type);
    }

    session.details = details;
    session.occurredAt = new Date().toISOString();
  }

  session.expires = Date.now() + TTL;

  try {
    await notify(session);
    sessions.delete(id);

   return session.type === 'update'
  ? 'ご予約の変更希望を受け付けました。\n\n受付番号：' + session.id.slice(0, 8) + '\n\nスタッフが予約内容を確認します。変更はまだ確定していません。'
  : 'キャンセルのご希望を受け付けました。\n\n受付番号：' + session.id.slice(0, 8) + '\n\nスタッフが予約内容とキャンセル料を確認します。キャンセルはまだ確定していません。';
  } catch (error) {
    console.error('[reservation] notification failed', JSON.stringify({
      event_id: session.id,
      error: error.message
    }));

    return '申し訳ありません。現在、受付通知の保存ができませんでした。\n手続きはまだ完了していません。\n\nもう一度「再送」と送っていただくか、お急ぎの場合は ' + PHONE + ' へお電話ください。';
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expires < now) sessions.delete(id);
  }
}, 600000).unref();

module.exports = { handle, actionType };
