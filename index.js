
'use strict';

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
const reservationFlow = require('./reservationFlow');

const app = express();

const reservationFlow = require('./reservationFlow');

const app = express();
const reservationFlow = require('./reservationFlow');
const newBookingFlow = require('./newBookingFlow');

const info = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'storeInfo.json'),
    'utf8'
  )
);

const PORT = Number(process.env.PORT || 3000);
const ENABLED = process.env.BOT_ENABLED === 'true';

const SAME_DAY_FORM =
  process.env.SAME_DAY_FORM_UNTIL_9 === 'true';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const SECRET = process.env.CHANNEL_SECRET || '';
const LINE_TOKEN = process.env.CHANNEL_ACCESS_TOKEN || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

const TTL = 30 * 60 * 1000;

// 直近5往復（ユーザー5件＋AI5件）
const MAX_MESSAGES = 10;

// 文字数による簡易制限
const MAX_HISTORY_CHARS = 4500;

const history = new Map();
const pendingDate = new Map();
const seen = new Map();
const queues = new Map();

const usageTotal = {
  calls: 0,
  input: 0,
  output: 0,
  cached: 0
};

// =======================================
// 日本時間
// =======================================

function nowJST() {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  return Object.fromEntries(
    p.filter(x => x.type !== 'literal')
      .map(x => [x.type, Number(x.value)])
  );
}

// =======================================
// 予約日判定
// =======================================

function dateDiff(text, n) {
  if (/明後日|あさって/.test(text)) return 2;
  if (/今日|本日|当日|今から|これから/.test(text)) return 0;
  if (/明日|あした|翌日/.test(text)) return 1;

  let m = text.match(
    /(20\d{2})[年/.-]\s*(\d{1,2})[月/.-]\s*(\d{1,2})日?/
  );

  let y, month, day;
  const yearGiven = !!m;

  if (m) {
    y = +m[1];
    month = +m[2];
    day = +m[3];
  } else {
    m =
      text.match(/(\d{1,2})月\s*(\d{1,2})日/) ||
      text.match(/(?:^|\D)(\d{1,2})\/(\d{1,2})(?!\d)/);

    if (!m) return null;

    y = n.year;
    month = +m[1];
    day = +m[2];
  }

  const valid = yr => {
    const d = new Date(Date.UTC(yr, month - 1, day));

    return (
      d.getUTCFullYear() === yr &&
      d.getUTCMonth() + 1 === month &&
      d.getUTCDate() === day
    );
  };

  if (!valid(y)) return 'invalid';

  const today = Date.UTC(
    n.year,
    n.month - 1,
    n.day
  );

  let days = Math.round(
    (
      Date.UTC(y, month - 1, day) - today
    ) / 86400000
  );

  if (!yearGiven && days < 0) {
    y++;

    if (!valid(y)) return 'invalid';

    days = Math.round(
      (
        Date.UTC(y, month - 1, day) - today
      ) / 86400000
    );
  }

  return days;
}

// =======================================
// 団体予約判定
// =======================================

function isGroup(s) {
  return (
    /団体|修学旅行|旅行会社|貸切|大人数/.test(s) ||
    [...s.matchAll(/(\d{1,3})\s*(名|人)(?!前)/g)]
      .some(m => +m[1] >= 20)
  );
}

// =======================================
// 予約希望判定
// =======================================

function isBooking(s) {
  return (
    /予約したい|予約希望|予約をお願い|予約お願いします|予約を取りたい|申し込[みむ]|申込みたい|空き状況|空いていますか|空いてる|予約できますか/.test(s) &&
    !/キャンセル|規定|規約|ポリシー|予約方法|予約は必要|予約必須/.test(s)
  );
}

// =======================================
// キャンセル規定の質問
// =======================================

function cancellationQuestion(s) {
  return (
    /キャンセル|取消|取り消し/.test(s) &&
    /規定|規約|ポリシー|料金|料|いつから|何日前|教えて|ある/.test(s) &&
    !/キャンセルしたい|キャンセルして|取り消したい/.test(s)
  );
}

// =======================================
// 実際のキャンセル・変更依頼
// =======================================

function cancellationAction(s) {
  return /キャンセルしたい|キャンセルして|取り消したい|予約を取り消|予約変更したい|日程変更したい|人数変更したい|予約を変更したい/.test(s);
}

// =======================================
// 予約フォーム・電話案内
// =======================================

function bookingGuide(days, n) {
  if (days === 'invalid') {
    return 'ご希望日を確認できませんでした。「10月28日」などとお送りください。';
  }

  if (days === null) {
    return 'ご希望日はいつでしょうか？「今日」「明日」「10月28日」などとお知らせください。';
  }

  if (days < 0) {
    return '過去の日付のため、ご希望日を改めてお知らせください。';
  }

  const phoneOnly =
    (
      days === 0 &&
      !(SAME_DAY_FORM && n.hour < 9)
    ) ||
    (
      days === 1 &&
      n.hour >= 17
    );

  if (phoneOnly) {
    return (
      '当日・直前のご予約は、お電話でお問い合わせください。\n' +
      info.basicInfo.phone +
      '\n※LINEでは予約は確定しません。'
    );
  }

  return (
    'Web予約フォームからお申し込みください。\n' +
    info.reservation.url +
    '\n※現在はテストフォームです。正式な予約確定通知をご確認ください。'
  );
}

// =======================================
// 質問に必要な店舗情報を抽出
// =======================================

function relevantInfo(s, messages) {
  const context = (
    messages.slice(-3)
      .map(m => m.content)
      .join(' ') +
    ' ' +
    s
  ).slice(-1300);

  const data = {
    basicInfo: info.basicInfo,
    reservation: info.reservation,

    policies: {
      cancellationUrl: info.policies.cancellationUrl,
      observation: info.policies.observation,
      children: info.policies.children,
      pets: info.policies.pets,
      toppings: info.policies.toppings,
      groupSplit: info.policies.groupSplit
    }
  };

  if (
    /体験|料金|いくら|価格|セット|麺|ほうとう|そば|うどん|ラーメン|七味|すりだね/.test(context)
  ) {
    data.experiencePrices = info.experiencePrices;
  }

  if (
    /藍染|染め|所要時間|何分|何時間/.test(context)
  ) {
    data.dyeing = info.dyeing;
  }

  if (
    /所要時間|時間かか|麺作り/.test(context)
  ) {
    data.other = {
      experiences: info.other?.experiences
    };
  }

  if (
    /スパイス|たい焼き|鯛焼き|ふりかけ|コーラ|餅/.test(context)
  ) {
    data.cafeExperiences = info.cafeExperiences;
  }

  if (
    /人数|何人|別々|分かれ|グループ|団体/.test(context)
  ) {
    data.capacity = info.capacity;
  }

  if (
    /アレルギー|ヴィーガン|見学|支払|子供|こども|撮影/.test(context)
  ) {
    data.policies = info.policies;
  }

  return data;
}

// =======================================
// 会話履歴を取得
// =======================================

function getHistory(id) {
  const h = history.get(id);

  return h && h.expires > Date.now()
    ? h.messages
    : [];
}

// =======================================
// 会話履歴の保存
// =======================================

function saveHistory(id, messages) {
  let h = messages.slice(-MAX_MESSAGES);

  while (
    h.length &&
    h.reduce(
      (n, m) => n + m.content.length,
      0
    ) > MAX_HISTORY_CHARS
  ) {
    h.shift();
  }

  history.set(id, {
    messages: h,
    expires: Date.now() + TTL
  });
}

// =======================================
// 絶対に守る店舗ルール
// =======================================

function fixedFacts(s) {
  const facts = [];

  const push = v => {
    if (v && !facts.includes(v)) {
      facts.push(v);
    }
  };

  const dye =
    /藍染|あいぞめ|墨染|ワイン染|染め物|染物/.test(s);

  const duration =
    /所要時間|何時間|何分|時間かか|どのくらいかか|どれくらいかか/.test(s);

  // 犬の同伴
  if (
    /犬|ペット|ワンちゃん|わんこ/.test(s) &&
    /連れ|同伴|入れ|大丈夫|可能|いい|でき|ケージ|ゲージ/.test(s)
  ) {
    push(info.policies.pets);
  }

  // 全麺体験へのトッピング追加
  if (
    /ワインビーフ|トッピング/.test(s) &&
    /つけ|付け|追加|のせ|乗せ|でき|可能|そば|うどん|ほうとう|ラーメン/.test(s)
  ) {
    push(info.policies.toppings);
  }

  // 別々の体験
  if (
    /別々|分かれて|分けて|異なる体験|違う体験/.test(s) &&
    /体験|ほうとう|そば|うどん|麺/.test(s)
  ) {
    push(info.policies.groupSplit);
  }

  // 見学
  if (
    /見学|見るだけ|大人は参加しない|子供だけ|子どもだけ/.test(s)
  ) {
    push(info.policies.observation);
  }

  // キャンセル規定
  if (cancellationQuestion(s)) {
    push(
      'キャンセル規定はこちらです。\n' +
      info.policies.cancellationUrl
    );
  }

  // 藍染の所要時間
  if (dye && duration) {
    if (
      /セット|麺作り|ほうとう|うどん|そば|ラーメン/.test(s)
    ) {
      push(
        '麺作り＋藍染のセットは食事込みで約120〜150分です。藍染のみは約60〜90分です。'
      );
    } else {
      push(
        '藍染単体は約60〜90分、麺作りとのセットは食事込みで約120〜150分です。'
      );
    }
  } else if (
    dye &&
    /やって|できますか|できる|ある|実施/.test(s)
  ) {
    push(
      'はい、藍染体験を実施しています。墨染め・甲州ワイン染めもあります。'
    );
  }

  // 駐車場
  if (/駐車場|駐車|パーキング/.test(s)) {
    push(info.basicInfo.parking);
  }

  return facts;
}

// =======================================
// 直前の会話も考慮した固定回答
// =======================================

function knownFixed(s, old) {
  const context =
    old.slice(-4)
      .map(x => x.content)
      .join(' ') +
    ' ' +
    s;

  // 直前に藍染を話していた場合
  if (
    /^(所要時間|何分|何時間|どのくらいかかる|どれくらいかかる)[はって？?\s]*$/.test(s) &&
    /藍染|染め物|染物/.test(context)
  ) {
    return [
      /セット|麺作り|ほうとう|うどん|そば/.test(context)
        ? '麺作り＋藍染セットは食事込み約120〜150分、藍染単体は約60〜90分です。'
        : '藍染単体は約60〜90分です。'
    ];
  }

  return fixedFacts(s);
}

// =======================================
// AIへのシステムプロンプト
// =======================================

function systemPrompt(data) {
  return `
あなたは「高菜先生の郷土料理体験教室 富士家」の
LINE問い合わせ担当AIです。

【基本方針】
・丁寧で親切な敬語で回答してください。
・質問された内容すべてに回答してください。
・原則として簡潔に回答してください。
・お客様が聞いていない情報を長々と説明しないでください。
・原則として180文字程度以内にしてください。
・わかっていることについては、はっきり回答してください。

【予約について】
・LINE自体では予約確定を行いません。
・予約希望と通常の質問を区別してください。
・予約希望と別の質問が混ざっている場合は、
  別の質問にも回答してください。
・空き状況を推測しないでください。
・予約希望日は必要な場合のみ確認してください。
・現在の予約フォームはテスト用です。

【キャンセルについて】
・キャンセル規定の質問と、
  実際のキャンセル希望を区別してください。
・規定を聞かれただけなら規約を案内してください。
・不必要に電話やメールを案内しないでください。

【体験について】
・藍染、墨染め、甲州ワイン染めは実施しています。
・藍染単体は約60〜90分です。
・麺作り＋藍染セットは食事込み約120〜150分です。
・犬はケージ（ゲージ）に入れれば同伴可能です。
・ワインビーフを含むすべてのトッピングは、
  すべての麺作り体験に追加可能です。
・同じグループで別々の体験に参加できます。
・例えば、ほうとう5名とうどん5名も可能です。
・見学のみの利用は原則できません。

【会話履歴】
・直前の会話を理解してください。
・「それ」「所要時間は？」などの質問は、
  直前の話題について回答してください。
・既に聞いた内容を繰り返し質問しないでください。

【禁止事項】
・存在しない体験や料金を作らないでください。
・確認できない予約の空き状況を断定しないでください。
・アレルギーへの安全性を保証しないでください。
・店舗情報にある内容を勝手に否定しないでください。
・不明な場合だけスタッフへの確認を案内してください。

【店舗情報】
${JSON.stringify(data)}
`;
}

// =======================================
// OpenAI API呼び出し
// =======================================

async function askAI(id, question, old) {
  if (!OPENAI_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not configured'
    );
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    18000
  );

  try {
    const response = await fetch(
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
            {
              role: 'system',
              content: systemPrompt(
                relevantInfo(question, old)
              )
            },
            ...old,
            {
              role: 'user',
              content: question
            }
          ]
        })
      }
    );

    if (!response.ok) {
      throw new Error(
        `OpenAI HTTP ${response.status}: ${
          (await response.text()).slice(0, 150)
        }`
      );
    }

    const obj = await response.json();

    // API使用量
    const u = obj.usage || {};

    const cached =
      u.prompt_tokens_details?.cached_tokens || 0;

    usageTotal.calls++;
    usageTotal.input += u.prompt_tokens || 0;
    usageTotal.output += u.completion_tokens || 0;
    usageTotal.cached += cached;

    // Renderのログに記録
    console.log(
      'api_usage',
      JSON.stringify({
        model: MODEL,
        input: u.prompt_tokens || 0,
        output: u.completion_tokens || 0,
        cached,
        totalCalls: usageTotal.calls,
        totalInput: usageTotal.input,
        totalOutput: usageTotal.output
      })
    );

    return (
      obj.choices?.[0]?.message?.content?.trim() ||
      '詳しくはスタッフへお問い合わせください。'
    );

  } finally {
    clearTimeout(timer);
  }
}

// =======================================
// 返信内容の作成
// =======================================


async function respond(text, id) {
  const old = getHistory(id);

  // 予約変更・キャンセル受付を優先
  const reservationAnswer = await reservationFlow.handle(text, id);

  if (reservationAnswer !== null) {
    saveHistory(id, [
      ...old,
      {
        role: 'user',
        content: text
      },
      {
        role: 'assistant',
        content: reservationAnswer
      }
    ]);

    return reservationAnswer;
  }
  const newBookingAnswer = await newBookingFlow.handle(text, id);

  if (newBookingAnswer !== null) {
    saveHistory(id, [
      ...old,
      {
        role: 'user',
        content: text
      },
      {
        role: 'assistant',
        content: newBookingAnswer
      }
    ]);

    return newBookingAnswer;
  }
  const now = nowJST();


  const facts = knownFixed(text, old);
  const date = dateDiff(text, now);

  const booking = isBooking(text);
  const group = isGroup(text);

  const waiting =
    (pendingDate.get(id) || 0) > Date.now();

  let result;

  // 予約希望日への返信
  if (
    waiting &&
    date !== null &&
    !booking &&
    !facts.length
  ) {
    result = bookingGuide(date, now);
    pendingDate.delete(id);

  // 旧予約フォーム
  } else if (
    /【予約リクエストフォーム】/.test(text)
  ) {
    result =
      'LINEの旧予約メッセージでは予約確定できません。Web予約フォームをご利用ください。';

  // 実際の予約変更・キャンセル
  } else if (cancellationAction(text)) {
    result =
      'ご予約の変更・キャンセルはスタッフが確認いたします。\n' +
      info.basicInfo.email +
      '\n規約：' +
      info.policies.cancellationUrl;

  // アレルギー
  } else if (
    /アレルギー|アナフィラキシー/.test(text)
  ) {
    result =
      info.policies.allergy +
      '\n個別の安全確認はスタッフへご相談ください。';

  // 団体予約
  } else if (group && booking) {
    result = [
      ...facts,
      '20名以上の団体予約はスタッフが承ります。\n' +
      '電話：' +
      info.basicInfo.phone +
      '\nメール：' +
      info.basicInfo.email
    ].join('\n\n');

  // 通常の予約希望
  } else if (booking) {
    if (date === null) {
      pendingDate.set(
        id,
        Date.now() + TTL
      );
    } else {
      pendingDate.delete(id);
    }

    // 予約に含まれる別の質問を抽出
    const stripped = text.replace(
      /予約したいんですが|予約したいのですが|予約したいです|予約希望です|予約をお願いします|予約できますか/g,
      ''
    ).trim();

    const otherQuestion =
      /見学|犬|ペット|時間|料金|いくら|トッピング|別々|分かれ|可能|できますか|？|\?/.test(stripped);

    let answers = facts;

    if (
      otherQuestion &&
      !answers.length
    ) {
      answers = [
        await askAI(
          id,
          '予約案内は不要です。次の文章にある予約以外の質問だけ答えてください：' +
          stripped,
          old
        )
      ];
    }

    result = [
      ...answers,
      bookingGuide(date, now)
    ].join('\n\n');

  // 明確な店舗ルールで回答
  } else if (facts.length) {
    result = facts.join('\n\n');

  // その他はChatGPTで回答
  } else {
    result = await askAI(
      id,
      text,
      old
    );
  }

  // 履歴を保存
  saveHistory(
    id,
    [
      ...old,
      {
        role: 'user',
        content: text
      },
      {
        role: 'assistant',
        content: result
      }
    ]
  );

  return result;
}

// =======================================
// LINE署名検証
// =======================================

function verify(raw, signature) {
  if (
    !SECRET ||
    !signature ||
    !Buffer.isBuffer(raw)
  ) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(raw)
    .digest('base64');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

// =======================================
// LINEへ返信
// =======================================

async function send(replyToken, text) {
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
            text: text.slice(0, 4900)
          }
        ]
      })
    }
  );

  if (!r.ok) {
    throw new Error(
      `LINE HTTP ${r.status}: ${
        (await r.text()).slice(0, 150)
      }`
    );
  }
}

// =======================================
// サーバー起動確認
// =======================================

app.get('/', (req, res) => {
  res.json({
    ok: true,
    botEnabled: ENABLED
  });
});

// =======================================
// LINE Webhook
// =======================================

app.post(
  '/webhook',

  express.raw({
    type: 'application/json',
    limit: '1mb'
  }),

  (req, res) => {
    // LINE署名を検証
    if (
      !verify(
        req.body,
        req.get('x-line-signature')
      )
    ) {
      return res.sendStatus(401);
    }

    let body;

    try {
      body = JSON.parse(
        req.body.toString('utf8')
      );
    } catch {
      return res.sendStatus(400);
    }

    // LINEへ先にHTTP応答
    res.sendStatus(200);

    if (!ENABLED) return;

    for (const event of body.events || []) {
      if (
        event.type !== 'message' ||
        event.message?.type !== 'text' ||
        !event.replyToken
      ) {
        continue;
      }

      const key =
        event.webhookEventId ||
        event.message.id;

      // 重複イベント防止
      if (
        key &&
        (seen.get(key) || 0) > Date.now()
      ) {
        continue;
      }

      if (key) {
        seen.set(
          key,
          Date.now() + TTL
        );
      }

      const id =
        event.source?.userId ||
        event.source?.groupId ||
        event.source?.roomId;

      if (!id) continue;

      // 同一利用者のメッセージを順次処理
      const previous =
        queues.get(id) ||
        Promise.resolve();

      const task = previous
        .catch(() => {})
        .then(async () => {
          try {
           console.log('[LINE DEBUG] message received', {
  messageLength: event.message.text.length
});

const answer = await respond(
  event.message.text.trim(),
  id
);

console.log('[LINE DEBUG] response generated', {
  responseLength: answer.length
});

            await send(
              event.replyToken,
              answer
            );

          } catch (e) {
            console.error(
              'reply_error',
              e.message
            );
          }
        });

      queues.set(id, task);

      task.finally(() => {
        if (queues.get(id) === task) {
          queues.delete(id);
        }
      });
    }
  }
);

// =======================================
// 期限切れデータを削除
// =======================================

setInterval(() => {
  const now = Date.now();

  for (const [id, h] of history) {
    if (h.expires < now) {
      history.delete(id);
    }
  }

  for (const [id, expiry] of pendingDate) {
    if (expiry < now) {
      pendingDate.delete(id);
    }
  }

  for (const [id, expiry] of seen) {
    if (expiry < now) {
      seen.delete(id);
    }
  }

}, 600000).unref();

// =======================================
// サーバー起動
// =======================================

app.listen(PORT, () => {
  console.log(
    `Fujiya bot v4 ready on port ${PORT}; enabled=${ENABLED}`
  );
});
