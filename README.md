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
