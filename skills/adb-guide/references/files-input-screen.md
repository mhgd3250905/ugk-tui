# 文件传输 / 输入控制 / 截屏录屏参考

## 文件传输

### 基本命令
```bash
adb push <电脑路径> <手机路径>          # 电脑 → 手机
adb pull <手机路径> <电脑路径>          # 手机 → 电脑
```

**路径写法**(Git Bash 环境):
- 电脑端用正斜杠:`E:/APK/app.apk`、`./local.txt`
- 手机端用 Linux 路径:`/sdcard/`、`/data/local/tmp/`

### 常见目录
| 手机路径 | 含义 |
|---|---|
| `/sdcard/` 或 `/storage/emulated/0/` | 内置存储根(用户文件) |
| `/sdcard/Download/` | 下载 |
| `/sdcard/DCIM/Camera/` | 相机照片 |
| `/sdcard/Pictures/` | 图片 |
| `/sdcard/Music/` | 音乐 |
| `/sdcard/Movies/` | 视频 |
| `/data/local/tmp/` | 临时目录(可读写,无需 root) |
| `/data/data/<包名>/` | 应用私有数据(需 root) |

### 拉整个目录(注意末尾)
```bash
adb pull /sdcard/DCIM/ E:/Photos/        # 拉 DCIM 整个目录到 E:/Photos/DCIM/
adb pull /sdcard/DCIM/. E:/Photos/dcim/  # 只拉内容,不含 DCIM 这层(注意 /.)
```

### 同步大批量文件
adb 没有增量同步,但可结合 `tar`:
```bash
# 打包后传(快)
adb shell tar -czf - /sdcard/DCIM/Camera 2>/dev/null | tar -xzf - -C E:/Photos/
```

### 传输大文件慢/中断
- 换高质量数据线
- `adb push` 单线程加密传输有上限,无线更慢;超 GB 级建议直接 MTP 或读卡器
- 报错 `protocol failure`:目标目录权限/空间问题,`adb shell df -h <目录>` 看空间

---

## 输入控制(input)

### 点击 / 滑动
```bash
adb shell input tap 500 800                      # 点击 (x=500, y=800)
adb shell input swipe 500 1500 500 300 300       # 从(500,1500)滑到(500,300),300ms
adb shell input swipe 700 1000 700 1000 500      # 「长按」=起止同点 + 长时长
adb shell input swipe 100 500 900 500 200        # 快滑(右滑)
```

### 获取坐标
```bash
# 开发者选项 → 开启「指针位置」,屏幕顶部显示当前触摸坐标
# 或截屏后用图片工具量(分辨率要一致)
adb shell wm size                                # 看分辨率
adb shell wm density                             # 看密度(DPI)
```

### 文本输入
```bash
adb shell input text "hello"                     # 输入英文/数字/符号(ASCII)
adb shell input text "hello%sworld"              # 空格用 %s
```
**不支持中文/Unicode**。中文方案见下方「中文输入」。

### 按键(keyevent)
```bash
adb shell input keyevent 26                      # POWER
adb shell input keyevent 3                       # HOME
adb shell input keyevent 4                       # BACK
adb shell input keyevent 82                      # MENU
adb shell input keyevent 24                      # 音量+
adb shell input keyevent 25                      # 音量-
adb shell input keyevent 164                     # 静音
adb shell input keyevent 187                     # 切换应用(最近任务)
adb shell input keyevent 220                     # 亮度+
adb shell input keyevent 277                     # 切断电源
adb shell input keyevent --longpress 26          # 长按电源键
```

### 组合手势 / 多点触控(sendevent / motionevent)
复杂手势用 `input motionevent` 或底层 `sendevent`(慢,且需查设备节点),不常用。复杂自动化建议用:
- [input-macro](https://github.com/) 类应用
- UI Automator / Appium(跨进程自动化)
- 直接写 Android app 用 `AccessibilityService`

---

## 中文输入(关键问题)

`adb shell input text` **不支持中文**。三种解决方案:

### 方案 1:剪贴板粘贴(最简单)
```bash
# 用 ADBKeyBoard 或类似工具,或:
# 1. 把中文复制到手机剪贴板(通过 push 文本文件 + 读取)
echo -n "你好" > /tmp/zh.txt
adb push /tmp/zh.txt /data/local/tmp/zh.txt
adb shell input text "$(cat /data/local/tmp/zh.txt)"   # 仍可能乱码
```

### 方案 2:ADBKeyBoard(推荐)
装一个特殊输入法 [ADBKeyBoard](https://github.com/senzhk/ADBKeyBoard),支持 `am broadcast` 传中文:
```bash
adb install ADBKeyboard.apk
adb shell ime enable com.android.adbkeyboard/.AdbIME
adb shell ime set com.android.adbkeyboard/.AdbIME
adb shell am broadcast -a ADB_INPUT_B64 --es msg "$(echo -n '你好' | base64)"
# 用完切回原输入法
adb shell ime set com.iflytek.inputmethod/.MainActivity   # 例如讯飞
```

### 方案 3:用 UI Automator(需 app 配合)
不推荐,复杂。

---

## 截屏 / 录屏

### 截屏
```bash
adb shell screencap -p /sdcard/screen.png        # 截屏存到手机
adb pull /sdcard/screen.png E:/screens/          # 拉到电脑
# 一行版(直接拉到电脑)
adb exec-out screencap -p > E:/screens/screen.png
```
> `exec-out` 直接输出二进制,不经文件,推荐。但 Windows 的 Git Bash 下重定向可能有 CRLF 问题,若 PNG 损坏,改用「先存手机再 pull」。

### 录屏
```bash
adb shell screenrecord /sdcard/demo.mp4          # 开始录(Ctrl+C 停)
adb shell screenrecord --time-limit 30 /sdcard/demo.mp4        # 限 30 秒
adb shell screenrecord --bit-rate 8000000 /sdcard/demo.mp4     # 码率 8Mbps(默认 4Mbps,越高越清晰)
adb shell screenrecord --size 1080x1920 /sdcard/demo.mp4       # 分辨率
adb shell screenrecord --verbose /sdcard/demo.mp4              # 详细日志
# 录完拉到电脑
adb pull /sdcard/demo.mp4 E:/videos/
```
**录屏限制**:
- 最长 180 秒(3 分钟),超时自动停
- 不录声音(系统限制)
- 部分设备 DRM 内容会黑屏(Netflix 等)
- 长录屏用循环录:`screenrecord` 起多个进程,或用第三方 app

### 截屏 + 录屏组合工作流(自动化测试常用)
```bash
# 启动 app → 等待 → 截图 → 录屏 5 秒
adb shell am start -n com.example.app/.MainActivity
sleep 3
adb exec-out screencap -p > E:/test/launch.png
adb shell screenrecord --time-limit 5 /sdcard/op.mp4 && adb pull /sdcard/op.mp4 E:/test/
```

---

## 剪贴板

```bash
# Android 10+ 限制应用读剪贴板,需用 input keyevent paste 或 input text
adb shell input keyevent 279          # Ctrl+V(粘贴,光标在输入框)
# 读剪贴板(Android 9 及以下,或 root)
adb shell service call clipboard 1 i32 1 i32 0 i32 0
# 更可靠:用 ADBKeyBoard 的 broadcast
```

---

## 实用:批量截图定时任务

```bash
# 每 5 秒截一张,共 12 张(1 分钟)
for i in $(seq 1 12); do
  adb exec-out screencap -p > "E:/screens/shot_$(printf %02d $i).png"
  sleep 5
done
```
