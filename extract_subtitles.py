import json, os, re, glob

# Chrome download tmp files
download_dir = os.path.expanduser('~/Downloads')
tmp_files = glob.glob(os.path.join(download_dir, '*.tmp'))

outdir = 'E:/AII/ugk-core/王暖胃_文章字幕'
os.makedirs(outdir, exist_ok=True)

def clean_filename(title):
    title = re.sub(r'[\\/:*?"<>|#]', '', title)
    title = title.replace('"', '').replace('"', '')
    return title[:60]

all_data = {}
for f in tmp_files:
    try:
        with open(f, 'r', encoding='utf-8') as fh:
            content = fh.read()
            if '"BV1' in content:  # Looks like our subtitle data
                data = json.loads(content)
                for bvid, text in data.items():
                    # text format: "title\ntext content"
                    if '\n' in text:
                        title, body = text.split('\n', 1)
                        all_data[bvid] = (title, body)
                    else:
                        all_data[bvid] = ('Unknown', text)
                print(f'Loaded: {f} ({len(data)} entries)')
    except Exception as e:
        pass  # Not our file

print(f'\nTotal unique videos: {len(all_data)}')

saved = 0
for bvid, (title, text) in all_data.items():
    fname = f'{clean_filename(title)}_{bvid}.txt'
    fpath = os.path.join(outdir, fname)
    with open(fpath, 'w', encoding='utf-8') as f:
        f.write(f'【{title}】\n')
        f.write(f'https://www.bilibili.com/video/{bvid}\n')
        f.write('='*60 + '\n\n')
        f.write(text)
    saved += 1

print(f'Saved {saved} files to {outdir}')
