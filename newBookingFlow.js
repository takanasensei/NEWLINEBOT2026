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

// LINE自動予約受付時間（暫定）
// 9:00〜16:00のみ自動確定
const AUTO_START = 9 * 60;
const AUTO_END = 16 * 60;

function todayJST() {
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
      `${year}-${String(month).padStart(2, '0')}-` +
      String(day).padStart(2, '0');

    if (!m[1] && validDate(d) && d < today) {
      year++;

      d =
        `${year}-${String(month).padStart(2, '0')}-` +
        String(day).padStart(2, '0');
    }

    return validDate(d) ? d : null;
  }

  if (/明後日|あさって|明日|あした|今日|本日/.test(text)) {
    const days = /明後日|あさって/.test(text)
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

function dateMention(text) {
  return /(?:20\d{2}[年/.-])?\d{1,2}\s*[月/]\s*\d{1,2}\s*日?|明後日|あさって|明日|あした|今日|本日|来週|再来週|曜日/.test(text);
}

function state(id) {
  const s = sessions.get(id);

  if (s && s.expires > Date.now()) {
    return s;
  }

  sessions.delete(id);
  return null;
}

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
    p.count !== null &&
    p.count !== undefined &&
    p.count !== '' &&
    Number.isInteger(Number(p.count)) &&
    Number(p.count) >= 1
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

async function extract(text, current) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(
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
              content: [
                'あなたは富士家の予約情報抽出器。',
                '今日は日本時間' + todayJST() + '。',
                '店は年中無休。',
                'ユーザーの今回の文章に明示された情報だけを抽出し、JSONで返す。',
                'キーはtime(HH:MM),name(フルネーム),phone,count(整数),menu。',
                '未指定はnull。',
                '前回値は参考情報であり、今回の文章に明示されていない項目は絶対に返さない。',
                '日付は別処理で抽出するので返さない。',
                '時刻と人数を混同しない。',
                '「山梨コース」等は体験メニューの一部として保持。',
                '質問への回答はしない。'
              ].join('')
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

    if (!response.ok) {
      throw new Error('OpenAI HTTP ' + response.status);
    }

    const result = await response.json();

    const obj = JSON.parse(
      result.choices?.[0]?.message?.content || '{}'
    );

    return validatePatch(obj);
  } finally {
    clearTimeout(timer);
  }
}

function summary(d) {
  return [
    '日時：' + d.date + ' ' + d.time,
    'お名前：' + d.name + '様',
    '電話番号：' + d.phone,
    '人数：' + d.count + '名',
    '体験：' + d.menu
  ].join('\n');
}

function missing(d) {
  return FIELDS.filter(k => !d[k]);
}

function newSession(id) {
  return {
    data: {},
    phase: 'collect',
    expires: Date.now() + TTL,
    eventId: crypto.randomUUID(),
    lineUserId: id
  };
}

function isAutoTime(time) {
  if (!time) return true;

  const [hour, minute] = time.split(':').map(Number);
  const total = hour * 60 + minute;

  return total >= AUTO_START && total <= AUTO_END;
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
        '[new booking] LINE profile HTTP',
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
      '[new booking] profile unavailable',
      error.message
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// レジへ新規予約通知
async function notify(s) {
  const url = process.env.RESERVATION_EVENT_API_URL;
  const key = process.env.RESERVATION_EVENT_API_KEY;

  if (!url || !key) {
    throw new Error('Reservation API not configured');
  }

  if (
    process.env.LINE_BOOKING_API_DETAILS_SUPPORTED !== 'true'
  ) {
    throw new Error('レジ側の詳細表示が未確認');
  }

  if (!url.startsWith('https://')) {
    throw new Error('Reservation API URL must use HTTPS');
  }

  const profile = await getLineProfile(s.lineUserId);

  const body = {
    event_id: s.eventId,
    event_type: 'reservation.created',
    source: 'line',
    reservation_id:
      'LINE-' + s.eventId.slice(0, 8).toUpperCase(),
    occurred_at: new Date().toISOString(),

    reservation_details: {
      ...s.data
    },

    ...(profile || {})
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
      body: JSON.stringify(body)
    });

    console.log('[new booking] notify response', {
      event_id: s.eventId,
      status: response.status
    });

    if (!response.ok) {
      throw new Error('notify HTTP ' + response.status);
    }
  } finally {
    clearTimeout(timer);
  }
}

const intent = t =>
  /予約したい|予約お願いします|予約希望|予約できますか|予約を取りたい|予約したく|新規予約|LINEで予約|このLINEで予約|予約する|予約をお願い|予約したいです|予約をしたい/.test(t);

const excluded = t =>
  /キャンセル|取消|取り消し|変更|遅刻|予約確認|キャンセル料/.test(t);

async function handle(text, id) {
  text = String(text || '').trim();

  let s = state(id);

  if (!s) {
    if (excluded(text) || !intent(text)) {
      return null;
    }

    s = newSession(id);
    sessions.set(id, s);
  }

  if (s.phase === 'sent') {
    if (/^(新規予約|別の予約|もう一件予約)$/.test(text)) {
      s = newSession(id);
      sessions.set(id, s);
    } else {
      return [
        'このご予約は受付済みです。',
        '別の予約は「新規予約」と送ってください。'
      ].join('\n');
    }
  }

  s.expires = Date.now() + TTL;

  if (/^(予約をやめる|予約中止|入力を中止)$/.test(text)) {
    sessions.delete(id);
    return '予約入力を中止しました。';
  }

  if (s.phase === 'sending') {
    return '受付処理中です。少しお待ちください。';
  }

  // 予約確定
  if (
    s.phase === 'confirm' &&
    /^(予約確定|確定|はい|OK|ok)$/i.test(text)
  ) {
    if (!isAutoTime(s.data.time)) {
      s.phase = 'collect';
      delete s.data.time;

      return [
        'ご希望の時間帯はスタッフ確認が必要です。',
        'このLINEでは自動確定できません。',
        '',
        '9:00〜16:00の別のお時間をご指定いただくか、',
        '営業時間外をご希望の場合はお電話でご相談ください。',
        PHONE
      ].join('\n');
    }

    if (s.data.count >= 20) {
      sessions.delete(id);

      return [
        '20名以上の団体予約は専用フォームをご利用ください。',
        GROUP_FORM
      ].join('\n');
    }

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

    } catch (error) {
      s.phase = 'confirm';

      console.error(
        '[new booking] notify failed',
        error.message
      );

      return [
        '予約通知の保存が完了していないため、',
        'まだ受付確定ではありません。',
        '',
        'お手数ですが、しばらくしてから',
        '「予約確定」と再送してください。'
      ].join('\n');
    }
  }

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

  // 団体人数チェック
  const group = text.match(/(\d{1,3})\s*(?:名|人)(?!前)/);

  if (group && Number(group[1]) >= 20) {
    sessions.delete(id);

    return [
      '20名以上の団体予約は専用フォームをご利用ください。',
      GROUP_FORM
    ].join('\n');
  }

  // 日付取得
  const d = explicitDate(text);

  if (d) {
    s.data.date = d;
  } else if (dateMention(text)) {
    return [
      'ご希望日を確認できませんでした。',
      '「12月31日」のようにお送りください。'
    ].join('\n');
  }

  // 当日予約
  if (s.data.date && s.data.date <= todayJST()) {
    if (s.data.date === todayJST()) {
      sessions.delete(id);

      return [
        '当日のご予約はお電話でお願いいたします。',
        PHONE
      ].join('\n');
    }

    delete s.data.date;

    return [
      '過去の日付のため、',
      'ご希望日を改めてお知らせください。'
    ].join('\n');
  }

  // 予約情報抽出
  let patch;

  try {
    patch = await extract(text, s.data);
  } catch (error) {
    console.error(
      '[new booking] extract failed',
      error.message
    );

    return [
      '申し訳ありません。',
      '内容を確認できませんでした。',
      '少し時間をおいて再度お送りください。'
    ].join('\n');
  }

  s.data = {
    ...s.data,
    ...patch
  };

  // 20名以上
  if (s.data.count >= 20) {
    sessions.delete(id);

    return [
      '20名以上の団体予約は専用フォームをご利用ください。',
      GROUP_FORM
    ].join('\n');
  }

  // 営業時間外
  if (s.data.time && !isAutoTime(s.data.time)) {
    delete s.data.time;
    s.phase = 'collect';

    return [
      'ご希望の時間帯はスタッフによる確認が必要です。',
      '',
      '営業時間外の体験も対応できる場合がございますが、',
      'このLINEでの自動予約確定はできません。',
      '',
      '9:00〜16:00の別のお時間をご希望の場合は、',
      'ご希望時間をお送りください。',
      '',
      '営業時間外をご希望の場合はお電話でご相談ください。',
      PHONE
    ].join('\n');
  }

  // 不足項目を質問
  const m = missing(s.data);

  if (m.length) {
    return [
      'ありがとうございます！',
      '',
      ...m.map(k => '・' + LABELS[k]),
      '',
      'を教えてください。',
      '',
      'Webフォームからもご予約いただけます。',
      FORM
    ].join('\n');
  }

  // 最終確認
  s.phase = 'confirm';

  return [
    '【ご予約内容の確認】',
    summary(s.data),
    '',
    '内容に間違いがなければ',
    '「予約確定」と送ってください。',
    '',
    '修正する場合は正しい内容を送ってください。'
  ].join('\n');
}

module.exports = { handle };
