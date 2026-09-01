"""Parse ASJ invoice PDFs -> structured rows.
Customer: text BILL TO when present (2026 layout), else filename segment.
"""
import os, re, json, sys
from pypdf import PdfReader

INVD = '/home/mtj/tmp_stock/invoices'
ROMAN = {'I':1,'II':2,'III':3,'IV':4,'V':5,'VI':6,'VII':7,'VIII':8,'IX':9,'X':10,'XI':11,'XII':12}
MON3 = {'JAN':1,'FEB':2,'MAR':3,'APR':4,'MAY':5,'JUN':6,'JUL':7,'AUG':8,'SEP':9,'OCT':10,'NOV':11,'DEC':12}

_cache = {}
def extract_text(path):
    if path in _cache: return _cache[path]
    r = PdfReader(path)
    t = '\n'.join(p.extract_text() or '' for p in r.pages)
    _cache[path] = t
    return t

def rp(s):
    s = s.replace('Rp', '').replace(' ', '').replace('\u00a0', '').strip()
    neg = s.startswith('-')
    s = s.lstrip('-')
    if not re.match(r'^\d{1,3}(?:[.,]\d{3})+$', s): return None
    v = int(s.replace('.', '').replace(',', ''))
    return -v if neg else v

def money_after(txt, label):
    m = re.search(label + r'\s+(-?\s*(?:[\d.]+|[\d,]+)\s*Rp|Rp\s*-?[\d.,]+|-?[\d.,]+Rp|Rp\s*-)', txt)
    if not m: return None
    g = m.group(1)
    if g.strip() in ('Rp -', '-Rp', 'Rp'): return 0
    return rp(g)

def filename_parts(fname):
    fname = re.sub(r'^\d{4}__', '', fname)
    # ASJ Invoice_031-INV-III-23_Bapak Candra Paris Audio Salatiga.pdf  (trailing _item optional)
    m = re.match(r'ASJ Invoice_([0-9]+-INV-(?:[IVX]+|\d+)-\d{2})_(.+)\.pdf$', fname)
    return (m.group(1), m.group(2)) if m else (None, None)

def parse(path):
    fname = os.path.basename(path)
    txt = extract_text(path)
    out = {'file': fname, 'ok': False}
    invno, cust_fname = filename_parts(fname)
    m = re.search(r'INVOICE\s*#\s*([0-9]+-INV-(?:[IVX]+|\d+)-(\d{2}))', txt)
    if not m and invno:
        m = re.match(r'([0-9]+)-INV-([IVX]+|\d+)-(\d{2})', invno)
        out['inv_num'] = invno
    elif m:
        out['inv_num'] = m.group(1)
    if not out.get('inv_num'):
        out['error'] = 'no invoice number'
        return out
    mm = re.match(r'(\d+)-INV-([IVX]+|\d+)-(\d{2})', out['inv_num'])
    out['seq'] = int(mm.group(1))
    mon = ROMAN.get(mm.group(2)) or (int(mm.group(2)) if mm.group(2).isdigit() else None)
    out['inv_year'] = 2000 + int(mm.group(3))
    d = re.search(r'DATE\s+(\d{1,2})/(\d{1,2})/(\d{4})', txt) or re.search(r'DATE\s+(\d{1,2})/(\d{1,2})/(\d{2})$', txt, re.M)
    d2 = re.search(r'DATE\s+(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})', txt)
    if d:
        dd, mo, yy = int(d.group(1)), int(d.group(2)), int(d.group(3))
        if yy < 100: yy += 2000
        dd, mo = (mo, dd) if mo > 12 >= dd else (dd, mo)  # disambiguate
        out['date'] = f'{yy:04d}-{mo:02d}-{dd:02d}'
    elif d2:
        mo = MON3.get(d2.group(2).upper()[:3])
        if mo: out['date'] = f'{int(d2.group(3))}-{mo:02d}-{int(d2.group(1)):02d}'
    if 'date' not in out:
        out['date'] = f"{out['inv_year']}-{mon:02d}-01" if mon else str(out['inv_year'])
    if cust_fname:
        out['customer'] = re.sub(r'_(?:RFQ|DP|Quotation|INV|Project|Order|\d{6}).*$', '', cust_fname).strip().replace('_', ' ')
    if 'customer' not in out:
        bm = re.search(r'BILL TO[:\s]*\n([^\n]+)', txt)
        if bm and 'INVOICE' not in bm.group(1) and 'DESCRIPTION' not in bm.group(1):
            out['customer'] = bm.group(1).strip()
    up = re.search(r'UP[.\s]+([^\n]+)', txt)
    if up: out['up'] = up.group(1).strip()
    for key, label in (('subtotal','SUBTOTAL'), ('discount','DISCOUNT'), ('ppn','PPN'), ('dp','DOWN PAYMENT')):
        v = money_after(txt, label)
        if v is not None: out[key] = v
    out['total'] = money_after(txt, 'TOTAL')
    out['ok'] = out.get('total') is not None and 'customer' in out
    return out

if __name__ == '__main__':
    files = sorted(f for f in os.listdir(INVD) if f.endswith('.pdf'))
    paths = [os.path.join(INVD, f) for f in files]
    res = [parse(p) for p in paths]
    json.dump(res, open('/home/mtj/tmp_stock/invoices_parsed.json', 'w'), ensure_ascii=False, indent=1)
    good = [r for r in res if r['ok']]
    bad = [r for r in res if not r['ok']]
    print('parsed:', len(good), 'ok |', len(bad), 'failed')
    for r in bad[:20]: print('BAD:', r['file'], '|', r.get('error') or f"total={r.get('total')} cust={r.get('customer')!r}")
    import collections
    yrs = collections.Counter(r.get('inv_year') for r in good)
    print('by invoice year:', dict(sorted(yrs.items())))
    tot = sum(r['total'] or 0 for r in good)
    print(f'TOTAL invoice value: Rp {tot:,}')
