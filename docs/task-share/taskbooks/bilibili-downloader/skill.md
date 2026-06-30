# B站视频下载

## 输入
- `bilibili_url`：B站视频URL，格式如 `https://www.bilibili.com/video/BVxxxxxx/`

## 输出
- 保存到 `$TASK_OUTPUT_DIR/{标题}/{标题}_{BV号}.mp4`
- `$TASK_OUTPUT_DIR` 由 contract.outputDir 决定（运行时默认值）
- 子目录名 = 视频标题（不含BV号）
- 文件名 = `{标题}_{BV号}.mp4`

## 步骤

### 1. 提取BV号
从URL中提取BV号：`/video\/(BV[\w]+)/`

### 2. CDP获取视频信息
**必须使用chrome_cdp工具，不得通过bash或其他方式调用CDP**
```javascript
chrome_cdp({ action: 'navigate', url: bilibili_url })
const info = chrome_cdp({
  action: 'evaluate',
  expression: 'JSON.stringify({title: document.title, playInfo: window.__playinfo__})'
})
```

### 3. 清理标题
- 移除后缀 `_哔哩哔哩_bilibili`
- 移除首尾空格

### 4. 解析DASH流URL
从 `playInfo.data.dash` 中提取：
- 视频流：`video[0].baseUrl`（最高画质）
- 音频流：`audio[0].baseUrl`

### 5. 创建输出目录
```bash
mkdir -p "$TASK_OUTPUT_DIR/{标题}"
```

### 6. 下载流
```bash
curl -L -o video.m4s -H "User-Agent: Mozilla/5.0 ..." -H "Referer: https://www.bilibili.com/" "${videoUrl}"
curl -L -o audio.m4s -H "User-Agent: Mozilla/5.0 ..." -H "Referer: https://www.bilibili.com/" "${audioUrl}"
```

### 7. 合并为mp4
```bash
ffmpeg -i video.m4s -i audio.m4s -c:v copy -c:a copy -movflags +faststart "$TASK_OUTPUT_DIR/{标题}/{标题}_{BV号}.mp4" -y
```

### 8. 清理临时文件
删除 `video.m4s` 和 `audio.m4s`

## 注意事项
- 必须使用chrome_cdp工具进行浏览器操作，不得通过bash或其他方式调用CDP
- B站页面可能跳转，需重新导航
- DASH URL有时效性，需及时下载
- 需要Chrome已登录B站（高画质需要）
- 需要安装 ffmpeg