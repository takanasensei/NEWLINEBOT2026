
'use strict';

const crypto = require('crypto');

const sessions = new Map();
const TTL = 30 * 60 * 1000;
const phone = '050-6882-5580';

function actionType(text) {
  if (/キャンセル(したい|して|をお願い|お願いします|希望)|予約を?(取り消|取消)|取り消したい/.test(text)) {
    return 'cancel';
  }

  if (/(予約|日時|日程|時間|人数).{0,12}(変更|変えたい|ずらしたい|減らしたい|増やしたい)|変更(したい|お願い)/.test(text)) {
    return 'update';
  }

  return null;
}

function clean(s) {
  return String(s || '').trim().slice(0, 300);
}

function yes(s) {
  return /^(はい|はい、お願いします|お願いします|確定|送信|受付をお願いします|yes|ok|ＯＫ)$/i.test(s.trim());
}

function no(s) {
  return /^(いいえ|やめる|中止|戻る|キャンセルしない)$/i.test(s.trim());
}

function cancellationTerms() {
  return 'キャンセル料は6日前まで0%、5〜2日前30%、前日50%、当日・無断100%が原則です。日時変更は原則キャンセル料なしです。悪天候時の例外などは規約をご確認ください。';
}

function start(id, type) {
  const s = {
    type,
    step: 0,
    values: [],
    id: crypto.randomUUID(),
    expires: Date.now() + TTL
  };

  sessions.set(id, s);

  return type === 'cancel'
    ? 'キャンセルを承るため、まず予約時のお名前（フルネーム）を教えてください。'
    : 'ご予約の変更を承ります。まず予約時のお名前（フルネーム）を教えてください。';
}

const questions = [
  '現在のご予約日時を「11月3日 13:00」のように教えてください。',
  '予約時のお電話番号の下4桁を教えてください。'
];

function promptFor(s) {
  if (s.step === 1) return questions[0];
  if (s.step === 2) return questions[1];

  if (s.step === 3 && s.type === 'update') {
    return '変更希望を具体的に教えてください（例：11月5日14時に変更、7名から5名へ変更）。';
  }

  return null;
}

function summary(s) {
  const v = s.values;

  const common =
    `予約者名：${v[0]}\n` +
    `元の予約日時：${v[1]}\n` +
    `電話番号下4桁：${v[2]}`;

  if (s.type === 'update') {
    return (
      '【予約変更の受付内容】\n' +
      common +
      `\n変更希望：${v[3]}` +
      '\n\n内容が正しければ「はい」、取りやめる場合は「いいえ」と返信してください。'
    );
  }

  return (
    '【キャンセル受付内容】\n' +
    common +
    '\n\n' +
    cancellationTerms() +
    '\n規約：https://houtoutaiken.lp-web.net/rule/' +
    '\n\nキャンセルを希望される場合は「はい」、取りやめる場合は「いいえ」と返信してください。'
  );
}

async function notify(s) {
  const url = process.env.RESERVATION_EVENT_API_URL;
  const key = process.env.RESERVATION_EVENT_API_KEY;

  if (!url || !key) {
    throw new Error('Reservation notification API not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const r = await fetch(url, {
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

    if (!r.ok) {
      throw new Error(`notification HTTP ${r.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function handle(text, id) {
  const t = clean(text);
  let s = sessions.get(id);

  if (s && s.expires < Date.now()) {
    sessions.delete(id);
    s = null;
  }

  if (s && /^(最初から|手続き中止|受付中止)$/.test(t)) {
    sessions.delete(id);
    return '手続きを中止しました。';
  }

  if (!s) {
    const type = actionType(t);
    return type ? start(id, type) : null;
  }

  if (s.step === 4) {
    if (no(t)) {
      sessions.delete(id);
      return '手続きを中止しました。';
    }

    if (!yes(t)) {
      return '内容が正しければ「はい」、取りやめる場合は「いいえ」と返信してください。';
    }

    try {
      await notify(s);
      sessions.delete(id);

      return s.type === 'update'
        ? `予約変更を承りました（受付番号：${s.id.slice(0, 8)}）。問題がある場合のみスタッフからご連絡します。レストランボードへの反映はスタッフが行います。`
        : `キャンセルのご希望を承りました（受付番号：${s.id.slice(0, 8)}）。スタッフが予約情報とキャンセル料を確認し、必要な場合はご連絡します。`;

    } catch (e) {
      console.error(
        'reservation_notification_failed',
        s.id,
        e.message
      );

      return (
        '申し訳ありません。受付通知を保存できなかったため、手続きは完了していません。' +
        `もう一度「はい」と送るか、お急ぎの場合は ${phone} へお電話ください。`
      );
    }
  }

  if (s.step === 2 && !/^\d{4}$/.test(t)) {
    return '予約時のお電話番号の下4桁を、数字4桁で教えてください。';
  }

  if (
    s.step === 1 &&
    !/(\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}|今日|明日|あさって)/.test(t)
  ) {
    return '元の予約日時を「11月3日 13:00」のように教えてください。';
  }

  if (t.length < 2) {
    return 'もう少し詳しく教えてください。';
  }

  s.values.push(t);
  s.step++;
  s.expires = Date.now() + TTL;

  if (s.step === 3 && s.type === 'cancel') {
    s.step = 4;
  }

  if (s.step === 4) {
    return summary(s);
  }

  return promptFor(s);
}

function isActive(id) {
  const s = sessions.get(id);
  return !!(s && s.expires > Date.now());
}

setInterval(() => {
  for (const [id, s] of sessions) {
    if (s.expires < Date.now()) {
      sessions.delete(id);
    }
  }
}, 600000).unref();

module.exports = {
  handle,
  isActive,
  actionType
};
