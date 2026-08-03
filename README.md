# CIZA 補助金・支援制度LP

設備投資・新規事業に関する補助金、税制優遇、認定制度、融資などの候補を整理し、30分無料Web診断への問い合わせを生み出すためのプロトタイプです。

## 問い合わせ運用

- 通知先メール: `info@ciza.co.jp`
- 日程調整、制度判断、面談、回答、提案は当面すべて手動
- 自動診断・自動回答は行わない

## フォーム設定

`src/pages/consultation/index.astro` は、環境変数 `PUBLIC_CONTACT_FORM_ENDPOINT` に設定したフォーム送信先へPOSTします。

本番公開時に、利用するフォーム送信サービス側で通知先を `info@ciza.co.jp` に設定してください。APIキーや秘密情報はGitHubに直接保存せず、VercelのEnvironment Variablesへ設定します。

フォーム送信先が未設定の場合、送信ボタンは無効になります。

## 開発

```bash
npm install
npm run dev
```

## ビルド

```bash
npm run build
```
