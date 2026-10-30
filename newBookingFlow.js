
'use strict';

const crypto = require('crypto');

const sessions = new Map();

const FORM = 'https://houtoutaiken.lp-web.net/contact/reserve/';
const GROUP_FORM = 'https://fujiyoshida-houtou.lp-web.net/group-reservation/';

const PHONE = process.env.STORE_PHONE || '店舗の電話番号';
const TTL = 24 * 60 * 60 * 1000;

const FIELDS = [
  'date',
  'time',
  'name',
  'phone',
  'count',
  'menu'
];

const LABELS = {
  date: 'ご希望日（例：11月5日）',
  time: 'ご希望時間（例：13:00）',
  name: '予約者のお名前（フルネーム）',
  phone: '電話番号',
  count: '体験人数',
  menu: '体験メニュー（ほうとう・吉田のうどん・そば等）'
};

function state(id) {
  const s = sessions.get(id);

  if (s && s.expires > Date.now()) {
    return s;
  }

  sessions.delete(id);
  return null;
}

function jstToday() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) {
    return false;
  }

  const d = new Date(s + 'T00:00:00Z');

  return !isNaN(d) &&
    d.toISOString().slice(0, 10) === s;
}

function validate(o) {
  const a = { ...o };

  if (!validDate(a.date)) {
    delete a.date;
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a.time || '')) {
    delete a.time;
  }

  if (!/^0\d{9,10}$/.test(
    (a.phone || '').replace(/[-\s]/g, '')
  )) {
    delete a.phone;
  }

  if (a.phone) {
    a.phone = a.phone.replace(/[-\s]/g, '');
  }

  if (
    !Number.isInteger(Number(a.count)) ||
    Number(a.count) < 1 ||
    Number(a.count) > 19
  ) {
    delete a.count;
  } else {
    a.count = Number(a.count);
  }

  if (!a.name || a.name.length > 80) {
    delete a.name;
  }

  if (!a.menu || a.menu.length > 100) {
    delete a.menu;
  }

  return a;
}

async function extract(text, current) {
  if (!process.env.OPENAI_API_KEY) {
    throw Error('OPENAI_API_KEY missing');
  }

  const today = jstToday();

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    12000
  );

  try {
    const r = await fetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization:
            'Bearer ' + process.env.OPENAI_API_KEY
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
          temperature: 0,
          response_format: {
            type: 'json_object'
          },
          messages: [
            {
              role: 'system',
              content: `
予約情報抽出専用です。

今日の日本日付は${today}です。

入力の中で明示された予約情報だけを
JSONに抽出してください。

キー：
date（YYYY-MM-DD）
time（HH:MM）
name
phone
count（整数）
menu

未指定はnull。

「明日」「来週土曜」などは日付変換。
日時が曖昧ならnull。

前回値は上書き指定された場合のみ更新。
質問には回答せず抽出のみ。
個人情報を推測しない。

JSONオブジェクトだけ返してください。
`
            },
            {
              role: 'user',
              content: JSON.stringify({
                previous: current,
                text
              })
            }
          ]
        })
      }
    );

    if (!r.ok) {
      throw Error('OpenAI ' + r.status);
    }

    const response = await r.json();
    const v = JSON.parse(
      response.choices[0].message.content
    );

    const out = {};

    for (const k of FIELDS) {
      if (
        v[k] !== null &&
        v[k] !== undefined &&
        v[k] !== ''
      ) {
        out[k] = v[k];
      }
    }

    return validate(out);

  } finally {
    clearTimeout(timer);
  }
}

function summary(d) {
  return [
    `日時：${d.date} ${d.time}`,
    `お名前：${d.name}様`,
    `電話番号：${d.phone}`,
    `人数：${d.count}名`,
    `体験：${d.menu}`
  ].join('\n');
}

function missing(d) {
  return FIELDS.filter(k => !d[k]);
}

function newSession() {
  return {
    data: {},
    phase: 'collect',
    expires: Date.now() + TTL,
    eventId: crypto.randomUUID()
  };
}

async function notify(s) {
  const url = process.env.RESERVATION_EVENT_API_URL;
  const key = process.env.RESERVATION_EVENT_API_KEY;

  if (
    !url ||
    !key ||
    process.env.LINE_BOOKING_API_DETAILS_SUPPORTED !== 'true'
  ) {
    throw Error('notification API details not confirmed');
  }

  const body = {
    event_id: s.eventId,
    event_type: 'reservation.created',
    source: 'line',
    reservation_id:
      'LINE-' + s.eventId.slice(0, 8).toUpperCase(),
    occurred_at: new Date().toISOString(),
    reservation_details: {
      ...s.data
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    12000
  );

  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Fujiya-Reservation-Key': key.trim()
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      throw Error('notify HTTP ' + r.status);
    }

  } finally {
    clearTimeout(timer);
  }
}

const intent = t =>
  /予約したい|予約お願いします|予約希望|予約できますか|予約を取りたい|予約したく|新規予約|LINEで予約|このLINEで予約|予約する|予約をお願い/.test(t);

const excluded = t =>
  /キャンセル|取消|取り消し|変更|遅刻|予約確認|キャンセル料/.test(t);

async function handle(text, id) {
  let s = state(id);

  if (!s) {
    if (excluded(text) || !intent(text)) {
      return null;
    }

    s = newSession();
    sessions.set(id, s);
  }

  s.expires = Date.now() + TTL;

  if (
    /^(予約をやめる|予約中止|入力を中止)$/.test(text.trim())
  ) {
    sessions.delete(id);
    return '予約入力を中止しました。';
  }

  if (s.phase === 'sent') {
    return 'すでに受付済みです。新しいご予約は「新規予約」と送ってください。';
  }

  if (s.phase === 'sending') {
    return '受付処理中です。少し時間をおいてお待ちください。';
  }

  if (
    s.phase === 'confirm' &&
    /^(予約確定|確定|はい|OK|ok)$/.test(text.trim())
  ) {
    s.phase = 'sending';

    try {
      await notify(s);

      s.phase = 'sent';

      return [
        'ご予約を承りました！',
        '',
        summary(s.data),
        '',
        '問題がある場合のみ当店からご連絡いたします。',
        '',
        'ほかに「すりだね作り体験」「藍染体験」もございます。',
        'ご希望でしたら、このLINEからお知らせください。'
      ].join('\n');

    } catch (e) {
      s.phase = 'confirm';

      console.error(
        '[new booking] notify failed',
        e.message
      );

      return [
        '予約通知の保存が完了しませんでした。',
        'まだ受付は確定していません。',
        '少し時間をおいて「予約確定」と再送してください。'
      ].join('\n');
    }
  }

  if (
    s.phase === 'confirm' &&
    /^(いいえ|修正|変更したい)$/.test(text.trim())
  ) {
    s.phase = 'collect';

    return '承知しました。修正したい項目と正しい内容をお送りください。';
  }

  if (s.phase === 'confirm') {
    s.phase = 'collect';
  }

  let patch;

  try {
    patch = await extract(text, s.data);
  } catch (e) {
    console.error(
      '[new booking] extract failed',
      e.message
    );

    return '申し訳ありません。現在内容を確認できません。少し時間をおいて再度お送りください。';
  }

  s.data = {
    ...s.data,
    ...patch
  };

  if (
    s.data.date &&
    s.data.date <= jstToday()
  ) {
    sessions.delete(id);

    if (s.data.date === jstToday()) {
      return `当日のご予約はお電話でお願いいたします。\n${PHONE}`;
    }

    return '過去の日付は予約できません。改めて「新規予約」と送ってください。';
  }

  if (s.data.count >= 20) {
    sessions.delete(id);

    return '20名以上の団体予約は専用フォームをご利用ください。\n' + GROUP_FORM;
  }

  const m = missing(s.data);

  if (m.length) {
    return [
      'ありがとうございます！',
      m.map(k => '・' + LABELS[k]).join('\n'),
      'を教えてください。',
      '',
      'Webフォームからもご予約いただけます。',
      FORM
    ].join('\n');
  }

  s.phase = 'confirm';

  return [
    '【ご予約内容の確認】',
    summary(s.data),
    '',
    '内容に間違いがなければ「予約確定」と送ってください。',
    '修正する場合は正しい内容を送ってください。'
  ].join('\n');
}

module.exports = {
  handle
};
