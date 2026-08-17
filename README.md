# 買取店マーケティングシステム（MVP / Phase 1）

店舗が「今日の訴求（キャンペーン）」を入力するだけで、チャネル別の投稿記事と縦型ショート動画を生成し、
末尾に【この店に今すぐ査定】のQR/URLを付けて店舗独自の申込フォームへ誘導する集客パイプライン。

業態非依存の設計。フォームの `kind` を切り替えれば買取以外（相談/アンケート/申込）へ転用可能。

## セットアップ

```bash
npm install
cp .env.example .env   # 必要なら ANTHROPIC_API_KEY を設定（無くてもテンプレ生成で動く）
npm run seed           # 業態マスタ（買取＝古物商許可）を投入
npm start              # http://localhost:5300
```

- Claude を使う場合は `.env` に `ANTHROPIC_API_KEY`（sk-ant-…）を設定。
- ⚠ Computer(開発補助)のシェルから起動する時は `ANTHROPIC_BASE_URL` を剥がして起動:
  `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN node ... src/server/index.js`
  （本番/通常のデスクトップ起動では不要）

## 最小ループ（画面）

1. 店舗を登録（業態選択 → 必須ライセンス＝古物商許可番号を検証）
2. キャンペーンを入力
3. 査定フォーム＋QRを発行（CTA先になる公開URL `/f/<slug>`）
4. 記事＆②スライドショー動画を生成 → プレビュー → 承認（MVPはコピー扱い）

## 構成

```
src/
  db.js               データ層（node:sqlite。将来 Supabase へ差し替え）
  seed.js             業態マスタ投入
  generate/
    article.js        チャネル別記事生成（Claude + フォールバック）
    video.js          ②スライドショー動画（ffmpeg, 9:16）
    qr.js             QRコード生成
  server/index.js     Express サーバ（API + 公開フォーム）
public/               管理画面（index.html / app.js）
data/                 SQLite DB と生成物（gitignore）
```

## 現状のMVP範囲と今後（詳細は設計書）

- ②動画は「単色スライド＋末尾QRカット」の最小形。**Ken Burns / テロップ焼き込み / BGM は後続**。
- 配信は **承認＝コピー扱い**。SNS公式API配信（IG/FB/X/…）は後続フェーズ。
- **① アップロード動画のAI編集＋看板ロゴ/素材の静止画抽出転用は Phase 2（AI動画のキモ）で必ず実装**。

設計書: チャット workdir の `買取店マーケティングシステム設計書.md`（全11章）を参照。
