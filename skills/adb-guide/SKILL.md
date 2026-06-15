---
name: adb-guide
description: Android adb 操作大全。涵盖连接(USB/无线)、应用安装管理、文件传输、输入控制、截屏录屏、shell 命令、设备信息、logcat 日志、端口转发/反向、性能分析、fastboot/root、备份与故障排查。用户在 Windows + Git Bash 环境,adb 位于 E:\platform-tools。当用户提到 adb、连接安卓、安装 APK、抓日志、投屏调试、操控手机、性能分析、fastboot 刷机等任何 Android 设备操作时使用本 skill。
---

# Android adb 操作大全

## 环境约定(重要)

- **系统**:Windows + Git Bash(pi 的 bash 工具走 `D:\Git\bin\bash.exe`)
- **adb 路径**:已加入 PATH,可直接 `adb ...`;必要时全路径 `E:/platform-tools/adb.exe`
- **路径写法**:在 bash 命令里,Windows 路径用正斜杠 `/` 或双反斜杠,例如 `E:/APK/app.apk`、`/sdcard/Download/`
- **命令前缀**:本 skill 所有命令默认 `adb` 开头。**多设备时**必须用 `-s <serial>` 指定目标设备,例如 `adb -s 192.168.1.100:5555 shell ...`

---

## 第一步:连接设备

详见 `references/connection.md`。

```bash
adb devices -l                    # 列出已连接设备(最常用,先跑这个)
```

- **USB 连接**:手机开「开发者选项 → USB 调试」→ 插线 → 手机弹窗点「允许」→ `adb devices` 出现设备号
- **无线连接(Android 11+)**:`adb pair <ip>:<port>` 配对 → `adb connect <ip>:<port>`
- **多设备**:用 `adb -s <serial>` 指定;`adb -d`(只 USB)、`adb -e`(只模拟器)
- **unauthorized**:手机没点「允许」,或 `adb kill-server && adb start-server` 重置授权

---

## 核心速查(80% 场景)

### 应用管理(详见 `references/apps.md`)
```bash
adb install app.apk                          # 安装
adb install -r app.apk                       # 覆盖安装(保留数据)
adb install -r -g app.apk                    # 覆盖 + 授予所有运行时权限
adb install -d app.apk                       # 允许降级
adb install-multiple app.apk base.apk        # 安装分包(Split APK)
adb uninstall com.example.app                # 卸载
adb uninstall -k com.example.app             # 卸载但保留数据
adb shell pm list packages                   # 列出所有包
adb shell pm list packages -3                # 只列第三方应用
adb shell pm list packages | grep <关键字>    # 按关键字找包名
adb shell pm path com.example.app            # 查 APK 安装路径
adb shell am force-stop com.example.app      # 强制停止应用
adb shell am start -n com.example.app/.MainActivity   # 启动指定 Activity
adb shell pm clear com.example.app           # 清除应用数据(等于恢复出厂)
```

### 文件传输(详见 `references/files-input-screen.md`)
```bash
adb push E:/APK/photo.jpg /sdcard/Pictures/   # 电脑 → 手机
adb pull /sdcard/DCIM/IMG_001.jpg E:/Photos/  # 手机 → 电脑
adb pull /sdcard/DCIM/. E:/Photos/dcim-backup/  # 拉整个目录(注意末尾 /.)
```

### 输入控制(详见 `references/files-input-screen.md`)
```bash
adb shell input tap 500 800                   # 点击屏幕坐标
adb shell input text "hello"                  # 输入文本(不支持中文,需分段或用剪贴板)
adb shell input keyevent 26                   # 按电源键(26=POWER)
adb shell input keyevent 3                    # 按 HOME(3)
adb shell input keyevent 4                    # 按 BACK(4)
adb shell input swipe 500 1500 500 300 300    # 上滑(参数:x1 y1 x2 y2 毫秒)
adb shell screencap -p /sdcard/screen.png && adb pull /sdcard/screen.png .  # 截屏并拉到电脑
```

### 设备信息 & 日志(详见 `references/shell-info-logs.md`)
```bash
adb shell getprop ro.product.model            # 机型
adb shell getprop ro.build.version.release    # Android 版本
adb shell getprop ro.product.manufacturer     # 厂商
adb shell wm size                             # 屏幕分辨率
adb shell dumpsys battery                     # 电池信息
adb shell dumpsys display | grep -i density   # 屏幕密度
adb shell df -h /data                         # 存储使用
adb logcat                                    # 实时日志(Ctrl+C 停止)
adb logcat *:E                                # 只看 Error 级别
adb logcat -s MyTag                           # 只看指定 Tag
adb logcat -d > E:/logs/crash.txt            # 导出当前日志到文件
adb logcat -d *:E | grep -A5 "FATAL"          # 找崩溃日志
adb bugreport E:/bugreport.zip                # 完整 bug 报告(大,慢)
```

### 性能 & 调试(详见 `references/performance-debug.md`)
```bash
adb shell top -m 10                           # 占用最高的 10 个进程
adb shell dumpsys meminfo com.example.app     # 某应用内存详情
adb shell dumpsys cpuinfo | head -30          # CPU 占用
adb shell dumpsys gfxinfo com.example.app     # 渲染性能/掉帧
adb shell ps -A | grep <关键字>               # 找进程 PID
adb shell cat /proc/<pid>/status              # 进程详情
```

### 网络(详见 `references/network.md`)
```bash
adb forward tcp:8080 tcp:8080                 # 电脑:8080 → 设备:8080(调 web 服务)
adb reverse tcp:3000 tcp:3000                 # 设备:3000 → 电脑:3000(设备访问电脑服务)
adb shell ifconfig wlan0                      # WiFi IP
adb shell netstat -tlnp 2>/dev/null | head    # 监听端口
```

---

## 详细参考(按需读取)

遇到下表场景时,先用 `read` 工具读取对应文件,里面有完整命令、参数说明、常见错误与排查。

| 场景 | 文件 |
|---|---|
| 连接/断开/多设备/无线配对/授权问题 | `references/connection.md` |
| 应用安装/卸载/查询/启动/清除数据/权限 | `references/apps.md` |
| 文件传输/模拟点击输入/截屏/录屏/剪贴板 | `references/files-input-screen.md` |
| shell 交互/设备信息/logcat/bugreport/属性 | `references/shell-info-logs.md` |
| 端口转发/反向代理/抓包/网络信息 | `references/network.md` |
| 性能分析/dumpsys/内存/CPU/渲染/ANR | `references/performance-debug.md` |
| fastboot 刷机/root/备份/系统操作/故障排查 | `references/advanced.md` |

---

## 常见 keyevent 代码速查

| 键码 | 含义 | 键码 | 含义 |
|---|---|---|---|
| 3 | HOME | 4 | BACK |
| 5 | 拨号 | 24/25 | 音量+/- |
| 26 | 电源 | 27 | 拍照 |
| 82 | 菜单 | 84 | 搜索 |
| 164 | 静音 | 220 | 亮度+ |
| 277 | 切断电源 | 187 | 切换应用 |

完整列表:用 `adb shell input keyevent` 后跟数字。要查全部,读 `references/shell-info-logs.md` 末尾。

---

## 工作原则(给 agent 的提示)

1. **先 `adb devices -l`**:任何 adb 操作前,先确认设备已连接且 authorized。
2. **操作前确认危险命令**:`pm clear`(清数据)、`uninstall`、`reboot`、`fastboot` 刷写、`rm` 等会改设备状态,执行前向用户复述并确认。包里已配权限门拦截 `rm -rf`,但 adb 危险操作仍需主动确认。
3. **路径用正斜杠**:Git Bash 环境,Windows 路径用 `/`(`E:/APK/`),避免转义问题。
4. **长输出截断**:`logcat`、`dumpsys`、`pm list` 输出极长,务必配合 `grep`/`head`/`-d`(logcat 非实时)/定向到文件。
5. **中文输入**:`adb shell input text` 不支持中文,用 `references/files-input-screen.md` 里的 ADBKeyBoard 或剪贴板方案。
6. **查不到包名时**:让用户在手机上打开该应用,然后 `adb shell dumpsys activity activities | grep mResumedActivity` 或 `adb shell dumpsys window | grep mCurrentFocus` 拿到当前前台包名。
