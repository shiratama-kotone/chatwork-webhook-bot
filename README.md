# Chatwork Webhook Bot for Render

Google Apps ScriptベースのChatwork BotをRender用のWebhookアプリケーションに変換したものです。

## 機能

- おみくじ機能
- Wikipedia検索
- Scratch ユーザー/プロジェクト情報取得
- 日付イベント管理
- メンバー管理
- 権限自動変更（TOALLタグ使用時、絵文字乱用時）
- 特定ユーザーへの通知機能
- 日次挨拶メッセージ

## セットアップ手順

### 1. リポジトリのクローン

```bash
git clone <your-repo-url>
cd chatwork-webhook-bot
npm install
```

### 2. 環境変数の設定

以下の環境変数を設定してください：

- `CHATWORK_API_TOKEN`: あなたのChatwork APIトークン
- `WEBHOOK_TOKEN`: Webhook受信時のセキュリティトークン（任意）
- `PORT`: アプリケーションのポート番号（デフォルト: 3000）

### 3. ローカル実行

```bash
npm start
```

または開発モード：

```bash
npm run dev
```

### 4. Renderでのデプロイ

#### 方法1: render.yamlを使用

1. GitHubリポジトリにコードをプッシュ
2. Renderダッシュボードで新しいWebサービスを作成
3. GitHubリポジトリを接続
4. `render.yaml`が自動的に検出され、設定が適用されます

#### 方法2: 手動設定

1. Renderダッシュボードで新しいWebサービスを作成
2. 以下の設定を行う：
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variables**:
     - `CHATWORK_API_TOKEN`: あなたのAPIトークン
     - `WEBHOOK_TOKEN`: セキュリティトークン
   - **Health Check Path**: `/`

### 5. Chatwork Webhookの設定

1. Chatwork管理画面でWebhookを設定
2. Webhook URL: `https://your-render-app.onrender.com/webhook`
3. 対象のルームを選択
4. イベントタイプ: 「メッセージが投稿された時」を選択

## API エンドポイント

- `GET /`: ヘルスチェック
- `POST /webhook`: Chatworkからのwebhook受信

## データベース

SQLiteデータベースを使用してデータを永続化：

- `message_tracking`: メッセージID管理と日次挨拶送信日管理
- `date_events`: 日付イベント管理
- `members`: メンバー管理（参考用・現在は未使用）

## ログ機能

- **ログ送信先**: ROOM_CONFIGで指定されたルームにログを送信
- **ログ形式**: `[info][title][piconname:{user-id}][/title]{message}[/info]`
- **対象**: グループチャットのメッセージのみ（ダイレクトチャットは除外）
- **設定例**: ログ専用ルームを作成して、全ルームのログをそこに集約可能

## コマンド一覧

- `おみくじ`: おみくじを引く
- `/yes-or-no`: Yes/Noで答える
- `/wiki/[キーワード]`: Wikipedia検索
- `/scratch-user/[ユーザー名]`: Scratchユーザー情報取得
- `/scratch-project/[プロジェクトID]`: Scratchプロジェクト情報取得
- `/day-write [日付] [イベント名]`: 日付イベント登録
- `/today`: 今日の情報表示
- `/day-view`: 登録されている日付イベント一覧
- `/member`: メンバー一覧（アイコン付き）
- `/member-name`: メンバー名一覧
- `はんせい`: 特定ユーザーに通知
- `ゆゆゆ`: 特定ユーザーに通知
- `からめり`: 特定ユーザーに通知

## 自動機能

- **権限変更**: `[toall]`タグ使用時やChatwork絵文字50個以上送信時に自動で閲覧専用権限に変更
- **日次挨拶**: 毎日午前0時に日付変更メッセージと該当日のイベント通知を送信

## 注意事項

- 本番環境では必ずAPIトークンを環境変数で管理してください
- SQLiteファイルはアプリケーション再起動時に消える可能性があるため、重要なデータは別途バックアップを検討してください
- Renderの無料プランでは一定時間非アクティブ状態が続くとサービスがスリープします

## トラブルシューティング

### Webhookが受信されない場合

1. Render上でアプリケーションが正常に起動しているか確認
2. ChatworkのWebhook設定でURLが正しく設定されているか確認
3. アプリケーションログでエラーが発生していないか確認

### データベースエラーの場合

1. SQLiteファイルの権限設定を確認
2. ディスク容量を確認
3. アプリケーションログでエラー詳細を確認

## ライセンス

MIT License
