
'use strict';

const crypto = require('crypto');

const sessions = new Map();
const TTL = 30 * 60 * 1000;

const PHONE = '050-6882-5580';
const POLICY_URL = 'https://houtoutaiken.lp-web.net/rule/';

function actionType(text) {
  const message = String(text || '');

  if (
    /キャンセルしたい|キャンセルして|キャンセル希望|予約を取り消したい|予約を取消|取り消したい/.test(message)
  ) {
    return 'cancel';
  }

  if (
    /予約変更|予約を変更|変更したい|変更して|人数変更|日時変更|日程変更|時間変更|人数を減ら|人数を増や|日にちを変え|時間を変え/.test(message)
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
      '送信後、スタッフが内容を確認します。'
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
    'スタッフが内容を確認します。'
  );
}

function parseDetails(text, type) {
  const lines = String(text || '')
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

  if (
    !/(\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/.test(original)
  ) {
    return null;
  }

  if (type === 'cancel') {
    if (
      !/キャンセル希望|キャンセルする|取り消し希望/.test(request)
    ) {
      return null;
    }
  } else if (request.length < 3) {
    return null;
  }

  return { name, original, request };
}

function isRetry(message) {
  return /^(再送|もう一度送信|リトライ)$/.test(message);
}

function isCancelCommand(message) {
  return /^(中止|やめる|手続き中止|受付中止)$/.test(message);
}

function isLikelyQuestion(message) {
  return (
    /[？?]$/.test(message) ||
    /料金|値段|営業時間|駐車場|アクセス|場所|何時|何歳|子供|こども|持ち物|所要時間|支払い|支払方法|定休日|アレルギー/.test(message)
  );
}

function log(message, data = {}) {
  console.log(
    '[reservation]',
    message,
    JSON.stringify(data)
  );
}

async function notify(session) {
  const url = process.env.RESERVATION_EVENT_API_URL;
  const key = process.env.RESERVATION_EVENT_API_KEY;

  log('notify attempt', {
    event_id: session.id,
    url_configured: Boolean(url),
    key_configured: Boolean(key),
    event_type: session.type,
    url_host: (() => {
      try {
        return url ? new URL(url).host : null;
      } catch {
        return 'invalid_url';
      }
    })()
  });

  if (!url || !key) {
    throw new Error(
      'Reservation API not configured: URL or KEY missing'
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    8000
  );

  const payload = {
    event_id: session.id,
    event_type: session.type === 'cancel'
      ? 'reservation.cancelled'
      : 'reservation.updated',
    source: 'line',
    reservation_id: null,
    occurred_at: session.occurredAt
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();

    log('notify response', {
      event_id: session.id,
      status: response.status,
      ok: response.ok,
      response_length: responseText.length
    });

    if (!response.ok) {
      // レジ側の応答に個人情報や秘密情報が
      // 含まれる可能性があるため本文は記録しない。
      throw new Error(
        `Notification HTTP ${response.status}`
      );
    }

    log('notify success', {
      event_id: session.id
    });

    return true;

  } catch (error) {
    log('notify error', {
      event_id: session.id,
      name: error.name,
      message: error.message,
      cause: error.cause?.code || null
    });

    throw error;

  } finally {
    clearTimeout(timer);
  }
}

async function handle(text, id) {
  const message = String(text || '')
    .trim()
    .slice(0, 1500);

  if (!message) return null;

  let session = sessions.get(id);

  if (session && session.expires < Date.now()) {
    sessions.delete(id);
    session = null;
  }

  // 手続きを中止
  if (isCancelCommand(message) && session) {
    sessions.delete(id);
    return '手続きを中止しました。';
  }

  // 新しい予約変更・キャンセルの依頼
  const newType = actionType(message);

  if (!session) {
    if (!newType) return null;

    session = {
      id: crypto.randomUUID(),
      type: newType,
      expires: Date.now() + TTL,
      details: null,
      occurredAt: new Date().toISOString()
    };

    sessions.set(id, session);

    return guide(newType);
  }

  // 別の手続きへ切り替え
  if (
    newType &&
    newType !== session.type &&
    !session.details
  ) {
    session = {
      id: crypto.randomUUID(),
      type: newType,
      expires: Date.now() + TTL,
      details: null,
      occurredAt: new Date().toISOString()
    };

    sessions.set(id, session);

    return guide(newType);
  }

  // API送信に失敗した通知がある場合
  if (session.details) {
    // 再送指示の場合のみ送信
    if (!isRetry(message)) {
      // 通常の質問はFAQへ
      return null;
    }
  } else {
    // 通常の質問はFAQへ
    if (
      isLikelyQuestion(message) &&
      !parseDetails(message, session.type)
    ) {
      return null;
    }

    const details = parseDetails(
      message,
      session.type
    );

    if (!details) {
      return (
        '必要事項を確認できませんでした。\n\n' +
        guide(session.type)
      );
    }

    session.details = details;
    session.occurredAt = new Date().toISOString();
  }

  session.expires = Date.now() + TTL;

  try {
    await notify(session);

    sessions.delete(id);

    if (session.type === 'update') {
      return (
        'ご予約の変更希望を受け付けました。\n\n' +
        '受付番号：' +
        session.id.slice(0, 8) +
        '\n\n' +
        'スタッフが内容を確認します。\n' +
        '変更が確定したという意味ではありません。'
      );
    }

    return (
      'キャンセルのご希望を受け付けました。\n\n' +
      '受付番号：' +
      session.id.slice(0, 8) +
      '\n\n' +
      'スタッフが予約内容とキャンセル料を確認します。\n' +
      'この時点ではキャンセル確定ではありません。'
    );

  } catch (error) {
    console.error(
      '[reservation] notification failed',
      JSON.stringify({
        event_id: session.id,
        error: error.message
      })
    );

    return (
      '申し訳ありません。\n' +
      '現在、受付通知を保存できませんでした。\n\n' +
      '手続きはまだ完了していません。\n\n' +
      'もう一度「再送」と送っていただくか、' +
      'お急ぎの場合は ' +
      PHONE +
      ' へお電話ください。\n\n' +
      '通常のご質問はこのままお送りいただけます。'
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
