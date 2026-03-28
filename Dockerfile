FROM node:20-slim

WORKDIR /app

# git はサブモジュールの取得や依存で必要になる場合があります
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# package.json および lock ファイルをコピーして依存をインストール
COPY package*.json ./
RUN npm install

# ソースコード全体をコピー
COPY . .

# gemini-cli サブモジュールのビルド時に生じるシンボリックリンク・バンドルエラーを回避
RUN cd gemini-cli && \
    rm -rf docs && \
    npm install && npm run build

# アプリケーションのポートを公開 (デフォルト: 8080)
EXPOSE 8080

# 認証時の強制ブラウザ起動を抑制する環境変数。これによりターミナルにURLが出力され手動認証が可能になる
ENV NO_BROWSER=true

# コンテナ起動コマンド。デフォルトで npm run dev なのでこのままにしておく
CMD ["npm", "run", "dev"]
