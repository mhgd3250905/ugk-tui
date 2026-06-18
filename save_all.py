import os, json, re

outdir = 'E:/AII/ugk-core/王暖胃_文章字幕'
os.makedirs(outdir, exist_ok=True)

# All collected subtitle data (bvid -> text mapping)
# This will be filled from the CDP results
# For now, just show the structure
print(f"Output directory: {outdir}")
print("Ready to save files")

# Clean filename helper
def clean_filename(title):
    # Remove problematic chars for Windows filenames
    title = re.sub(r'[\\/:*?"<>|]', '', title)
    title = title.replace('"', '').replace('"', '')
    if len(title) > 80:
        title = title[:80]
    return title

# Placeholder - actual data will be populated
count = 0
print(f"Saved {count} files to {outdir}")
