
# 富士家 LINE AI問い合わせボット v2

## 概要

富士家の公式LINEで、お客様からの問い合わせに
AIが自動返信するシステムです。

LINEは問い合わせ窓口として運用し、
体験予約は原則Web予約フォームで受け付けます。

## システム構成

- LINE Messaging API
- Render（サーバー）
- GitHub（コード管理）
- OpenAI API（AI回答）
- storeInfo.json（店舗情報）

## 主な機能

### 1. AI問い合わせ対応
- 体験内容・料金の案内
- 営業時間の案内
- 駐車場・アクセス案内
- 子どもの参加条件
- その他のよくある質問
- 日本語・外国語での回答

### 2. 予約の振り分け

通常の予約：
Web予約フォームへ案内

当日予約：
原則電話へ案内

当日朝9時まで：
設定変更によりフォーム案内が可能

20名以上：
団体予約としてスタッフへ案内

予約変更・キャンセル：
スタッフ対応

### 3. 誤回答防止

- storeInfo.jsonをAIに渡す
- 不明な料金は推測しない
- 予約の空き状況を勝手に判断しない
- AIが予約確定を行わない
- アレルギーについて安全性を保証しない

## ファイル構成

index.js
storeInfo.json
package.json
.gitignore
.env.example
README.md

## Render設定

Build Command:
npm install

Start Command:
npm start

Environment Variables:

CHANNEL_SECRET
CHANNEL_ACCESS_TOKEN
OPENAI_API_KEY
OPENAI_MODEL
BOT_ENABLED
SAME_DAY_FORM_UNTIL_9

## 自動返信の切り替え

BOT_ENABLED=false
自動返信停止

BOT_ENABLED=true
自動返信有効

※LINE公式アカウント側のWebhookも
有効である必要があります。

## 当日予約の設定

SAME_DAY_FORM_UNTIL_9=false
当日は電話案内

SAME_DAY_FORM_UNTIL_9=true
当日朝9時まではWebフォームを案内

注意：
Webフォーム自体が当日予約に対応してから
trueに変更してください。

## 予約フォーム

https://houtoutaiken.lp-web.net/contact/reserve/test.html

現在はテスト用URLです。
本番公開後にstoreInfo.jsonを更新します。

## 店舗情報の変更方法

営業時間・料金・体験内容・予約ルールなどは
storeInfo.jsonを編集します。

GitHubに保存すると、Renderの自動デプロイが
有効な場合はサーバーにも反映されます。

## セキュリティ

APIキー・アクセストークンをGitHubに公開しない。

秘密情報はRenderのEnvironmentに保存する。

LINE Webhookの署名検証を行う。

## 本番公開前の確認

1. GitHubのファイルを登録
2. RenderでWeb Serviceを作成
3. Environment Variablesを設定
4. BOT_ENABLED=falseで起動確認
5. LINE DevelopersでWebhook URLを設定
6. テスト用LINEで動作確認
7. 予約フォームを本番公開
8. BOT_ENABLED=trueに変更
9. LINE公式アカウント側のWebhookを有効化
10. 実際の返信内容を確認

## 注意事項

現在の会話履歴は予約日確認用の一時メモリのみです。

Renderが再起動するとメモリは消えます。

複数のRenderインスタンス間で
会話履歴は共有されません。

今後、必要に応じてデータベース連携や
問い合わせ履歴管理を追加できます。
