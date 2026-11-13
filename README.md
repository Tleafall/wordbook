# 我的單字冊

在 iPhone「加入主畫面」使用的英文單字 App：查字典 → 收進自己的單字冊 → 依記憶科學安排複習。

- 離線英漢字典（約 5.4 萬單字 + 5.4 萬片語，繁體中文）
- 有網路時顯示英英解釋與真人發音
- FSRS 間隔重複排程，三種卡片：認字 → 聽力 → 拼寫
- 記下影集出處與台詞，拼寫卡用台詞挖空
- 邊走邊背：語音念英文 → 停頓 → 念中文 → 念台詞
- 貼上整句字幕（英＋中），點字查詢，自動找出句中片語
- Netflix 一鍵收藏書籤：抓雙語字幕、劇名、集數、時間點，可跳回那一幕
- 電腦 ↔ 手機雲端同步（存在自己 GitHub 帳號的私人 Gist）
- 📷 截圖讀字幕：Netflix、YouTube 等 App 截圖後在手機上辨識文字（Tesseract.js，不需 API、圖片不上傳）
- iPhone 捷徑＋背面輕點：輕點兩下就把畫面上的字幕複製起來

## 結構
- `app/`：網站本體（GitHub Pages 發布這個資料夾）
- `tools/build_dict.py`：從 ECDICT 產生 `app/dict.json`

重建字典：
```
pip install opencc-python-reimplemented
python tools/build_dict.py ecdict.csv app/dict.json
```

## 資料來源
- [ECDICT](https://github.com/skywind3000/ECDICT)（MIT License）
- [Free Dictionary API](https://dictionaryapi.dev/)
- [MyMemory](https://mymemory.translated.net/)（離線字典查不到時的中文翻譯）
- [Tesseract.js](https://github.com/naptha/tesseract.js) 與 tessdata 英文模型（Apache License 2.0），放在 `app/ocr/`

## 隱私

- 沒有後端伺服器、沒有帳號、沒有追蹤：單字、複習紀錄、台詞只存在使用者自己的瀏覽器（IndexedDB）。
- 有網路時，查詢的單字會送到 [Free Dictionary API](https://dictionaryapi.dev/) 取得英英解釋；離線字典查不到時，會送到 [MyMemory](https://mymemory.translated.net/) 翻譯。只送該單字。
- 📷 截圖辨識完全在裝置上執行，圖片不上傳。
- 選用的同步功能把資料存在使用者自己 GitHub 帳號的 secret gist（不公開列出，但知道網址即可讀取）。金鑰只存在使用者裝置，不會進備份檔。

## 安全設計

- 內容安全政策（CSP）：只允許本站程式，網路連線限定字典、翻譯與 GitHub API。
- 外部傳入的資料（書籤擷取、同步、備份還原）一律檢查型別與長度，並擋下 `__proto__` 等特殊鍵名；書籤擷取只顯示、不寫入，使用者按「加入」才存檔。
- 同步為進階選項，教學建議使用可設到期日的 fine-grained token、專用帳號，並附撤銷步驟。

## 著作權

收藏的台詞屬於原著作權人，僅存在使用者裝置、供個人學習使用。本專案與 Netflix、YouTube 等服務無關，字幕擷取可能因對方改版失效。
