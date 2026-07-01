# B站UP主视频列表抓取

## 输入
- `url`: B站UP主主页视频标签链接，格式 `https://space.bilibili.com/{uid}/upload/video`（必填）
- `page`: 页码，从1开始（可选，默认1）

## 前置条件
- Chrome浏览器以调试模式运行（端口9222）
- 已安装 `pychrome` 库：`pip install pychrome`

## 执行步骤

运行脚本：
```bash
python bilibili_scraper.py "{url}" {page}
```

## 输出

输出文件：`bilibili_videos_page{page}.json`

JSON结构：
```json
{
  "url": "原始链接",
  "uid": "UP主uid",
  "page": 页码,
  "extract_time": "抓取时间 YYYY-MM-DD HH:MM:SS",
  "video_count": 视频数量,
  "videos": [
    {
      "title": "视频标题",
      "link": "视频链接",
      "time": "发布时间 YYYY-MM-DD HH:MM:SS"
    }
  ]
}
```

## 技术要点

- 使用 `pychrome` 连接 Chrome CDP (端口9222)
- 页面选择器：`.upload-video-card`
- 标题选择器：`.bili-video-card__title a`
- 时间选择器：`.bili-video-card__subtitle span`
- 页码跳转：输入框 `.vui_pagenation-go input[type="number"]` + Enter事件
- 时间格式处理：`MM-DD` 补全为当前年份，`YYYY-MM-DD` 保持不变
- **相对时间处理**：B站视频列表页的time字段可能是相对时间格式（如'19小时前'、'3天前'、'昨天'、'前天'等），需基于extract_time回推为绝对时间。注意部分条目尾部被JS拼接了' 00:00:00'字符串，匹配前需strip