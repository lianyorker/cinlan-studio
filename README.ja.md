# Cinlan Studio

Cinlan Studio は、画像生成・画像編集・構造化テキスト生成・永続的な制作履歴を提供する AI 制作ワークスペースです。`0.2.6` は Next.js BFF、PostgreSQL Creative Core、独立 Worker で構成されます。

[English](./README.md) | [简体中文](./README.zh.md) | **日本語** | [한국어](./README.ko.md)

## 主な機能

- Text-to-image、単一画像編集、最大 4 枚の参照画像入力。
- 複数出力、個別キャンセル、再試行、更新後の復旧、永続化されたイベント。
- Markdown/GFM の見出し、リスト、表、リンク、コードブロック表示。
- スクロール可能なテキスト履歴と、埋め込みページでも動作する結果コピー。
- 元画像のストリーミング、WebP サムネイル、ETag、Owner 単位のアクセス分離。
- チェッカーボードや単純背景だけを除去し、文字やボタンを保持した実アルファ PNG を生成。
- Sub2API ログイン、2FA、埋め込み SSO、サーバー管理の owner/group 認証情報。

## 開発

Node.js 22 または 24 と PostgreSQL 14 以降が必要です。

```bash
npm ci
npm run db:migrate
npm run dev
```

本番環境では `CREATIVE_IN_PROCESS_WORKER=false` を設定し、`npm run worker:creative` を独立サービスとして実行します。詳細は [deployment guide](./deploy/DEPLOY.md) を参照してください。

## License

[MIT](./LICENSE)
