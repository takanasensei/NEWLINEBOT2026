
'use strict';
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_ENABLED = process.env.BOT_ENABLED === 'true';
const SAME_DAY_FORM_UNTIL_9 = process.env.SAME_DAY_FORM_UNTIL_9 === 'true';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const SECRET = process.env.CHANNEL_SECRET || '';
const LINE_TOKEN = process.env.CHANNEL_ACCESS_TOKEN || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

const info = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'storeInfo.json'), 'utf8')
);

const recent = new Map();
const seen = new Map();
const TTL = 30 * 60 * 1000;
const JST = 'Asia/Tokyo';

function nowJST() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: JST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  return Object.fromEntries(
    parts
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, Number(p.value)])
  );
}

function validDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function daysBetween(a, b) {
  return Math.round(
    (
      Date.UTC(b[0], b[1] - 1, b[2]) -
      Date.UTC(a[0], a[1] - 1, a[2])
    ) / 86400000
  );
}

function detectDate(text, current) {
  const today = [
    current.year,
    current.month,
    current.day
  ];

  if (/今日|本日|当日|今から|これから|今すぐ/.test(text)) {
    return 0;
  }
  if (/明後日|あさって/.test(text)) return 2;
  if (/明日|あした|翌日/.test(text)) return 1;

  const full = text.match(
    /(20\d{2})[年/.-]\s*(\d{1,2})[月/.-]\s*(\d{1,2})日?/
  );

  if (full) {
    const x = full.slice(1, 4).map(Number);
    return validDate(...x)
      ? daysBetween(today, x)
      : 'invalid';
  }

  const short =
    text.match(/(\d{1,2})月\s*(\d{1,2})日/) ||
    text.match(/(\d{1,2})\/(\d{1,2})(?!\d)/);

  if (short) {
    const m = Number(short[1]);
    const d = Number(short[2]);
    let y = current.year;

    if (!validDate(y, m, d)) return 'invalid';

    let delta = daysBetween(today, [y, m, d]);

    if (delta < 0) {
      y++;
      if (!validDate(y, m, d)) return 'invalid';
      delta = daysBetween(today, [y, m, d]);
    }

    return delta;
  }

  return null;
}

function isGroup(text) {
  if (/団体|修学旅行|旅行会社|貸切|大人数/.test(text)) {
    return true;
  }

  return [...text.matchAll(/(\d{1,3})\s*(名|人)(?!前)/g)]
    .some(m => Number(m[1]) >= info.reservation.groupThreshold);
}

function looksLikeBooking(text) {
  return /予約したい|予約できます|予約可能|申し込みたい|申込みたい|申し込む|予約をお願い|空きは|空いていますか|空いてる|予約希望|予約したく|予約する|予約お願いします|予約を取りたい/.test(text)
    || (
      /予約|申し込|空き状況/.test(text) &&
      !/キャンセル|変更|確認メール|ポリシー|規約|必要ですか|必須ですか|いつまで|方法|どうやって/.test(text)
    );
}

const formURL = info.reservation.url;
const phone = info.basicInfo.phone;
const email = info.basicInfo.email;

function bookingText(days, current) {
  if (days === 'invalid') {
    return 'ご希望の日付を確認できませんでした。「10月28日」のようにお送りください。';
  }

  if (days === null) {
    return 'ご予約希望日はいつでしょうか？「今日」「明日」「10月28日」などとお送りください。';
  }

  if (days < 0) {
    return '過去の日付では予約できません。改めてご希望日をお知らせください。';
  }

  const lateTomorrow = days === 1 && current.hour >= 17;

  if (
    (days === 0 && !(SAME_DAY_FORM_UNTIL_9 && current.hour < 9)) ||
    lateTomorrow
  ) {
    return (
      '当日・直前の体験予約は、空き状況をお電話でご確認ください。\n' +
      phone +
      '\n※LINEで予約確定はできません。'
    );
  }

  return (
    '体験のご予約はこちらのWebフォームからお願いいたします。\n' +
    formURL +
    '\n※現在はテストフォームです。正式公開まではフォーム送信で予約確定とは扱わないでください。'
  );
}

function groupText() {
  return (
    '20名以上の団体予約はスタッフが直接ご案内します。\n' +
    '電話：' + phone + '\n' +
    'メール：' + email +
    '\n※受け入れ可否は確認後のご案内です。'
  );
}

function cancellationText() {
  return (
    'ご予約の変更・キャンセルについては、スタッフが内容を確認いたします。\n' +
    email +
    '\nキャンセル規約：' + info.policies.cancellationUrl
  );
}

// 提供中の体験については、AIに自由に判断させない
function verifiedExperienceAnswer(text) {
  const q = text.replace(/\s/g, '');

  if (/藍染|藍染め|あいぞめ|染め物|染物|墨染|ワイン染/.test(q)) {
    const d = info.dyeing;

    const isBooking =
      /予約したい|申し込|予約できますか|空き|予約希望/.test(q);

    if (isBooking) return null;

    if (/セット|組み合わせ/.test(q)) {
      return (
        'はい、藍染め・墨染め・甲州ワイン染めを実施しています。\n' +
        '麺作り＋染め物セット：6,800円＋素材代500円〜\n' +
        '染め物＋すりだね／七味セット：各5,300円＋素材代500円〜\n' +
        d.url
      );
    }

    return (
      'はい、藍染め体験を実施しています。墨染め・甲州ワイン染めもお選びいただけます。\n' +
      '基本料金は1名3,500円（税込）で、素材代500円〜が別途かかります。所要時間は約60〜90分です。\n' +
      '受付は富士家です。\n' +
      '詳細：' + d.url
    );
  }

  const list = info.cafeExperiences.items;

  const names = [
    ['スパイスソルト', 'スパイスソルト'],
    ['ふりかけ', 'ふりかけ'],
    ['鯛焼き', '鯛焼き'],
    ['たい焼き', '鯛焼き'],
    ['クラフトコーラ', 'クラフトコーラ']
  ];

  for (const [word, name] of names) {
    if (
      q.includes(word) &&
      !/予約したい|申し込|予約できますか|空き|予約希望/.test(q)
    ) {
      const item = list.find(x => x.name.includes(name));

      if (!item) continue;

      return (
        'はい、' + item.name + '体験を実施しています。\n' +
        '料金は1名' +
        item.priceYen.toLocaleString('ja-JP') +
        '円（税込）、所要時間は約30分です。\n' +
        '詳しくはこちら：' + info.cafeExperiences.source
      );
    }
  }

  return null;
}

function fixedAnswer(text, userKey, current) {
  if (isGroup(text)) {
    recent.delete(userKey);
    return groupText();
  }

  if (/キャンセル|取り消し|予約変更|日程変更|人数変更|遅刻|遅れそう/.test(text)) {
    recent.delete(userKey);
    return cancellationText();
  }

  if (/アレルギー|アナフィラキシー|グルテン/.test(text)) {
    recent.delete(userKey);
    return (
      info.policies.allergy +
      '\n個別のご相談：' + email
    );
  }

  if (/【予約リクエストフォーム】/.test(text)) {
    recent.delete(userKey);
    return (
      '旧LINE予約フォームのメッセージは自動確定しません。' +
      'ご予約についてはスタッフへお問い合わせください。\n' +
      email
    );
  }

  if (looksLikeBooking(text)) {
    const days = detectDate(text, current);

    if (days === null) {
      recent.set(userKey, {
        kind: 'await-date',
        expires: Date.now() + TTL
      });
    } else {
      recent.delete(userKey);
    }

    return bookingText(days, current);
  }

  const state = recent.get(userKey);

  if (
    state?.kind === 'await-date' &&
    state.expires > Date.now()
  ) {
    const days = detectDate(text, current);

    if (days !== null) {
      recent.delete(userKey);
      return bookingText(days, current);
    }
  }

  return verifiedExperienceAnswer(text);
}

// AIへの指示文
const system = `
あなたは「${info.basicInfo.name}」のLINE問い合わせ窓口です。

店舗の事実は以下の店舗情報だけを使用してください。

重要：
藍染め・墨染め・甲州ワイン染めは実施中です。
「やっていない」と回答してはいけません。

店舗データに登録された体験について、
根拠なく実施していないと回答しないでください。

不明な料金・予約の空き状況・予約確定・
アレルギー対応の安全性を推測してはいけません。

お客様には簡潔で丁寧な敬語で回答してください。

予約希望の場合は予約日を確認してください。
AIが直接予約を確定してはいけません。

キャンセル・変更・アレルギー等は
スタッフへの確認を案内してください。

架空のURL、料金、営業時間、メニューを作らないでください。

現在の予約フォームはテスト版です。

店舗情報：
${JSON.stringify(info)}
`;

// OpenAI APIへの問い合わせ
async function callOpenAI(userText) {
  if (!OPENAI_KEY) {
    return '詳細はスタッフへお問い合わせください。\n' + email;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);

  try {
    const r = await fetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.1,
          max_tokens: 350,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userText }
          ]
        })
      }
    );

    if (!r.ok) {
      throw new Error(
        `OpenAI HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`
      );
    }

    const obj = await r.json();

    return (
      obj.choices?.[0]?.message?.content?.trim() ||
      '詳しくはスタッフへお問い合わせください。\n' + email
    );

  } finally {
    clearTimeout(timeout);
  }
}

// LINEへの返信送信
async function sendLINE(replyToken, content) {
  const r = await fetch(
    'https://api.line.me/v2/bot/message/reply',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_TOKEN}`
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: 'text',
            text: content.slice(0, 4900)
          }
        ]
      })
    }
  );

  if (!r.ok) {
    throw new Error(
      `LINE HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`
    );
  }
}

// LINE署名検証
function validSignature(body, supplied) {
  if (!SECRET || !supplied) return false;

  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('base64');

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

// サーバー起動確認
app.get('/', (req, res) => {
  res.json({
    ok: true,
    botEnabled: BOT_ENABLED
  });
});

// LINE Webhook
app.post(
  '/webhook',
  express.raw({
    type: 'application/json',
    limit: '1mb'
  }),
  (req, res) => {
    if (!validSignature(req.body, req.get('x-line-signature'))) {
      return res.sendStatus(401);
    }

    let payload;

    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }

    res.sendStatus(200);

    if (!BOT_ENABLED) return;

    for (const event of payload.events || []) {
      if (
        event.type !== 'message' ||
        event.message?.type !== 'text' ||
        !event.replyToken
      ) {
        continue;
      }

      const eventKey =
        event.webhookEventId || event.message.id;

      if (
        eventKey &&
        seen.has(eventKey) &&
        seen.get(eventKey) > Date.now()
      ) {
        continue;
      }

      if (eventKey) {
        seen.set(eventKey, Date.now() + TTL);
      }

      const userKey =
        event.source?.userId ||
        event.source?.groupId ||
        event.source?.roomId;

      if (!userKey) continue;

      (async () => {
        try {
          const text = event.message.text.trim();

          const answer =
            fixedAnswer(text, userKey, nowJST()) ||
            await callOpenAI(text);

          await sendLINE(event.replyToken, answer);

        } catch (error) {
          console.error('Reply failed:', error.message);
        }
      })();
    }
  }
);

// 一時データの削除
setInterval(() => {
  const t = Date.now();

  for (const [k, v] of recent) {
    if (v.expires <= t) recent.delete(k);
  }

  for (const [k, v] of seen) {
    if (v <= t) seen.delete(k);
  }
}, 10 * 60 * 1000).unref();

// 起動
app.listen(PORT, () => {
  console.log(
    `Fujiya bot ready on port ${PORT}; enabled=${BOT_ENABLED}`
  );
});
