import requests, os, re, json, time

outdir = 'E:/AII/ugk-core/王暖胃_文章字幕'
os.makedirs(outdir, exist_ok=True)

# Load essay list 
with open('E:/AII/ugk-core/essay_list.json', 'r', encoding='utf-8') as f:
    essays = json.load(f)

# Subtitle URLs collected from CDP (all auth keys from the session)
# These need to match bvid to the essay list
# We'll pair them up

# First, create bvid -> title mapping
title_map = {}
for e in essays:
    title_map[e['bvid']] = e['title']

# Subtitle URL map - we need to provide these
# For now, let's just count what we have
print(f"Total essays in list: {len(essays)}")
print(f"Ready to save files to: {outdir}")

def clean_filename(title):
    title = re.sub(r'[\\/:*?"<>|]', '', title)
    if len(title) > 60:
        title = title[:60]
    return title

# This will be populated with subtitle data
# Each entry: bvid -> subtitle_text
subtitle_data = {}

print("Script ready. Run with subtitle data to save files.")
