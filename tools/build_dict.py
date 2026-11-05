import csv, json, sys, re, io
import opencc
BS_N = chr(92) + 'n'
cc = opencc.OpenCC('s2twp')
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
    non_net = [l for l in lines if not l.startswith('[网络]')]
    if non_net: lines = non_net + [l for l in lines if l.startswith('[网络]')][:0]
    return cc.convert('\n'.join(lines[:6]))[:400]

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
with open(out, 'w', encoding='utf-8') as f:
    json.dump({'e':entries,'f':forms}, f, ensure_ascii=False, separators=(',',':'))
print(len(core), len(phr), len(forms))
