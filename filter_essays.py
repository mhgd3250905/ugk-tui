import json

# Load all videos from page files
all_videos = []
for pn in [1,2,3]:
    with open(f'E:/AII/ugk-core/warmwei_page{pn}.json', 'r', encoding='utf-8') as f:
        data = json.load(f)
    vlist = data.get('data',{}).get('list',{}).get('vlist',[])
    for v in vlist:
        all_videos.append((v['bvid'], v['title'], v['length'], v['aid']))

# Keywords that indicate tutorial/practical content (EXCLUDE these)
exclude_keywords = [
    '终于有人', '说清楚', '讲清楚', '攻略', '教程', 'tips', 'Tips', 'TIPS',
    '面试', '简历', 'hr', 'HR', '求职', '避坑', '干货', '邪修', '鉴定',
    '锐评', '入职', '职场新人', '职场', '离职', '跳槽', '副业', '兼职',
    '公积金', '医保', '电费', '省电', '补贴', '寄件', '坐飞机',
    '租房', '第一次', '注意', '应该', '怎么', '如何', '实操',
    '杭漂1', '杭漂2', '杭漂3', '杭漂4', '杭漂5', '杭漂6', '杭漂7', '杭漂8', '杭漂9',
    '杭漂10', '杭漂11', '杭漂12', '杭漂13', '杭漂14', '杭漂15',
    '现状考察', 'MBTI', '压力面', '牛马', '综合症', '黑话', '自保',
    '速通', '辞职教程', '离职原因', '谈判', '已离职', 'PUA',
    '跨境', '电商',
]

essays = []
for bvid, title, length, aid in all_videos:
    # Check if title contains any exclude keyword
    excluded = False
    for kw in exclude_keywords:
        if kw in title:
            excluded = True
            break
    if not excluded:
        essays.append((bvid, title, length, aid))

print(f"Total: {len(all_videos)} videos")
print(f"Essay-style (filtered): {len(essays)} videos")
print()
for i, (bvid, title, length, aid) in enumerate(essays):
    print(f'{i+1}. [{length}] {title}  ({bvid})')

# Save to file for later processing
with open('E:/AII/ugk-core/essay_list.json', 'w', encoding='utf-8') as f:
    json.dump([{'bvid': b, 'title': t, 'length': l, 'aid': a} for b,t,l,a in essays], f, ensure_ascii=False, indent=2)

print(f"\nSaved to essay_list.json")
