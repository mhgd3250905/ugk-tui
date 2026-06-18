import json, os

all_videos = []
tmpdir = os.environ.get('TMPDIR', '/tmp')
for pn in [1,2,3]:
    fpath = os.path.join(tmpdir, f'warmwei_page{pn}.json')
    if not os.path.exists(fpath):
        # try alternate path
        fpath = f'E:/AII/ugk-core/warmwei_page{pn}.json'
    if os.path.exists(fpath):
        with open(fpath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        vlist = data.get('data',{}).get('list',{}).get('vlist',[])
        for v in vlist:
            all_videos.append((v['bvid'], v['title'], v['length']))
        print(f'Page {pn}: {len(vlist)} videos')

print(f'\nTotal: {len(all_videos)}')
for i, (bvid, title, length) in enumerate(all_videos):
    print(f'{i+1}. [{length}] {title}  ({bvid})')
