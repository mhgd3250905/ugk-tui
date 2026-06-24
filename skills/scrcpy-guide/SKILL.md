---
name: scrcpy-guide
description: scrcpy 安卓投屏指南。涵盖检测/安装(winget)、启动投屏、录屏、常用参数、多设备选择、停止。环境为 Windows + Git Bash,adb 位于 E:\platform-tools。当用户提到投屏、scrcpy、手机画面、镜像屏幕、录屏手机、显示设备屏幕、scrcpy 安装等场景时使用本 skill；优先用 scrcpy 工具的 start/stop/status/version，bash 手动命令仅作兜底。
---

# scrcpy 安卓投屏指南

## 环境约定(重要)

- **系统**:Windows + Git Bash(pi 的 bash 工具走 `D:\Git\bin\bash.exe`)
- **adb 路径**:`E:/platform-tools/adb.exe`(本机 adb,与 adb-guide skill 一致)
- **★ 关键:必须让 scrcpy 复用本机 adb**,所有 scrcpy 命令都要带环境变量 `ADB=E:/platform-tools/adb.exe`。**否则 scrcpy 自带的 adb 会 kill 掉正在跑的 adb server、断开已连接的设备**(这是已知的雷区,scrcpy 官方 FAQ 也提到多 adb 版本冲突问题)。
- **有专用工具**:本包提供了 `scrcpy` 工具(见 extensions),已内置 `ADB` 环境变量和后台启动逻辑。**优先用 `scrcpy` 工具的 `start`/`stop`/`status`/`version` action**,需要自定义参数时用 `extraArgs` 透传。只有工具无法满足时才直接在 bash 里手敲命令。

---

## 第一步:检测与安装

> **新环境首选**:直接让用户跑 `/check-env` 命令,它会一键检测 adb / scrcpy / 设备连接,缺失项直接给 winget 安装命令。下面是手动流程,适用于 `/check-env` 不可用或需要细节排查时。

投屏依赖两样东西:**adb** 和 **scrcpy**。两者都可能缺失(尤其全新环境)。按顺序检测:

### 1.1 检测 adb(先决条件,scrcpy 要靠它连设备)

```bash
adb version 2>&1 | head -3            # 或全路径: E:/platform-tools/adb.exe version
```

- **出版本号** → adb OK,跳到 1.2。
- **找不到** → 装它:
  ```bash
  winget install Google.PlatformTools --accept-package-agreements --accept-source-agreements
  ```
  装完**新开 cmd 窗口**验证 `adb version`(旧窗口 PATH 没刷新)。装在 `E:/platform-tools` 的情况用全路径调用。

### 1.2 检测 scrcpy

```bash
scrcpy --version 2>&1 | head -5
```

- **能出版本号**(如 `scrcpy 4.0`)→ 已装,跳到「核心速查」开始投屏。
- **报 `'scrcpy' 不是内部或外部命令`** → 未装,按下面装。

### 1.3 用 winget 装 scrcpy(推荐)

```bash
winget install Genymobile.scrcpy --accept-package-agreements --accept-source-agreements
```

装完**验证**:

```bash
scrcpy --version
```

- 出版本号 → 成功。新开的 cmd 窗口 PATH 才生效(旧窗口看不到新加的 PATH)。
- 仍找不到 → 走手动下载兜底(见下)。

> **注意**:本包的 `scrcpy` 工具内置了 `findScrcpy()` 兜底,即使当前 shell 的 PATH 没刷新(winget 刚装完常见),工具也能从 winget 标准安装目录找到 scrcpy。手动命令则必须新开窗口。

### 手动下载兜底(winget 不可用时)

从官方 GitHub Releases 下载:`https://github.com/Genymobile/scrcpy/releases`
- Windows 选 `scrcpy-win64-vX.X.zip`
- 解压到 `E:/scrcpy/`(与 platform-tools 并列)
- 解压后把 `E:/scrcpy` 加入 PATH,或全程用全路径 `E:/scrcpy/scrcpy.exe`

---

## 核心速查(80% 场景)

### 启动投屏(最常用)

```bash
# 直接用专用工具(推荐,已内置 ADB 复用 + 后台启动):
#   调 scrcpy 工具,action=start

# 或在 bash 里手动启动(需自己带 ADB 环境变量 + 后台化):
ADB=E:/platform-tools/adb.exe scrcpy &
```

### 常用参数(透传给工具的 extraArgs,或手动追加)

| 参数 | 作用 |
|---|---|
| `--max-size 1280` | 限制长边分辨率(默认原分辨率,降一点减卡顿、减带宽) |
| `--max-fps 30` | 限制最高帧率 |
| `--record E:/out.mp4` | 录屏到文件(关闭投屏时正常落盘) |
| `--no-audio` | 不传音频(音频卡顿/杂音时用) |
| `--stay-awake` | 投屏期间保持设备不息屏 |
| `--turn-screen-off` | 物理屏幕关闭,只在电脑上看(省电防烧屏) |
| `-s <serial>` | 多设备时指定目标(如 `-s QSG6Q8IFDMDELVGQ`) |
| `--always-on-top` | 投屏窗口置顶 |
| `--window-title "xxx"` | 自定义窗口标题 |

示例组合(手动):

```bash
ADB=E:/platform-tools/adb.exe scrcpy --max-size 1280 --max-fps 30 --stay-awake &
```

### 多设备

先列出设备,再用 `-s` 指定:

```bash
E:/platform-tools/adb.exe devices -l
ADB=E:/platform-tools/adb.exe scrcpy -s <serial> &
```

### 停止投屏

```bash
# 用专用工具:调 scrcpy 工具,action=stop
# 或手动:
taskkill //IM scrcpy.exe //F      # Git Bash 里 // 转义斜杠;cmd 里用 /IM /F
```

直接关 scrcpy 窗口也行。

---

## 录屏注意事项

- 用 `--record E:/out.mp4`,**路径用正斜杠**(`E:/out.mp4`)。
- 录屏时**必须正常关闭**(关窗口或 taskkill `/F`),文件才会完整落盘。
- 想要无预览窗口纯录屏:`--no-display --record E:/out.mp4`。

---

## 工作原则(给 agent 的提示)

1. **先确认设备在线**:投屏前必跑 `E:/platform-tools/adb.exe devices -l`,确认设备 `device` 状态(不是 `offline`/`unauthorized`)。
2. **务必复用本机 adb**:手动命令必须带 `ADB=E:/platform-tools/adb.exe`;用专用工具则已自动处理。不带会导致设备连接被冲断。
3. **后台启动**:scrcpy 是常驻前台进程,手动启动**务必 `&` 后台化或用工具的 `start`**(工具用 detached spawn + unref),否则会卡住 bash 工具。
4. **卡顿时降参数**:优先 `--max-size 1280`、`--max-fps 30`、必要时 `--no-audio`。详见 `references/troubleshooting.md`。
5. **录屏落盘**:提醒用户正常关闭,避免文件损坏。

---

## 详细参考(按需读取)

遇到下表场景时,用 `read` 工具读取对应文件。

| 场景 | 文件 |
|---|---|
| adb server 冲突 / device offline / 黑屏 / 卡顿调优 / 音频问题 | `references/troubleshooting.md` |
