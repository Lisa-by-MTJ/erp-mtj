import json, os, time, io
import googleapiclient.discovery
from googleapiclient.errors import HttpError
from google.oauth2.credentials import Credentials

cred = Credentials.from_authorized_user_file('/home/mtj/.hermes/google_token.json')
svc = googleapiclient.discovery.build('drive', 'v3', credentials=cred)
idx = json.load(open('/home/mtj/tmp_stock/invoices_index.json'))
outdir = '/home/mtj/tmp_stock/invoices'
os.makedirs(outdir, exist_ok=True)

n_ok = n_skip = n_fail = 0
for yr, files in idx.items():
    for name, fid in files:
        dest = os.path.join(outdir, f'{yr}__{name}')
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            n_skip += 1
            continue
        for attempt in range(3):
            try:
                resp = svc.files().get_media(fileId=fid).execute(num_retries=0)
                with open(dest, 'wb') as fh:
                    fh.write(resp)
                n_ok += 1
                break
            except HttpError as e:
                if attempt == 2:
                    print('FAIL', name, e.resp.status)
                    n_fail += 1
                else:
                    time.sleep(2 ** attempt)
        if (n_ok + n_skip) % 50 == 0:
            print('progress:', n_ok + n_skip, flush=True)
print('DONE downloaded', n_ok, 'skipped', n_skip, 'failed', n_fail)
