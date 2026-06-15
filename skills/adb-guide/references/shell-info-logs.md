# Shell / 设备信息 / logcat 参考参考

## 进入交互 shell
```bash
adb shell                              # 进入设备 shell(ls/cd/cat 等都可用,exit 退出)
adb shell <单条命令>                    # 不进入,直接执行一条
adb root                               # 以 root 重启 adbd(仅 userdebug/eng 版本可用,正式版会拒绝)
adb su -c "<命令>"                      # 部分机器用 su 提权(root 后)
adb shell su -c 'cat /data/...'        # 嵌套引号注意
```

### 可用目录(无 root)
- `/sdcard/`(=`/storage/emulated/0/`)用户文件
- `/data/local/tmp/` 临时(可写,常用于放测试程序)
- `/system/bin/`、`/system/xbin/` 系统命令

### 需 root 才能访问
- `/data/data/<包名>/` 应用私有数据
- `/data/system/` 系统设置
- 完整的 `/proc/<pid>/`

---

## 设备信息(getprop / wm)

### 系统属性(最全)
```bash
adb shell getprop                       # 全部属性(几千条,配合 grep)
adb shell getprop ro.product.model      # 机型,如 SM-G998B
adb shell getprop ro.product.brand      # 品牌
adb shell getprop ro.product.manufacturer  # 厂商
adb shell getprop ro.product.name       # 产品名
adb shell getprop ro.product.device     # 设备代号
adb shell getprop ro.build.version.release   # Android 版本,如 14
adb shell getprop ro.build.version.sdk      # API Level,如 34
adb shell getprop ro.build.id           # 构建号
adb shell getprop ro.build.fingerprint  # 完整指纹(刷机包匹配用)
adb shell getprop ro.serialno           # 序列号
adb shell getprop ro.hardware           # 硬件平台
adb shell getprop ro.product.cpu.abi    # CPU 架构,如 arm64-v8a
adb shell getprop ro.bootloader         # bootloader 版本
adb shell getprop ro.build.type         # user/userdebug/eng
adb shell getprop ro.build.tags         # release-keys(正式)/test-keys(测试/root 常见)
adb shell getprop persist.sys.timezone  # 时区
adb shell getprop ro.product.locale     # 语言地区
```

### 屏幕
```bash
adb shell wm size                      # 分辨率,如 "Physical size: 1080x2400"
adb shell wm size 720x1280             # 临时改分辨率(重启恢复)
adb shell wm density                   # DPI,如 "Physical density: 420"
adb shell wm density 560               # 改 DPI
adb shell wm overscan 0,0,0,0          # 调整显示区域
adb shell dumpsys display | grep -E "DisplayDeviceInfo|density"  # 详细
```

### 硬件
```bash
adb shell cat /proc/cpuinfo | grep -E "processor|Hardware"   # CPU
adb shell cat /proc/meminfo | head -3                        # 内存(MemTotal KB)
adb shell df -h                                              # 所有分区
adb shell df -h /data                                        # 用户存储
adb shell ls -l /dev/block/by-name/                          # 分区名(root)
adb shell cat /sys/class/power_supply/battery/capacity       # 电量 %
adb shell cat /sys/class/power_supply/battery/status         # 充电状态
adb shell dumpsys battery                                    # 电池详情(推荐)
adb shell dumpsys battery set level 50                       # 模拟电量(测试用,reset 恢复)
adb shell dumpsys sensorservice | grep -i "sensor" | head    # 传感器列表
adb shell service call iphonesubinfo 1                       # IMEI(Android 12+ 受限)
adb shell getprop gsm.baseband.version                       # 基带
```

### 网络
```bash
adb shell ip addr                       # 所有网卡
adb shell ifconfig wlan0                # WiFi 网卡
adb shell ip route                      # 路由(含网关)
adb shell ip route | grep default        # 默认网关
adb shell getprop dhcp.wlan0.gateway     # 旧式取网关
adb shell settings get secure wifi_ssid  # 当前 WiFi 名(需权限)
adb shell dumpsys wifi | grep -i "SSID\|ip"  # WiFi 详情
adb shell netcfg                         # (旧命令,部分版本无)
```

---

## logcat(日志)

### 实时 vs 非实时
```bash
adb logcat                             # 实时,持续输出(Ctrl+C 停)
adb logcat -d                          # 非实时,输出当前缓冲区后退出(导出用)
adb logcat -d > E:/logs/all.txt        # 导出到文件
adb logcat -d | tail -500              # 只看最近 500 行
adb logcat -d *:E > E:/logs/error.txt  # 只 Error 级别
```

### 优先级过滤
级别:`V`(Verbose) < `D`(Debug) < `I`(Info) < `W`(Warn) < `E`(Error) < `F`(Fatal) < `S`(Silent)

```bash
adb logcat *:W                         # Warn 及以上
adb logcat *:E                         # Error 及以上
adb logcat *:I ActivityManager:I *:S   # 只看 ActivityManager 的 Info(filter tag)
adb logcat -s MyTag                    # 只看 MyTag(等价 MyTag:V *:S)
adb logcat -s MyTag:* OtherTag:*       # 多 tag
```

### 按 tag
```bash
adb logcat -s MyTag:V                  # 单 tag
adb logcat MyTag:I *:S                 # 同上,显式 silent 其他
adb logcat -v threadtime MyTag         # 时间+线程格式
```

### 输出格式(-v)
```bash
adb logcat -v brief      # 默认: tag/level
adb logcat -v process    # 带 PID
adb logcat -v tag        # tag:level
adb logcat -v thread     # 带 PID TID
adb logcat -v raw        # 只有消息
adb logcat -v time       # 带日期时间
adb logcat -v threadtime # PID TID 日期 时间(最常用,排查问题首选)
adb logcat -v long       # 带分隔的全部
```

### 多缓冲区
```bash
adb logcat -b main       # 主(默认)
adb logcat -b system     # 系统
adb logcat -b radio      # 电话/基带
adb logcat -b events     # 事件统计
adb logcat -b crash      # 崩溃(Java)
adb logcat -b kernel     # 内核(需支持)
adb logcat -b all        # 所有
adb logcat -b main -b system   # 多个
adb logcat -b crash -d   # 看崩溃缓冲区(找 ANR/FC 神器)
```

### 过滤关键字
```bash
adb logcat | grep -i "exception"       # 含 exception(大小写不敏感)
adb logcat | grep -iE "fatal|crash"    # 多关键字
adb logcat -d | grep -A10 "FATAL EXCEPTION"  # FATAL 后 10 行(含堆栈)
adb logcat -d | grep -B2 -A20 "AndroidRuntime"  # 前 2 后 20 行
```

### 清空 / 循环 / 持久化
```bash
adb logcat -c                          # 清空缓冲区
adb logcat -c -b crash                 # 清崩溃缓冲区
adb logcat -G 16M                      # 设缓冲区大小 16MB(默认通常 256K-2M)
adb logcat -r 10 -f /sdcard/log.txt -n 5 -v threadtime *:V  # 循环写文件,保留 5 个 10MB 轮转
```

### 查特定应用日志(PID 过滤)
```bash
PID=$(adb shell pidof com.example.app)         # 拿 PID
adb logcat --pid=$PID                          # 只看该 PID(Android 7+)
# 或
adb logcat -v threadtime | grep " $PID "
```

---

## bugreport(完整诊断)

```bash
adb bugreport E:/bugreport.zip         # 生成完整 bug 报告(很慢,几分钟;输出大,几十 MB)
# 含:dumpsys、logcat、系统属性、ANR trace、截图等
```

报告里关键文件:
- `dumpsys.txt` 全部 dumpsys 输出
- `dmesg.txt` 内核日志
- `FS/.../anr_*` ANR 记录
- `bugreport-*.txt` 主报告

`bugreport` 很重,只在需要全面排查(给 ROM 开发者反馈、找系统级 bug)时用。日常用 `dumpsys <服务>` 更轻。

---

## dumpsys(服务信息总览)

```bash
adb shell service list                 # 所有可 dumpsys 的服务
adb shell dumpsys -l                   # 列出服务名
adb shell dumpsys | head -50           # 总览(超大)
```

### 常用服务
```bash
adb shell dumpsys activity activities | grep -E "ResumedActivity|mFocusedApp"  # 当前前台
adb shell dumpsys activity top | head -50         # 栈顶 Activity
adb shell dumpsys window | grep -E "mCurrentFocus|mFocusedApp"   # 当前窗口
adb shell dumpsys package com.example.app         # 应用详情(权限、组件)
adb shell dumpsys batterystats                    # 电池统计(自上次充满)
adb shell dumpsys batterystats --reset            # 重置电池统计
adb shell dumpsys battery                         # 实时电池
adb shell dumpsys meminfo                         # 内存总览
adb shell dumpsys meminfo com.example.app         # 某应用内存
adb shell dumpsys cpuinfo                         # CPU 占用
adb shell dumpsys gfxinfo com.example.app         # 渲染/GC
adb shell dumpsys gfxinfo com.example.app framestats   # 帧时序(测掉帧)
adb shell dumpsys netstats                        # 网络流量统计
adb shell dumpsys notification                    # 通知栏
adb shell dumpsys alarm                           # 定时任务(应用耗电排查)
adb shell dumpsys location                        # 定位请求
adb shell dumpsys procstats                       # 进程统计(内存压力)
adb shell dumpsys input                           # 输入设备
adb shell dumpsys surfaceflinger                  # 显示合成器(分辨率、刷新率)
adb shell dumpsys power                           # 电源/休眠
adb shell dumpsys sensorservice                   # 传感器
adb shell dumpsys wifi                            # WiFi 状态
adb shell dumpsys connectivity                    # 网络
adb shell dumpsys telephony.registry              # 电话/信号
```

---

## 完整 keyevent 列表

常用已列在 SKILL.md。完整见 [KeyEvent 源码常量](https://developer.android.com/reference/android/view/KeyEvent)。常用补充:

| 码 | 含义 | 码 | 含义 |
|---|---|---|---|
| 5 | 拨号 | 6 | 挂断 |
| 7-16 | 数字 0-9 | 17 | * |
| 18 | # | 19-22 | 上/下/左/右(方向键) |
| 23 | DPAD 中心(确认) | 27 | 拍照 |
| 28 | 清除 | 29-54 | A-Z |
| 55-56 | , . | 61 | TAB |
| 62 | 空格 | 64 | 回车 |
| 66 | 回车 | 67 | 退格 |
| 81 | + | 82 | 菜单 |
| 84 | 搜索 | 111 | ESC |
| 113 | CapsLock | 122-123 | Home/End |
| 124 | 插入 | 164 | 静音 |
| 168 | 播放/暂停 | 169-171 | 上一首/下一首/停止 |
| 176 | 打开 | 187 | 最近任务 |
| 207 | 联系人 | 208 | 日历 |
| 210 | 邮件 | 211 | 计算 |
| 220 | 亮度+ | 221 | 亮度- |
| 276 | 关闭电源 | 277 | 切断电源 |

`--longpress`:长按。例 `adb shell input keyevent --longpress 26`。
