# 自宅の「WordPressをHTMLに変換するスキル」への追記メモ

作成日：2026年10月22日

## 自宅のCodexへの依頼文

WordPressをHTMLに変換する既存スキルを確認し、以下のFormspreeスパム対策を、今後どのサイトでも利用できる共通手順として追記してください。既存の機能と手順は維持してください。対象スキルが複数あれば、編集前に対象を確認してください。

サイト固有の会社名・ドメイン・FormspreeのフォームIDを、共通手順に固定しないでください。今回確認した状態と、今後の実装・検証要件を区別してください。

## 今回確認したこと

- WordPressからHTMLへ変換したサイトで、問い合わせ処理にFormspreeを使用している。
- 営業メールが1日に複数件届いたため、スパム対策を確認した。
- ユーザーが提示したFormspree管理画面では、Formshieldがオン、CAPTCHAが「Enabled」になっていた。今回オンへ変更したかどうかは未確認。
- ユーザーは届いた営業メールをFormspreeでスパム報告した。
- FTPから取得したお問い合わせHTMLには、すでに `_gotcha` の非表示用入力欄があった。
- 送信JavaScriptは `body: new FormData(form)` を使用しており、コード上は `_gotcha` も送信データに含まれる。
- 今回、確認したHTMLとJavaScriptへの変更は行っていない。
- 公開サイトでの実送信、非表示用CSSの適用状態、CAPTCHAの実際の動作は未検証。

## スキルに追加する共通手順

### 1. Formspree管理画面の設定確認

HTML変換後にFormspreeを利用する場合、対象フォームの「Settings」→「Spam protection」で以下を確認する。

- Formshieldがオンになっていること。
- CAPTCHAが「Enabled」になっていること。
- 設定を変更した場合は、変更内容をユーザーへ伝えること。

管理画面の設定はHTML・JavaScriptの編集と別の作業として扱う。管理画面へアクセスできない場合は、ユーザーに上記の状態を確認してもらう。

### 2. HTMLにハニーポットを設ける

対象の問い合わせフォームの `<form>` と `</form>` の間に、次の入力欄を1つ設ける。

```html
<input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">
```

- 通常の利用者が入力・フォーカスする対象から外す。
- `required` や `disabled` は付けず、初期値は空にする。
- 同じフォームに `_gotcha` がある場合は既存のものを確認し、重複を避ける。
- 既存のCSSクラスで隠す構成を利用する場合は、そのCSSが公開ページで読み込まれていることを確認する。
- 既存フォームの入力項目、個人情報保護方針への同意、送信完了表示などは維持する。

Formspreeは `_gotcha` に値が入った送信をボットによるものと判断して無視する。人が手入力する営業メールへの効果には限りがある。

### 3. JavaScriptの送信データに含める

`new FormData(form)` でフォーム全体を送信する場合、上記の入力欄も送信対象となる。独自のJSONや項目一覧を組み立てている場合も、`_gotcha` をFormspreeへ渡す。

```javascript
const formData = new FormData(form);
// 非表示入力欄の _gotcha も含めて送信する。
```

ハニーポットの値を送信前に削除・空文字へ強制変更すると、Formspree側の判定に使えなくなるため、そのような処理を追加しない。

### 4. 公開後の動作確認

- 通常のお問い合わせを送信でき、管理画面や通知メールで受信できることを確認する。
- 非表示入力欄が画面や通常のキーボード操作に出てこないことを確認する。
- ブラウザーの送信内容で `_gotcha` が送信データに含まれることを確認する。
- ハニーポットの動作テストは、テスト用フォームまたはユーザーが了承した対象で行い、値を入れた送信が通常の問い合わせとして通知されないことを確認する。
- CAPTCHAを有効にした状態で、現在の送信方式が正常に動作することを確認する。独自JavaScriptによる非同期送信では、CAPTCHAの画面表示・トークン送信・サーバー側の検証を含めて、実装方式に対応した公式手順を確認する。
- 管理画面での有効表示と、公開フォームでの実動作確認の結果を、それぞれ記録する。

### 5. 運用時の案内

- 届いた営業スパムは、Formspreeの通知メール下部にある報告リンクなどでスパムとして報告する。
- 人が入力する営業メールが続く場合は、本文の特徴による振り分けを検討する。
- カスタムスパムルールは、今回参照した公式資料ではBusinessプラン対象。導入時に最新の利用条件を確認する。
- 語句による振り分けは、正規のお問い合わせも対象になる可能性があるため、条件を絞り、通常の問い合わせも確認する。
- CAPTCHA・Formshield・ハニーポットを有効にした後も、営業メールが届く場合があることを説明する。

## 公式資料

- スパム対策全般：https://help.formspree.io/articles/troubleshooting/how-to-prevent-spam/
- CAPTCHAの設定：https://help.formspree.io/articles/form-and-project-settings/recaptcha-settings
- ハニーポット：https://help.formspree.io/articles/building-your-form/honeypot-spam-filtering
- カスタムルール：https://help.formspree.io/articles/advanced-features/form-rules/

## このメモの共有

このファイルは既存の同期対象である「一時共有」に保存している。自宅で最新を取得した後、このメモを自宅のCodexに指定してスキルへの追記を依頼する。
このチャットでは、GitHubへの手動送信操作は行っていない。
