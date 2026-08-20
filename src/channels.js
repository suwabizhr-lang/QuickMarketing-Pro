// 投稿先ドライバ定義。将来の追加開発をここに集約する「単一の真実」。
// 各ドライバ = 投稿先の種別。UIはこの定義を読んで登録フォームを自動描画する。
//   auto : { supported, status, fields[] }  … 自動投稿の可否と、自動化に必要な入力項目
//   manual : { fields[] }                    … 手動投稿に必要な情報の入力項目
// fields: { key, label, type(text/password/url/textarea/select), required, hint, options? }
// status: 'ready'(実装済/即投稿可) | 'planned'(項目だけ先に用意・投稿処理は今後) | 'unsupported'(自動不可)
//
// 追加開発の指針:
//  - 新しい投稿先 → このファイルに1エントリ足す（UIは自動対応）。
//  - 自動投稿処理の実体は src/publish/*.js に driver.key ごとのハンドラを足し、status を 'ready' に上げる。

export const CHANNEL_DRIVERS = {
  // --- 自動化しやすい（先に着手する）グループ ---
  line: {
    label: 'LINE公式アカウント', order: 1,
    auto: {
      supported: true, status: 'ready',
      note: 'Messaging API で友だちへ一斉配信（ブロードキャスト）します。',
      fields: [
        { key: 'channel_access_token', label: 'チャネルアクセストークン（長期）', type: 'password', required: true, hint: 'LINE Developers > Messaging API' },
      ],
    },
    manual: {
      fields: [
        { key: 'account_url', label: '公式アカウントのURL/ID', type: 'text', required: false, hint: '手動投稿時の確認用' },
      ],
    },
  },
  webhook: {
    label: '汎用Webhook / 自社システム', order: 2,
    auto: {
      supported: true, status: 'ready',
      note: '指定URLへ本文をPOSTします。WordPress中継やGAS、Zapier等に汎用的に使えます。',
      fields: [
        { key: 'webhook_url', label: 'Webhook URL', type: 'url', required: true, hint: 'POSTで {store,title,body} を送信' },
        { key: 'secret', label: '共有シークレット（任意）', type: 'password', required: false, hint: 'ヘッダ X-Kaitori-Secret で送信' },
      ],
    },
    manual: { fields: [] },
  },
  wordpress: {
    label: '自社HP / ブログ（WordPress）', order: 3,
    auto: {
      supported: true, status: 'ready',
      note: 'WordPress REST API + アプリケーションパスワードで下書き/公開投稿。WP管理画面 ユーザー>プロフィール>アプリケーションパスワード で発行。',
      fields: [
        { key: 'site_url', label: 'サイトURL', type: 'url', required: true, hint: 'https://example.com（WordPressのURL）' },
        { key: 'username', label: 'ユーザー名', type: 'text', required: true },
        { key: 'app_password', label: 'アプリケーションパスワード', type: 'password', required: true, hint: 'WPの「アプリケーションパスワード」で発行（ログインPWとは別）' },
        { key: 'status', label: '投稿ステータス', type: 'select', required: false, options: ['draft', 'publish'], hint: '既定は下書き（安全）。公開なら publish' },
      ],
    },
    manual: {
      fields: [
        { key: 'admin_url', label: '管理画面URL', type: 'url', required: false, hint: '手動投稿時に開く先' },
      ],
    },
  },

  // --- 準備（審査/OAuth）が要るグループ ---
  gbp: {
    label: 'Googleビジネスプロフィール', order: 4,
    auto: {
      supported: true, status: 'planned',
      note: 'Business Profile API での投稿（Google Cloud申請＋OAuthが必要。実装予定）。',
      fields: [
        { key: 'account_id', label: 'アカウントID', type: 'text', required: false },
        { key: 'location_id', label: 'ロケーションID', type: 'text', required: false },
        { key: 'oauth_note', label: 'OAuth接続', type: 'text', required: false, hint: '接続フローは今後追加' },
      ],
    },
    manual: {
      fields: [
        { key: 'profile_url', label: 'プロフィール管理URL', type: 'url', required: false },
      ],
    },
  },
  instagram: {
    label: 'Instagram', order: 5,
    auto: {
      supported: true, status: 'planned',
      note: 'Content Publishing API（プロ垢＋FBページ連携＋アプリ審査＋画像/動画の公開URLが必要。実装予定）。',
      fields: [
        { key: 'ig_user_id', label: 'IGビジネスアカウントID', type: 'text', required: false },
        { key: 'page_access_token', label: 'ページアクセストークン', type: 'password', required: false },
      ],
    },
    manual: {
      fields: [
        { key: 'account_url', label: 'プロフィールURL', type: 'url', required: false },
      ],
    },
  },
  facebook: {
    label: 'Facebookページ', order: 6,
    auto: {
      supported: true, status: 'planned',
      note: 'Graph API でページ投稿（アプリ審査＋ページトークンが必要。実装予定）。',
      fields: [
        { key: 'page_id', label: 'ページID', type: 'text', required: false },
        { key: 'page_access_token', label: 'ページアクセストークン', type: 'password', required: false },
      ],
    },
    manual: {
      fields: [
        { key: 'page_url', label: 'ページURL', type: 'url', required: false },
      ],
    },
  },
  x: {
    label: 'X（旧Twitter）', order: 7,
    auto: {
      supported: false, status: 'unsupported',
      note: 'API有料化により自動投稿は現状見送り。手動投稿で運用します。',
      fields: [],
    },
    manual: {
      fields: [
        { key: 'account_url', label: 'アカウントURL', type: 'url', required: false },
      ],
    },
  },

  // --- 手動投稿プリセット（自動APIは無い/未対応。生成物をコピーして各媒体へ人が投稿。投稿状態は記録できる） ---
  // 共通の手動フィールド: 投稿/管理URL + メモ（手順やアカウント名）。
  threads: { label: 'Threads', order: 10, ...manualOnly('プロフィール/投稿URL') },
  tiktok: { label: 'TikTok', order: 11, ...manualOnly('アカウントURL') },
  youtube: { label: 'YouTube（Shorts等）', order: 12, ...manualOnly('チャンネルURL') },
  pinterest: { label: 'Pinterest', order: 13, ...manualOnly('プロフィールURL') },
  hatena: { label: 'はてなブログ', order: 14, ...manualOnly('ブログURL') },
  ameba: { label: 'Amebaブログ', order: 15, ...manualOnly('ブログURL') },
  note: { label: 'note', order: 16, ...manualOnly('プロフィール/記事URL') },
  wix: { label: 'Wix（ブログ）', order: 17, ...manualOnly('サイト管理URL') },
  jimdo: { label: 'Jimdo', order: 18, ...manualOnly('サイト管理URL') },
  peraichi: { label: 'ペライチ', order: 19, ...manualOnly('サイト管理URL') },
  goo: { label: 'gooブログ', order: 20, ...manualOnly('ブログURL') },
  livedoor: { label: 'livedoorブログ', order: 21, ...manualOnly('ブログURL') },
  static_site: { label: '静的HP（手動更新）', order: 22, ...manualOnly('サイトURL') },

  // 汎用: どんな媒体でもユーザーが自由に登録できる受け皿。
  custom: {
    label: 'その他（自由に追加）', order: 99,
    auto: { supported: false, status: 'unsupported', note: '自動投稿はしません。生成物をコピーして手動で投稿する先として管理します。', fields: [] },
    manual: {
      fields: [
        { key: 'media_name', label: '媒体名', type: 'text', required: true, hint: '例: 地域ポータル / 商店会サイト など' },
        { key: 'post_url', label: '投稿/管理画面URL', type: 'url', required: false, hint: '手動投稿時に開く先' },
        { key: 'note', label: 'メモ（投稿手順・アカウント等）', type: 'textarea', required: false },
      ],
    },
  },
};

// 手動投稿プリセットの共通定義を作るヘルパ（自動なし・URL＋メモ）。
function manualOnly(urlLabel) {
  return {
    auto: { supported: false, status: 'unsupported', note: '自動投稿APIは未対応。生成物をコピーして手動で投稿します（投稿状態は記録できます）。', fields: [] },
    manual: {
      fields: [
        { key: 'account_url', label: urlLabel || 'アカウント/投稿URL', type: 'url', required: false, hint: '手動投稿時に開く先' },
        { key: 'note', label: 'メモ（投稿手順・アカウント等）', type: 'textarea', required: false },
      ],
    },
  };
}

// 記事生成の CHANNEL_PROFILES と対応するキー（生成→投稿でキーを揃える）。
// blog/homepage は wordpress ドライバで扱う（生成キーとの対応表）。
export const GENERATE_TO_DRIVER = {
  instagram: 'instagram', x: 'x', facebook: 'facebook',
  blog: 'wordpress', homepage: 'wordpress', gbp: 'gbp', line: 'line',
};

// UI用: ドライバ一覧（order順）。トークン等の値は返さない（定義のみ）。
export function listChannelDrivers() {
  return Object.entries(CHANNEL_DRIVERS)
    .sort((a, b) => (a[1].order || 99) - (b[1].order || 99))
    .map(([key, d]) => ({ key, label: d.label, auto: d.auto, manual: d.manual }));
}
export function getChannelDriver(key) { return CHANNEL_DRIVERS[key] || null; }
