# scrcpy 排错参考

按需查阅。先确认 adb 设备在线、scrcpy 版本能正常输出。

---

## 1. adb server 版本冲突(最常见)

**症状**:`adb server version (XX) doesn't match this client (YY)`、或启动 scrcpy 后 `adb devices` 变空、设备掉线。

**根因**:系统里存在多个 adb(Android Studio、VS Code、scrcpy 自带各一份),版本不一致时会互相 kill 对方的 server 再重启。

**解决**:
```bash
# 1) 确认 scrcpy 命令带了 ADB 环境变量,指向本机 platform-tools 的 adb
ADB=E:/platform-tools/adb.exe scrcpy ...

# 2) 若已掉线,重置 adb server 重连
E:/platform-tools/adb.exe kill-server
E:/platform-tools/adb.exe start-server
E:/platform-tools/adb.exe devices
```

**预防**:本包的 `scrcpy` 工具已内置 `ADB=E:/platform-tools/adb.exe`,优先用工具。

---

## 2. device offline / unauthorized

**症状**:`adb devices` 显示 `offline` 或 `unauthorized`。

**解决**:
```bash
E:/platform-tools/adb.exe kill-server
E:/platform-tools/adb.exe start-server
E:/platform-tools/adb.exe devices -l
```
- `unauthorized`:手机上点「允许 USB 调试」弹窗;或拔插数据线。
- `offline`:换数据线/USB 口;无线连接的确认手机电脑同网段。

详见 adb-guide 的 `references/connection.md`。

---

## 3. 黑屏 / 无画面

**症状**:scrcpy 窗口打开但黑屏,或立刻退出。

**排查**:
- 确认设备屏幕**已解锁**(锁屏可能不渲染)。
- 确认设备非 `offline`。
- 部分国产 ROM 需在「开发者选项」开启「USB 调试(安全设置)」才允许录屏/投屏。
- 老旧设备不支持某些编码,试 `--video-codec omx` 或 `--video-encoder` 指定编码器。

---

## 4. 卡顿 / 掉帧调优

按优先级试:
```bash
ADB=E:/platform-tools/adb.exe scrcpy --max-size 1280 --max-fps 30 --no-audio &
```
- `--max-size 1280`:降分辨率(默认原分辨率,如 2K/4K 会很重)。
- `--max-fps 30`:限帧。
- `--no-audio`:关音频(音频常是卡顿主因)。
- `--video-buffer 50`:增大视频缓冲(单位 ms,抗抖动)。
- 有线连接优先于无线;无线投屏确保 5GHz WiFi。

---

## 5. 音频问题

- **无声/杂音**:`--no-audio` 先确认画面 OK;再排查音频。Android 11+ 才原生支持音频转发。
- **延迟大**:音频转发现有固有延迟,可 `--no-audio` 仅看画面。
- `--audio-codec` / `--audio-bit-rate` 可调编码参数。

---

## 6. scrcpy 命令找不到(安装后 PATH 问题)

- winget/choco 装完后,**已开着的 cmd 窗口看不到新 PATH**,要新开窗口。
- 查实际安装位置:`where scrcpy`(新窗口)或 winget 安装日志。
- 找不到就用全路径,如 `E:/scrcpy/scrcpy.exe`。

---

## 7. 录屏文件损坏 / 0 字节

- **必须正常关闭 scrcpy**(关窗口或 `taskkill /IM scrcpy.exe`),`--record` 才会完整封装 mp4。
- 强杀进程(`/F`)通常仍能落盘,但极端情况下可能损坏。
- 纯录屏无预览:`--no-display --record E:/out.mp4`。
