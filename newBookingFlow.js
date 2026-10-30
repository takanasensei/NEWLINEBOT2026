
'use strict';

const crypto = require('crypto');

const sessions = new Map();

const FORM =
  'https://houtoutaiken.lp-web.net/contact/reserve/';

const GROUP_FORM =
  'https://fujiyoshida-houtou.lp-web.net/group-reservation/';

const PHONE =
  process.env.STORE_PHONE || '050-6882-5580';

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
  date: 'ご希望日（例：12月31日）',
  time: 'ご希望時間（例：13:00）',
  name: '予約者のお名前（フルネーム）',
  phone: '電話番号',
  count: '体験人数',
  menu: '体験メニュー'
};

// 日本時間の日付
function todayJST() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

// 日付の妥当性
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) {
    return false;
  }

  const d = new Date(s + 'T00:00:00Z');

  return !isNaN(d) &&
    d.toISOString().slice(0, 10) === s;
}

// 日付はAIに任せず、プログラムで取得
function explicitDate(text) {
  const today = todayJST();
  const y = Number(today.slice(0, 4));

  const m = text.match(
    /(?:(20\d{2})\s*[年/.-]\s*)?(\d{1,2})\s*[月/]\s*(\d{1,2})\s*日?/
  );

  if (m) {
    let year = m[1] ? Number(m[1]) : y;
    const month = Number(m[2]);
    const day = Number(m[3]);

    let d =
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    if (!m[1] && validDate(d) && d < today) {
      year++;

      d =
        `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    return validDate(d) ? d : null;
  }

  if (
    /明後日|あさって|明日|あした|今日|本日/.test(text)
  ) {
    const days =
      /明後日|あさって/.test(text)
        ? 2
        : /明日|あした/.test(text)
          ? 1
          : 0;

    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);

    return d.toISOString().slice(0, 10);
  }

  return null;
}

// 日付について言及しているか
function dateMention(text) {
  return /(?:20\d{2}[年/.-])?\d{1,2}\s*[月/]\s*\d{1,2}\s*日?|明後日|あさって|明日|あした|今日|本日|来週|再来週|曜日/.test(text);
}

// 予約途中のデータを取得
function state(id) {
  const s = sessions.get(id);

  if (s && s.expires > Date.now()) {
    return s;
  }

  sessions.delete(id);
  return null;
}

// AIが読み取った内容を検証
function validatePatch(p) {
  const a = {};

  if (
    typeof p.time === 'string' &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(p.time)
  ) {
    a.time = p.time;
  }

  if (typeof p.phone === 'string') {
    const n = p.phone.replace(/[-\sー]/g, '');

    if (/^0\d{9,10}$/.test(n)) {
      a.phone = n;
    }
  }

  if (
    Number.isInteger(Number(p.count)) &&
    Number(p.count) >= 1 &&
    Number(p.count) <= 19
  ) {
    a.count = Number(p.count);
  }

  if (
    typeof p.name === 'string' &&
    p.name.trim().length >= 2 &&
    p.name.length <= 80
  ) {
    a.name = p.name.trim();
  }

  if (
    typeof p.menu === 'string' &&
    p.menu.trim().length >= 2 &&
    p.menu.length <= 100
  ) {
    a.menu = p.menu.trim();
  }

  return a;
}

// AIで不足情報を読み取る
async function extract(text, current) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    15000
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
          model:
            process.env.OPENAI_MODEL || 'gpt-4.1-mini',
          temperature: 0,
          response_format: {
            type: 'json_object'
          },
          messages: [
            {
              role: 'system',
              content: `
あなたは富士家の予約情報抽出器です。

今日は日本時間${todayJST()}です。
富士家は年中無休です。

ユーザーの今回の文章に明示された情報だけを
JSONで返してください。

キー：
time（HH:MM）
name（フルネーム）
phone
count（整数）
menu

未指定はnull。

前回値は参考情報です。
今回の文章に明示されていない項目は
絶対に返さないでください。

日付は別処理で抽出するので返さないでください。

時刻と人数を混同しないでください。

「山梨コース」などは
体験メニューの一部として保持してください。

質問への回答はしないでください。
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
      throw Error('OpenAI HTTP ' + r.status);
    }

    const response = await r.json();

    const obj = JSON.parse(
      response.choices?.[0]?.message?.content || '{}'
    );

    return validatePatch(obj);

  } finally {
    clearTimeout(timer);
  }
}

// 予約内容の表示
function summary(d) {
  return [
    `日時：${d.date} ${d.time}`,
    `お名前：${d.name}様`,
    `電話番号：${d.phone}`,
    `人数：${d.count}名`,
    `体験：${d.menu}`
  ].join('\n');
}

// 不足している項目
function missing(d) {
  return FIELDS.filter(k => !d[k]);
}

// 新規予約セッション
function newSession() {
  return {
    data: {},
    phase: 'collect',
    expires: Date.now() + TTL,
    eventId: crypto.randomUUID()
  };
}

// レジへの予約通知
async function notify(s) {
  const url =
    process.env.RESERVATION_EVENT_API_URL;

  const key =
    process.env.RESERVATION_EVENT_API_KEY;

  if (
    !url ||
    !key ||
    process.env.LINE_BOOKING_API_DETAILS_SUPPORTED !== 'true'
  ) {
    throw Error('レジ側の詳細表示が未確認');
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

// 新規予約の開始判定
const intent = t =>
  /予約したい|予約お願いします|予約希望|予約できますか|予約を取りたい|予約したく|新規予約|LINEで予約|このLINEで予約|予約する|予約をお願い|予約したいです|予約をしたい/.test(t);

// 変更・キャンセルは既存処理へ
const excluded = t =>
  /キャンセル|取消|取り消し|変更|遅刻|予約確認|キャンセル料/.test(t);

// メイン処理
async function handle(text, id) {
  text = String(text || '').trim();

  let s = state(id);

  if (!s) {
    if (excluded(text) || !intent(text)) {
      return null;
    }

    s = newSession();
    sessions.set(id, s);
  }

  // 受付済みの予約
  if (s.phase === 'sent') {
    if (
      /^(新規予約|別の予約|もう一件予約)$/.test(text)
    ) {
      s = newSession();
      sessions.set(id, s);
    } else {
      return 'このご予約は受付済みです。別の予約は「新規予約」と送ってください。';
    }
  }

  s.expires = Date.now() + TTL;

  // 予約入力を中止
  if (
    /^(予約をやめる|予約中止|入力を中止)$/.test(text)
  ) {
    sessions.delete(id);

    return '予約入力を中止しました。';
  }

  // 送信処理中
  if (s.phase === 'sending') {
    return '受付処理中です。少しお待ちください。';
  }

  // 最終確定
  if (
    s.phase === 'confirm' &&
    /^(予約確定|確定|はい|OK|ok)$/i.test(text)
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
        'すりだね作り体験や藍染体験もございます。',
        '追加をご希望の場合は、このLINEからご連絡ください。'
      ].join('\n');

    } catch (e) {
      s.phase = 'confirm';

      console.error(
        '[new booking] notify failed',
        e.message
      );

      return [
        '予約通知の保存が完了していないため、',
        'まだ受付確定ではありません。',
        'お手数ですが、しばらくしてから',
        '「予約確定」と再送してください。'
      ].join('\n');
    }
  }

  // 修正希望
  if (
    s.phase === 'confirm' &&
    /^(いいえ|修正|変更したい)$/.test(text)
  ) {
    s.phase = 'collect';

    return '修正したい項目と正しい内容をお送りください。';
  }

  if (s.phase === 'confirm') {
    s.phase = 'collect';
  }

  // 団体予約
  const group = text.match(
    /(\d{1,3})\s*(?:名|人)(?!前)/
  );

  if (group && Number(group[1]) >= 20) {
    sessions.delete(id);

    return [
      '20名以上の団体予約は専用フォームをご利用ください。',
      GROUP_FORM
    ].join('\n');
  }

  // 日付を取得
  const d = explicitDate(text);

  if (d) {
    s.data.date = d;
  } else if (dateMention(text)) {
    return [
      'ご希望日を確認できませんでした。',
      '「12月31日」のようにお送りください。'
    ].join('\n');
  }

  // 当日予約・過去日付の判定
  if (
    s.data.date &&
    s.data.date <= todayJST()
  ) {
    if (s.data.date === todayJST()) {
      sessions.delete(id);

      return [
        '当日のご予約はお電話でお願いいたします。',
        PHONE
      ].join('\n');
    }

    delete s.data.date;

    return '過去の日付のため、ご希望日を改めてお知らせください。';
  }

  // 追加情報を抽出
  let patch;

  try {
    patch = await extract(text, s.data);

  } catch (e) {
    console.error(
      '[new booking] extract failed',
      e.message
    );

    return '申し訳ありません。内容を確認できませんでした。少し時間をおいて再度お送りください。';
  }

  // 既存の情報を保持して追加
  s.data = {
    ...s.data,
    ...patch
  };

  // 不足項目を質問
  const m = missing(s.data);

  if (m.length) {
    return [
      'ありがとうございます！',
      '',
      m.map(k => '・' + LABELS[k]).join('\n'),
      '',
      'を教えてください。',
      '',
      'Webフォームからもご予約いただけます。',
      FORM
    ].join('\n');
  }

  // 予約内容の最終確認
  s.phase = 'confirm';

  return [
    '【ご予約内容の確認】',
    '',
    summary(s.data),
    '',
    '内容に間違いがなければ',
    '「予約確定」と送ってください。',
    '',
    '修正する場合は正しい内容を送ってください。'
  ].join('\n');
}

module.exports = {
  handle
};
