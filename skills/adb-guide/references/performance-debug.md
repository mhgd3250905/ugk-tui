# 性能分析 / 调试参考

## 进程

```bash
adb shell ps -A                        # 所有进程(Android 7+ 用 -A,旧版用 ps 不带参数)
adb shell ps -A | grep com.example.app # 找某应用进程
adb shell ps -A -o PID,NAME,RSS        # 自定义列
adb shell pidof com.example.app        # 拿 PID(可能有多个进程)
adb shell pgrep -f com.example         # 同上,部分版本
adb shell top                          # 实时(类似 Linux,q 退出)
adb shell top -m 10                    # 占用最高 10 个进程
adb shell top -m 10 -n 1               # 只跑一次就退出(-n 1,适合脚本)
adb shell top -p <pid>                 # 只看某进程
adb shell htop                         # (若有)
```

### 杀进程
```bash
adb shell kill <pid>                   # 普通 kill(需权限)
adb shell kill -9 <pid>                # 强杀
adb shell am force-stop com.example.app   # 按包名强停(推荐,不需 PID)
adb shell pkill com.example            # (若有 pkill)
```

---

## 内存

### 系统总览
```bash
adb shell cat /proc/meminfo | head -5
# MemTotal/MemFree/MemAvailable/Cached/SwapCached...
adb shell free -h                      # (若有)
adb shell cat /proc/pressure/memory    # 内存压力(Android 11+)
```

### 某应用内存(dumpsys meminfo,最常用)
```bash
adb shell dumpsys meminfo com.example.app
# 关键行:
#   TOTAL PSS:        该进程总 PSS(实际占用)
#   Native Heap       Native 堆
#   Dalvik Heap       Java 堆
#   .so mmap .dex mmap ... mmap  共享库映射
#   TOTAL SWAP PSS    Swap 占用
#   Objects(Views, ViewRootImpl, AppContexts, Activities)  对象数(内存泄漏排查)
adb shell dumpsys meminfo --package com.example.app --local  # 详细(按 Allocation 类型)
adb shell dumpsys meminfo --procrank  # (有 procrank 时)PSS/USS 排名
```

### 所有应用内存排名
```bash
adb shell dumpsys meminfo --sort PSS | head -30   # 按 PSS 排序(Android 版本支持时)
adb shell procrank | sort -k5 -rn | head          # (需 procrank,部分 ROM 无)
```

### 内存泄漏排查
1. 反复操作 UI(进/出页面)
2. `adb shell dumpsys meminfo <pkg>` 记录 Objects.Views / Activities 数量
3. 若反复操作后 View/Activity 持续增长不回落,疑似泄漏
4. 进一步:`dumpsys meminfo <pkg> -d` 看 `SQL` `DATABASE` `ASSETMANAGER` 等
5. dump heap:`kill -10 <pid>`(SIGUSR1 触发 hprof,存 `/data/misc/` 需 root),或用 Android Studio Profiler

### GC 频繁
```bash
adb shell dumpsys gfxinfo com.example.app | grep -A20 "total frames"  # 含 GC 统计
adb logcat -s ART *:V | grep GC          # 看 GC 日志(需 ART verbose)
```

---

## CPU

```bash
adb shell dumpsys cpuinfo               # 总览(各进程 CPU%)
adb shell dumpsys cpuinfo | head -30
adb shell top -m 10                     # 实时 CPU 排名
adb shell cat /proc/stat | head -2      # 系统 CPU 时间片
adb shell cat /proc/<pid>/stat          # 某进程 CPU
adb shell cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq   # 各核频率
adb shell dumpsys gfxinfo com.example.app | grep -A5 "Janky frames"   # 卡顿帧(渲染)
```

---

## 渲染 / 掉帧(卡顿分析)

```bash
adb shell dumpsys gfxinfo com.example.app
# 关键:
#   Total frames rendered: N
#   Janky frames: X (Y%)        ← 掉帧比例(>5% 就卡)
#   50th/90th/95th/99th percentile: ...   ← 帧耗时分布
adb shell dumpsys gfxinfo com.example.app framestats   # 每帧详细时序(导出分析)
adb shell dumpsys SurfaceFlinger --latency "SurfaceView"   # 表面帧延迟
# GPU 渲染分析:开发者选项 → GPU 呈现模式分析 → 在屏幕上显示
```

---

## 流量 / 电量分析

```bash
adb shell dumpsys batterystats com.example.app    # 某应用电池统计
adb shell dumpsys batterystats --reset           # 重置(开始新一轮统计)
adb shell dumpsys batterystats > E:/battery.txt   # 导出(给 Battery Historian 分析)
# Battery Historian(google):https://bathist.ef.lc/  上传 txt 出图
adb shell dumpsys netstats --uid <uid>            # 某 UID 流量
adb shell dumpsys netstats                        # 总览
```

### 模拟条件(测试用)
```bash
adb shell dumpsys battery set level 15            # 电量设 15%
adb shell dumpsys battery set status 3            # 放电中
adb shell dumpsys battery unplug                  # 模拟拔电
adb shell dumpsys battery reset                   # 恢复
adb shell cmd thermalservice override-status 3    # 模拟过热(部分版本)
```

---

## ANR(应用无响应)/ 崩溃排查

### ANR trace
```bash
adb shell ls /data/anr/traces*                   # (需 root,或 bugreport)
adb shell cat /data/anr/traces.txt               # 读(需 root)
# 无 root 时用 bugreport:adb bugreport E:/b.zip,解压看 FS/data/anr/
adb logcat -b crash -d                           # Java 崩溃缓冲区
adb logcat -d | grep -A30 "FATAL EXCEPTION"
adb logcat -d | grep -B2 -A30 "ANR in"
```

### Native 崩溃(tombstone)
```bash
adb shell ls /data/tombstones/                   # 需 root
adb shell cat /data/tombstones/tombstone_xx
# 或 bugreport
```

---

## Systrace / Perfetto(系统级性能追踪)

```bash
# Perfetto(Android 10+ 官方,推荐)
adb shell perfetto -o /data/misc/perfetto-traces/trace.perfetto-trace -t 10s sched freq idle am wm
adb pull /data/misc/perfetto-traces/trace.perfetto-trace E:/traces/
# 上 https://ui.perfetto.dev/ 打开

# 旧版 systrace(Python,已弃用但仍可用)
python systrace.py -o trace.html -t 10 sched freq idle am wm gfx
```

---

## dumpsys 排查卡顿/耗电的常用组合

```bash
# 看哪个 app 持续唤醒
adb shell dumpsys alarm | grep -B1 "wakeups=" | head
# 看 location 持续请求的 app
adb shell dumpsys location | grep -B2 "request" | head -30
# 看后台仍运行的进程
adb shell dumpsys activity processes | grep -E "ProcessRecord|oom" | head -20
# 当前前台 + Activity 栈
adb shell dumpsys activity activities | grep -E "ResumedActivity|TaskRecord|Run #" | head -20
# 看 Service
adb shell dumpsys activity services com.example.app
```
