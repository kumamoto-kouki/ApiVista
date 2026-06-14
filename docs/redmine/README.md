# Redmine (ローカル環境)

ApiVistaプロジェクトの概要・目的・技術スタック・導入方法を関係者向けに共有するための、ローカルRedmine環境です。Docker Composeでこのリポジトリ内に構成しています。

## 起動方法

1. `.env.example` を `.env` にコピーし、値を設定する

   ```bash
   cp .env.example .env
   # REDMINE_SECRET_KEY_BASE は以下で生成した値を設定する
   openssl rand -hex 32
   ```

2. コンテナを起動する

   ```bash
   docker compose up -d
   ```

3. ブラウザで `http://localhost:3001` にアクセスする
   - 初回起動はデータベースマイグレーションのため数十秒かかる場合があります

## 初回ログイン

- ユーザー名: `admin`
- パスワード: `admin`
- 初回ログイン時にパスワード変更が必須です

## プロジェクトの作成

1. 管理メニュー → 「プロジェクト」→「新しいプロジェクト」
2. プロジェクト名: `ApiVista`
3. 作成後、プロジェクトの「Wiki」モジュールを有効化(プロジェクト設定 → モジュール → Wiki にチェック)
4. [project-overview.md](./project-overview.md) の内容をWikiの「概要」ページに貼り付ける

## 停止・データ削除

```bash
# 停止(データは保持)
docker compose down

# 停止 + データ削除(ボリュームも削除)
docker compose down -v
```
