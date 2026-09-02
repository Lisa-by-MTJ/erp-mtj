"""Parse ASJ Delivery Order PDFs (folder 02) -> structured JSON.
Handles: 2022-2024 layout (stacked labels), 2025-2026 layout (inline labels),
SN-attachment pages, project DOs, JTS files.
"""
import os, re, json, sys
from pypdf import PdfReader

INBOX = '/home/mtj/tmp_do/pdfs'
ROMAN = {'I':1,'II':2,'III':3,'IV':4,'V':5,'VI':6,'VII':7,'VIII':8,'IX':9,'X':10,'XI':11,'XII':12}
MON3 = {'JAN':1,'FEB':2,'MAR':3,'APR':4,'MAY':5,'JUN':6,'JUL':7,'AUG':8,'SEP':9,'OCT':10,'NOV':11,'DEC':12}
UOMS = r'(?:Unit|Pcs|Set|Roll|Box|Pack|Lembar|Buah|Doz|Strip|Kg| pcs| unit| set| roll)'
BRANDS = ['Proel Stage','Proel Sound','Proel Commercial','Proel Eikon','Proel','Eikon','Aztec','Martin',
          'Chauvet','Robe','Griven','Madrix','Resolume','Nicolaudie','Enttec','Osram','Trusst','Sorot',
          'Hill Audio','Betacoustic','Celto','Tecnare','Cornered Audio','JEM','Iluminarc','Realizzer',
          'Weifa','Mach','GE','Sushi','Ecler','Beta','Yerasoi','Vero','Wharfedale','Soundweb','Shure','Sennheiser']

def parse_date(s):
    s = (s or '').strip()
    m = re.match(r'^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$', s)
    if m:
        y = int(m.group(3)); y = y + 2000 if y < 100 else y
        d, mo = int(m.group(1)), int(m.group(2))
        if mo > 12 and d <= 12: mo, d = d, mo   # dd/mm assumed; swap if clearly mm/dd
        return f"{y:04d}-{mo:02d}-{d:02d}"
    m = re.match(r'^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$', s)
    if m:
        mon = MON3.get(m.group(2)[:3].upper())
        if mon: return f"{int(m.group(3)):04d}-{mon:02d}-{int(m.group(1)):02d}"
    m = re.match(r'^(\d{1,2})([A-Za-z]{3,9})(\d{4})$', s)  # OCR: 4Jul2025
    if m:
        mon = MON3.get(m.group(2)[:3].upper())
        if mon: return f"{int(m.group(3)):04d}-{mon:02d}-{int(m.group(1)):02d}"
    m = re.match(r'^(\d{4})(\d{2})(\d{2})$', s)
    if m and 2022 <= int(m.group(1)) <= 2027: return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return None

def roman_date(dono):
    m = re.search(r'-([IVX]{1,4})-(\d{2})$', dono)
    if m and m.group(1) in ROMAN:
        return ROMAN[m.group(1)], 2000 + int(m.group(2))
    m = re.search(r'-(\d{1,2})-(\d{2})$', dono)
    if m and 1 <= int(m.group(1)) <= 12:
        return int(m.group(1)), 2000 + int(m.group(2))
    return None, None

def _mk_item(n, mid, qty, cond):
    brand, rest = None, mid
    for b in BRANDS:
        if mid.upper().startswith(b.upper() + ' ') or mid.upper().replace('.', '') == b.upper().replace('.', ''):
            brand, rest = b, mid[len(b):].strip(); break
    toks = rest.split(' ') if rest else []
    model = toks[0] if toks else ''
    desc = ' '.join(toks[1:]).strip()
    return {'no': n, 'brand': brand, 'model': model or mid, 'raw': mid,
            'desc': desc, 'qty': qty, 'cond': (cond or '').strip('() ') or None}

_ocr = None
def ocr_text(path):
    """OCR a scanned PDF, rebuilding horizontal text lines from word boxes."""
    global _ocr
    import numpy as np, pypdfium2 as pdfium
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    doc = pdfium.PdfDocument(path)
    out = []
    for page in doc:
        img = np.array(page.render(scale=2.5).to_pil().convert('RGB'))
        res, _ = _ocr(img)
        rows = []
        for box, text, conf in (res or []):
            ys = [p[1] for p in box]; xs = [p[0] for p in box]
            rows.append({'yc': sum(ys) / len(ys), 'x0': min(xs), 'text': text})
        rows.sort(key=lambda r: (r['yc'], r['x0']))
        lines, cur, cury = [], [], None
        for r in rows:
            if cury is None or abs(r['yc'] - cury) <= 10:
                cur.append(r); cury = r['yc'] if cury is None else (cury * (len(cur) - 1) + r['yc']) / len(cur)
            else:
                lines.append(cur); cur = [r]; cury = r['yc']
        if cur: lines.append(cur)
        for ln in lines:
            ln.sort(key=lambda r: r['x0'])
            out.append(' '.join(x['text'] for x in ln))
    t = '\n'.join(out)
    t = re.sub(r'(?<=\d)(pcs|unit|set|roll|box)\b', r' \1', t, flags=re.I)
    t = re.sub(r' {2,}', ' ', t)
    return t.strip()

def parse(path):
    fname = os.path.basename(path)
    tag = 'y2026' if fname.startswith('y2026__') else 'pre2026'
    real = re.sub(r'^(pre2026|y2026)__', '', fname)
    out = {'file': real, 'tag': tag, 'ok': False}
    try:
        r = PdfReader(path)
        txt = '\n'.join((p.extract_text() or '') for p in r.pages)
        if not txt.strip():
            txt = ocr_text(path)
            out['ocr'] = True
            txt = re.sub(r'(?<=\d)(pcs|unit|set|roll|box|pcs\.)\b', r' \1', txt, flags=re.I)
    except Exception as e:
        out['error'] = f'read: {e}'; return out
    if not txt.strip():
        out['error'] = 'no extractable text (scan?)'; return out

    # --- DO number ---
    dono = None
    m = re.search(r'DO\s*#\s*((?:[0-9]{2,4}|-)(?:-?(?:DO|DEMO|EVENT|JKT|PRJ))[A-Z0-9&._ -]*-[IVX]{1,4}-\d{2})', txt)
    if m:
        dono = re.sub(r'\s+', '', m.group(1))
    if not dono:
        # any line containing the full pattern (stacked layouts put value far from label)
        for line in txt.splitlines():
            lm = re.search(r'([0-9]{2,4}-(?:DO|DEMO)(?:-PROJECT|-[A-Za-z0-9&._]{1,16})*-[IVX0-9]{1,4}-\d{2})', line, re.I)
            if lm: dono = re.sub(r'\s+', '', lm.group(1)); break
    if not dono:
        out['error'] = 'no DO number'; return out
    out['do_no'] = dono.upper()

    # --- doc kind ---
    is_sn = bool(re.search(r'_\s?SN[\s_.]', real)) or (bool(re.search(r'SERIAL\s+NUMBER', txt)) and not re.search(r'\bQTY\b', txt))
    out['doc_kind'] = 'SN_ATTACHMENT' if is_sn else 'DELIVERY_ORDER'
    proj = bool(re.search(r'-DO-?PROJECT', dono, re.I)) or re.search(r'DO\s+Project', txt)
    demo = 'demo' in real.lower()
    out['purpose'] = 'PROJECT' if proj else ('OTHER' if demo else 'SALES')

    # --- date ---
    dm = re.search(r'Date\s+(\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}/\d{1,2}/\d{2,4}|\d{8}|\d{1,2}-\d{1,2}-\d{2,4})', txt)
    if not dm:
        dm = re.search(r'^(\d{1,2}/\d{1,2}/\d{2,4})\s*$', txt, re.M)
    date = parse_date(dm.group(1)) if dm else None
    if not date:
        mon, yr = roman_date(dono)
        if mon: date = f"{yr}-{mon:02d}-15"; out['date_est'] = True
    out['date'] = date

    # --- invoice / quotation (value may be stacked away from label) ---
    im = re.search(r'Invoice\s*#\s*([0-9]+-INV-[IVX0-9]{1,4}-\d{2})', txt) or re.search(r'([0-9]{2,4}-INV-[IVX]{1,4}-\d{2})', txt)
    out['invoice'] = im.group(1) if im else None
    qm = re.search(r'Quotation\s*#\s*([A-Z0-9][A-Z0-9/._ -]*[0-9A-Z])', txt)
    if not qm:
        qm = re.search(r'\b([A-Z]{2,4}[A-Z]?/\d{6,8}/[A-Z]{1,3}/\d{2,3})\b', txt)
    out['quotation'] = qm.group(1).strip() if qm and qm.group(1).strip() != '-' else None

    # --- customer candidates: text lines then filename tokens ---
    lines = [l.strip() for l in txt.splitlines() if l.strip()]
    junk = re.compile(r'^(DELIVERY\s*ORDER|DELIVERYORDER|Date|DO\s*#|Invoice|Quotation|DELIVERED\s*TO|Delivered\s*To|CONDITION|\(?\s*(Good|Poor|Not Good|Baik)|NO\s*$|No\.?$|No[ .]|BRAND\b|TYPE\b|Description|QTY|Address|Attention|Attn|UP\.|Company|Jl\.|JI\.|Jln|Jakarta|Daerah|Kota|Provinsi|Telepon|Telp|Phone|Email|Fax|Signature|Name|CHECKER|WAREHOUSE|SALES|SECURITY|CUSTOMER\b|Your\s*One|Office:|PT\.\s*ALVINITY|PT\.?\s*ALVINITYSOLU|ALVINITY|ALVINET|\*|Lihat|Please\s*see|WIRELESS|KABEL|MICROPHONE|MIC\b|Speaker|Amplifier|Processor|Cable|Mix(er|Pro)|Dealer\s*Visit)', re.I)
    addr = re.compile(r'\d{5}|\+62|\(\+?62|08\d{2}|@|Kav|Ruko|Blok|Lt\.|Gedung', re.I)
    name_lines = []
    for i, l in enumerate(lines):
        if re.match(r'^(Proel|Eikon|Aztec|Maia|Stereo|Microphone|All-in|Desktop|Nearfield|Active)\b', l, re.I): continue  # column bleed / description cells
        if 5 < len(l) < 70 and not junk.match(l) and not addr.search(l) and not re.match(r'^\d', l) and not re.search(r'\d{5,}', l):
            # skip sender/company header words
            if re.search(r'ALVINITY|MONALISA TUNGGAL|PROMEDIA INNOV|SOLUSINDOJAYA', l, re.I) and not re.search(r'PT\.|CV\.|TOKO|CV ', l, re.I):
                continue
            name_lines.append(l)
    fm = re.sub(r'^(ASJ|JTS|2025|2024|2026)\s+', '', real[:-4])
    # filename fallback segments: try between seq and trailing
    parts = re.split(r'_', fm)
    cands = []
    for i, p in enumerate(parts):
        if re.match(r'^D[O1]', p, re.I) or p.upper() in ('SN', 'PROJECT', 'DEMO', 'D1') or re.match(r'^\d+$', p):
            if i + 1 < len(parts) and not re.match(r'^\d+$', parts[i+1]):
                # customer = following tokens up to trailing item/date tokens (try 1..3 tokens)
                seg = []
                for q in parts[i+1:]:
                    if re.match(r'^(\d{1,2}-\d{1,2}|\d{6,8}|SN|X?\d{2})$', q): break
                    seg.append(q)
                if seg: cands.append(' '.join(seg))
    out['cust_lines'] = name_lines[:6]
    out['cust_fname'] = cands[0] if cands else None
    out['cust_all'] = name_lines[:6] + cands

    # --- items ---
    items = []
    if not is_sn:
        VUOMS = {u.lower().rstrip('.') for u in UOMS.replace('(?:','').replace(')','').split('|')} | {'pcs','unit','set','roll','box','pack','lembar','buah','doz','strip','kg'}
        # table region: between header row and the SN footnote
        body = lines
        hi = next((i for i, l in enumerate(lines) if re.search(r'BRAND\s+TYPE|No\. Brand Type|NO BRAND', l, re.I)), None)
        fi = next((i for i, l in enumerate(lines) if re.search(r'Lihat lampiran|Please see attachment|SERIAL NUMBER goods', l, re.I)), len(lines))
        if hi is not None and hi < fi:
            body = lines[hi + 1:fi]
        for line in body:
            m = re.match(r'^(?:(\d{1,2})\s+)?(.+?)\s+(\d+(?:[.,]\d+)?)\s*' + UOMS + r'[\.\s]*(\(?\s*(?:Good|Poor|Not Good|Baik|Bagus|OK)[^)]*\)?)?\s*$', line)
            if not m: continue
            n, mid, qty, cond = m.groups()[:4]
            items.append(_mk_item(int(n) if n else len(items) + 1, mid.strip(), float(qty.replace(',', '.')), cond))
        if not items:
            # vertical layout: one cell per line ->  N / brand / type / desc.. / qty / uom
            i = 0
            while i < len(body):
                m = re.match(r'^(\d{1,2})$', body[i])
                if not m: i += 1; continue
                n = int(m.group(1))
                j, cells = i + 1, []
                while j < len(body) and len(cells) < 10:
                    c = body[j]
                    if c.lower().rstrip('.') in VUOMS:
                        break
                    if re.match(r'^\d{1,2}$', c) and any(re.fullmatch(r'\d+(?:[.,]\d+)?', x) for x in cells):
                        break  # numeric qty already seen; next bare number = next item
                    cells.append(c); j += 1
                if j < len(body) and body[j].lower().rstrip('.') in VUOMS and cells:
                    qi = next((k for k, x in enumerate(cells) if re.fullmatch(r'\d+(?:[.,]\d+)?', x) and k >= 1), None)
                    if qi is not None:
                        mid = ' '.join(cells[:qi])
                        items.append(_mk_item(n, mid, float(cells[qi].replace(',', '.')), None))
                    i = j + 1
                else:
                    i += 1
    out['items'] = items

    # --- serial groups (SN pages) ---
    serials = {}
    if is_sn:
        cur = None
        for line in lines:
            lm = re.match(r'^(\d{1,3})\s+([A-Za-z][A-Za-z0-9&./ -]{2,}?)\s*$', line)
            sm = re.match(r'^[0-9A-Za-z]{2,}(?:\s*,\s*[0-9A-Za-z]{1,})+\s*$', line)
            if lm and int(lm.group(1)) <= 25 and not re.match(r'^(Serial|Date|Invoice|Quotation|Delivered|Attention|Page)', lm.group(2), re.I):
                cur = lm.group(2).strip()
            elif sm and cur:
                for s in re.split(r',\s*', line.strip()):
                    s = s.strip()
                    if s: serials.setdefault(cur, []).append(s)
        serials = {k: sorted(set(v)) for k, v in serials.items()}
    out['serials'] = serials
    out['ok'] = True
    return out

if __name__ == '__main__':
    files = sorted(f for f in os.listdir(INBOX) if f.lower().endswith('.pdf'))
    results, errs = [], []
    for f in files:
        try:
            r = parse(os.path.join(INBOX, f))
        except Exception as e:
            r = {'file': f, 'ok': False, 'error': f'exception: {e}'}
        (results if r['ok'] else errs).append(r)
    json.dump(results, open('/home/mtj/tmp_do/do_parsed.json', 'w'), indent=1)
    json.dump(errs, open('/home/mtj/tmp_do/do_errors.json', 'w'), indent=1)
    parents = [r for r in results if r['doc_kind'] == 'DELIVERY_ORDER']
    sns = [r for r in results if r['doc_kind'] == 'SN_ATTACHMENT']
    from collections import Counter
    print(f"parsed {len(results)} | errors {len(errs)} | parent-DOs {len(parents)} | SN pages {len(sns)}")
    dnos = Counter(r['do_no'] for r in parents)
    dupd = {k: v for k, v in dnos.items() if v > 1}
    print('distinct parent do_no:', len(dnos), '| do_no appearing >1x:', len(dupd))
    print('with items:', sum(1 for r in parents if r['items']),
          '| zero-item parents:', sum(1 for r in parents if not r['items']))
    print('with date:', sum(1 for r in parents if r['date']), '| est:', sum(1 for r in parents if r.get('date_est')))
    print('with invoice link:', sum(1 for r in parents if r['invoice']))
    print('with customer cand:', sum(1 for r in parents if r['cust_all']))
    print('purpose:', Counter(r['purpose'] for r in parents))
    print('SN pages w/ serials:', sum(1 for r in sns if r['serials']))
    print('--- errors ---')
    for e in errs[:30]:
        print('ERR', e['file'], '|', e.get('error'))
