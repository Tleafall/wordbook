import csv, json, sys, re, io
import opencc
BS_N = chr(92) + 'n'
_cc = opencc.OpenCC('s2twp')
# 這幾個詞 s2twp 會換成台灣電腦用語，反而不對，先保護起來
PROTECT = {'支持': '支持', '参数': '參數', '自变量': '自變量', '质量': '品質', '信息': '訊息'}
class _CC:
    def convert(self, t):
        keep = []
        for k, v in PROTECT.items():
            if k in t:
                t = t.replace(k, '%d' % len(keep)); keep.append(v)
        t = _cc.convert(t)
        for i, v in enumerate(keep): t = t.replace('%d' % i, v)
        return t
cc = _CC()
# 專業領域的意思（醫學、化學、電腦…）：有一般意思時就不列，避免干擾
DOMAIN = {'医','化','计','经','法','电','机','建','体','动','植','矿','地质','生','药','气','天','物','数','生化','有化','解','财','人名','地名','鸟类','动物','植物','网络','电影','男子名','女子名'}
src, out = sys.argv[1], sys.argv[2]
csv.field_size_limit(10**9)
rows = {}
with open(src, encoding='utf-8') as f:
    for r in csv.DictReader(f):
        rows[r['word'].lower()] = r if r['word'].lower() not in rows else rows[r['word'].lower()]

def rank(r):
    vals = [int(r[k]) for k in ('frq','bnc') if r[k] and r[k].isdigit() and int(r[k])>0]
    return min(vals) if vals else 0

LIMIT = 45000
core = set()
for w, r in rows.items():
    if not r['translation'].strip(): continue
    if not re.fullmatch(r"[a-z][a-z'\-]*", w): continue
    rk = rank(r)
    if (0 < rk <= LIMIT) or r['collins'] not in ('','0') or r['oxford']=='1' or r['tag'].strip():
        core.add(w)
# phrases: 2-3 words, every part very common (rank <= 3000)
rk = {w: rank(r) for w, r in rows.items() if ' ' not in w}
phr = set()
for w, r in rows.items():
    if ' ' not in w or not r['translation'].strip(): continue
    if r['word'][0].isupper(): continue
    parts = w.split(' ')
    if not (2 <= len(parts) <= 3): continue
    if not all(0 < rk.get(p, 0) <= 3000 for p in parts): continue
    if not [l for l in r['translation'].split(BS_N) if l.strip() and not l.strip().startswith('[网络]')]: continue
    phr.add(w)
for w in ["gonna","wanna","gotta","lemme","gimme","dunno","ain't","y'all","kinda","sorta","outta","dude","whatcha","ya"]:
    if w in rows and rows[w]['translation'].strip(): core.add(w)

def clean_tr(t):
    lines = [l.strip() for l in t.split(BS_N) if l.strip()]
    def dom(l):
        m = re.match(r'\[([^\]]{1,6})\]', l)
        return m and m.group(1) in DOMAIN
    general = [l for l in lines if not dom(l)]
    if general: lines = general
    else: lines = [l for l in lines if not l.startswith('[网络]')] or lines
    out = []
    for l in cc.convert('\n'.join(lines[:6])).split('\n'):
        m = re.match(r'^([a-z]+\.\s*)?(.*)$', l)
        pre, body = m.group(1) or '', m.group(2)
        seen = []
        for item in re.split(r',\s*', body):  # 轉繁體後可能出現重複的意思
            if item and item not in seen: seen.append(item)
        out.append(pre + ', '.join(seen))
    return '\n'.join(out)[:400]

def clean_def(d):
    lines = [l.strip() for l in d.split(BS_N) if l.strip()]
    return '\n'.join(lines[:3])[:300]

entries = {}
forms = {}
for w in sorted(core | phr):
    r = rows[w]
    e = [r['phonetic'], clean_tr(r['translation'])]
    rk = rank(r); col = int(r['collins']) if r['collins'].isdigit() else 0
    e.append(rk); e.append(col)
    d = ''
    e.append(d)
    entries[w] = e
    for part in r['exchange'].split('/'):
        if ':' in part:
            k, v = part.split(':',1)
            if k in 'pdi3rs' and v and v.lower() != w:
                forms.setdefault(v.lower(), w)
forms = {k:v for k,v in forms.items() if k not in entries}
# 常見縮寫：原字典常把意思放在括號裡或混進雜訊（例如 what's 被寫成「…; 烏」），這裡直接給正確解釋
CONTRACTIONS = {
    "what's": "what is 或 what has", "it's": "it is 或 it has", "that's": "that is 或 that has",
    "there's": "there is 或 there has", "here's": "here is", "who's": "who is 或 who has",
    "where's": "where is", "how's": "how is", "when's": "when is", "why's": "why is",
    "he's": "he is 或 he has", "she's": "she is 或 she has", "let's": "let us（我們…吧）",
    "i'm": "I am", "you're": "you are", "we're": "we are", "they're": "they are",
    "i've": "I have", "you've": "you have", "we've": "we have", "they've": "they have",
    "i'll": "I will", "you'll": "you will", "he'll": "he will", "she'll": "she will", "it'll": "it will",
    "we'll": "we will", "they'll": "they will", "that'll": "that will",
    "i'd": "I would 或 I had", "you'd": "you would 或 you had", "he'd": "he would 或 he had",
    "she'd": "she would 或 she had", "we'd": "we would 或 we had", "they'd": "they would 或 they had",
    "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
    "don't": "do not", "doesn't": "does not", "didn't": "did not", "can't": "cannot",
    "couldn't": "could not", "won't": "will not", "wouldn't": "would not", "shouldn't": "should not",
    "haven't": "have not", "hasn't": "has not", "hadn't": "had not", "mustn't": "must not",
    "ain't": "am not／is not／are not（非正式）", "y'all": "you all（你們大家）",
    "could've": "could have", "would've": "would have", "should've": "should have",
}
for w, full in CONTRACTIONS.items():
    old = entries.get(w)
    phon = old[0] if old else ''
    entries[w] = [phon, 'abbr. 縮寫＝' + full, old[2] if old else 0, old[3] if old else 0, '']
    forms.pop(w, None)

with open(out, 'w', encoding='utf-8') as f:
    json.dump({'e':entries,'f':forms}, f, ensure_ascii=False, separators=(',',':'))
print(len(core), len(phr), len(forms))
