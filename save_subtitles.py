import json, os, re

# All collected subtitle data from first batch
data = json.loads(open('E:/AII/ugk-core/essay_list.json', 'r', encoding='utf-8').read())

# Create output directory
outdir = 'E:/AII/ugk-core/王暖胃_文章字幕'
os.makedirs(outdir, exist_ok=True)

# Map of bvid -> subtitle text (to be filled)
# For now, count what we have
print(f"Essay list has {len(data)} videos")
print(f"Output dir: {outdir}")

# Load subtitle data we've collected so far and save
# We'll need to do this after we have all the CDP results
print("Ready to save files once all subtitles are collected")
