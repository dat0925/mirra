# MIRRA 設計書
## 美容室特化 AIエージェント予約・顧客管理システム

---

## 1. プロダクト概要

| 項目 | 内容 |
|------|------|
| プロダクト名 | MIRRA（ミラ） |
| コンセプト | 美容室オーナーのための、管理画面を持たないAIエージェント型SaaS |
| ターゲット | 美容室・ヘアサロンオーナー（個人〜小規模） |
| エンドユーザー | 来店客（主に30〜60代女性） |
| 語源 | ラテン語「見る」＋mirror（鏡）。経営を鏡のように明確に映し出す |
| シリーズ | MEO / RENO / **MIRRA** |

---

## 2. コアコンセプト

> **「管理画面ではなく、会話がUIである」**

従来のSaaSと異なり、MIRRAはLINE公式アカウントのトーク画面そのものがサービスの全て。
オーナーもお客様も、LINEで話しかけるだけで全機能が利用できる。

---

## 3. システムアーキテクチャ

```
【お客様側】
LINEトーク画面
    ↓ メッセージ送信
LINE Messaging API（Webhook）
    ↓
【サーバー側：GitHub Pages / Supabase Edge Functions】
Webhook受信サーバー（Supabase Edge Functions）
    ↓
Claude API（会話処理・意図理解・返答生成）
    ↓
Supabase DB（予約・カルテ・顧客情報の保存）
    ↓
LINE Messaging API（返答送信）
    ↓
【お客様側】
LINEトーク画面に返答表示

【リマインド処理】
Supabase Cron → 予約前日にLINEプッシュ通知
```

---

## 4. 技術スタック

| レイヤー | 技術 | 理由 |
|---------|------|------|
| フロントエンド | LINE公式アカウント | お客様の導線。追加開発不要 |
| Webhook処理 | Supabase Edge Functions（Deno） | サーバーレス・低コスト |
| AI処理 | Claude API（claude-sonnet） | 自然な日本語・文脈理解 |
| データベース | Supabase（PostgreSQL） | RLS対応・リアルタイム |
| 静的ホスティング | GitHub Pages | 管理画面・LP用 |
| 通知 | LINE Messaging API Push | 予約リマインド・DM配信 |
| 認証 | Supabase Auth | オーナーログイン管理 |

---

## 5. データベース設計

### salons（サロン情報）
```sql
id              uuid primary key
name            text          -- サロン名
line_channel_id text          -- LINE Channel ID
line_channel_secret text      -- LINE Channel Secret
line_access_token text        -- LINE Access Token
claude_system_prompt text     -- サロン固有のMIRRAキャラ設定
owner_email     text
created_at      timestamp
```

### customers（顧客）
```sql
id              uuid primary key
salon_id        uuid references salons
line_user_id    text          -- LINE User ID
name            text          -- お名前
phone           text
memo            text          -- 担当者メモ
visit_count     int default 0
last_visit_at   timestamp
created_at      timestamp
```

### appointments（予約）
```sql
id              uuid primary key
salon_id        uuid references salons
customer_id     uuid references customers
scheduled_at    timestamp     -- 予約日時
menu            text          -- メニュー内容
staff_name      text          -- 担当スタッフ
status          text          -- pending / confirmed / cancelled / done
reminder_sent   boolean default false
created_at      timestamp
```

### karte（カルテ）
```sql
id              uuid primary key
salon_id        uuid references salons
customer_id     uuid references customers
appointment_id  uuid references appointments
treatment       text          -- 施術内容
color_recipe    text          -- カラーレシピ
condition       text          -- 髪の状態
notes           text          -- 担当者メモ
next_suggestion text          -- 次回提案
visited_at      timestamp
created_at      timestamp
```

### conversations（会話履歴）
```sql
id              uuid primary key
salon_id        uuid references salons
customer_id     uuid references customers
role            text          -- user / assistant
content         text
created_at      timestamp
```

---

## 6. 機能仕様

### 6.1 お客様向け機能（LINE）

#### ① 予約受付
- 「予約したい」「来週の土曜空いてる？」など自然文で受付
- 日時・メニュー・担当者希望をヒアリング
- 予約確定後に確認メッセージ送信
- 前日にリマインドプッシュ通知

#### ② カルテ参照
- 「前回何をしたか教えて」→ 過去のカルテを参照して返答
- 「次回はいつがいい？」→ 来店サイクルから提案

#### ③ キャンセル・変更
- 「明日の予約キャンセルしたい」→ 確認後キャンセル処理
- 「時間を変えたい」→ 変更受付

#### ④ サロンへの質問
- 「駐車場はある？」「パーマの料金は？」→ サロン情報から回答

---

### 6.2 オーナー向け機能（LINE管理用チャンネル）

#### ① 予約確認
- 「今日の予約を教えて」→ 本日の予約一覧をテキストで返答
- 「明日の13時は空いてる？」→ 空き状況確認

#### ② 顧客確認
- 「田中さんの前回の施術は？」→ カルテ参照
- 「今月来ていないお客様は？」→ 離反顧客リスト

#### ③ リピートDM
- 「来月来ていないお客様にDMを送って」→ 文章生成→配信
- 来店から60日以上経過した顧客に自動提案

---

### 6.3 QRコードカード導線

```
【カード記載内容】
━━━━━━━━━━━━━━━━━━━━
  次回のご予約はLINEで♪
  
  [QRコード]
  
  MIRRAに話しかけるだけで
  24時間いつでも予約できます
━━━━━━━━━━━━━━━━━━━━
```

- QRコード → LINE公式アカウントの友だち追加URL
- 友だち追加と同時に自動あいさつメッセージ送信
- リッチメニューで「予約する」「前回の施術」「サロンに質問」ボタン設置

---

## 7. MIRRAキャラクター設計

### 基本設定
- 名前：MIRRA（ミラ）
- 口調：丁寧だけど堅くない・温かい・待ってくれる
- 絵文字：控えめ（1メッセージに1〜2個）
- 特徴：お客様の名前で呼ぶ・前回の来店を覚えている

### あいさつメッセージ例
```
こんにちは😊 MIRRAです。
〇〇サロンの予約・ご相談を
24時間お受けしています。

「予約したい」「前回の施術を知りたい」
など、お気軽に話しかけてください♪
```

### 予約受付例
```
[お客様]「来週の土曜、予約したい」

[MIRRA]「田中さん、ありがとうございます😊
来週の土曜（6/7）はご来店ですね。
ご希望のお時間はありますか？
（例：11時〜、14時以降、など）」

[お客様]「午後2時ごろ」

[MIRRA]「14時はご予約可能です✨
メニューはカラーでよろしいでしょうか？
（前回もカラーをされていたので）」
```

---

## 8. ビジネスモデル

| プラン | 月額 | 内容 |
|--------|------|------|
| スターター | ¥5,000 | LINE1アカウント・予約管理・カルテ100件 |
| スタンダード | ¥9,800 | LINE1アカウント・全機能・カルテ無制限・DM配信月100件 |
| プロ | ¥19,800 | 複数スタッフ対応・DM無制限・優先サポート |

初期費用：¥0（完全月額制）
無料トライアル：30日間

---

## 9. 開発フェーズ

### Phase 1（MVP）〜1ヶ月
- Supabase DB構築（salons / customers / appointments）
- LINE Messaging API webhook設定
- Claude APIによる予約受付会話
- 予約リマインド通知

### Phase 2〜2ヶ月
- カルテ管理機能
- オーナー向けLINEチャンネル
- リッチメニュー設置

### Phase 3〜3ヶ月
- リピートDM自動提案
- 離反顧客アラート
- EPRESS（MEO）との連携

---

## 10. LP設計書

### ターゲット
美容室・ヘアサロンオーナー（個人〜5名規模）
ITが得意ではなく、今の予約管理に課題を感じている

### キャッチコピー（案）
```
予約の電話、もう出なくていい。
LINEに話しかけるだけで、予約が取れる時代へ。
```

### LPの構成
1. **ヒーロー**：キャッチコピー＋イメージ画像＋CTA（無料で試す）
2. **課題提示**：「こんなお悩みありませんか？」
3. **解決策**：MIRRAの仕組み説明（3ステップ）
4. **機能紹介**：予約・カルテ・リピートDM
5. **お客様の声**（仮）
6. **料金プラン**
7. **導入の流れ**（3ステップ）
8. **FAQ**
9. **CTA**：無料トライアル申込み

### トーン
- 親しみやすい・わかりやすい
- 専門用語を使わない
- オーナーの「安心感」を演出
- 「難しそう」という不安を先に消す

---

*作成日：2026年5月27日*
*プロダクト：MIRRA by iFLAG*
