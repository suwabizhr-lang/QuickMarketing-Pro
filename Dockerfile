# 買取店マーケ（QuickMarketing-Pro）本番イメージ。
# Node 20 + 日本語フォント(Noto CJK) を含む。動画はffmpeg-static(npm同梱)、画像はsharpを使う。
# telop.js は 'Yu Gothic','Meiryo','Noto Sans JP',sans-serif の順でフォールバック → Linuxでは Noto CJK が効く。
FROM node:20-slim

# 日本語フォント（動画テロップ用）+ fontconfig（設定ファイル/fc-cache）+ 最小ライブラリ。
# fontconfig が無いと "Cannot load default config file" が出て sharp/ffmpeg のテロップ描画が不安定になる。
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-noto-cjk \
      fontconfig \
      ca-certificates \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# 依存インストール（package*.json だけ先にコピーしてキャッシュを効かせる）
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# アプリ本体
COPY . .

# 実行時ポート（Renderは PORT を注入。既定5300）
ENV NODE_ENV=production
EXPOSE 5300

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server/index.js"]
