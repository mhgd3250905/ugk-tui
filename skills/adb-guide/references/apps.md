# 应用管理参考

## 安装

```bash
adb install app.apk                      # 基本安装
adb install -r app.apk                   # 覆盖安装,保留数据和缓存
adb install -R app.apk                   # 覆盖安装,保留应用数据并跳过验证
adb install -g app.apk                   # 自动授予所有运行时权限
adb install -r -g app.apk                # 覆盖 + 授权
adb install -d app.apk                   # 允许降级(versionCode 比已装的低)
adb install -t app.apk                   # 允许测试包
adb install -s app.apk                   # 装到内部共享存储(少用)
adb install -f app.apk                   # 装到内部系统内存
adb install --bypass-low-target-sdk-block app.apk  # 绕过 targetSdk 过低拦截(Android 14+)
adb install --no-incremental app.apk     # 不用增量安装
adb install -p base.apk                  # 推迟安装(用于分包先推)
adb install-multiple base.apk config.arm64.apk     # 安装 Split APK(分包)
adb install-multiple -r base.apk config.en.apk config.arm64.apk  # 覆盖安装分包
adb install-existing com.example.app     # 重新安装曾被装过、后被卸载的应用
```

**常见安装错误码**:
| 代码 | 含义 | 处理 |
|---|---|---|
| INSTALL_FAILED_ALREADY_EXISTS | 已装且没加 -r | 加 `-r` |
| INSTALL_FAILED_OLDER_SDK | APK 要求更高 Android | 装低版本 APK 或升级系统 |
| INSTALL_FAILED_INSUFFICIENT_STORAGE | 空间不足 | 清空间 |
| INSTALL_FAILED_INVALID_APK | APK 损坏 | 重新下载/签名 |
| INSTALL_FAILED_UID_CHANGED | 卸载残留 | `adb uninstall` 后重装,或 `pm uninstall` 强制 |
| INSTALL_FAILED_VERSION_DOWNGRADE | 降级 | 加 `-d` |
| INSTALL_FAILED_VERIFICATION_FAILURE | 验证失败 | 加 `-t` 或关验证 |
| INSTALL_PARSE_FAILED_NO_CERTIFICATES | 未签名 | 用 apksigner 签名 |
| INSTALL_FAILED_DEXOPT | dex 优化失败 | 清空间、清 dalvik-cache(需 root) |
| INSTALL_FAILED_SHARED_USER_INCOMPATIBLE | sharedUser 冲突 | 改包名或卸载冲突应用 |

**从电脑端直装下载的 APK**(常见工作流):
```bash
adb install -r -g E:/APK/app-release.apk
```

---

## 卸载

```bash
adb uninstall com.example.app            # 卸载
adb uninstall -k com.example.app         # 卸载但保留数据和缓存目录
```

**卸载系统应用(需 root)**:
```bash
adb shell pm uninstall -k --user 0 com.android.providers.calendar  # 对当前用户卸载(不真删)
adb shell pm disable-user --user 0 com.example.app                 # 禁用
```
> 「`--user 0` 卸载」是禁用系统应用的常用技巧,不需 root,但只对当前用户生效。

---

## 查询应用

```bash
adb shell pm list packages                        # 所有应用
adb shell pm list packages -3                     # 只第三方
adb shell pm list packages -s                     # 只系统应用
adb shell pm list packages -d                     # 被禁用的
adb shell pm list packages -e                     # 启用的
adb shell pm list packages -u                     # 含已卸载(uninstalled)
adb shell pm list packages --show-versioncode     # 显示版本号
adb shell pm list packages | grep -i wechat       # 按关键字找
adb shell pm list packages -f | grep example      # 带 APK 路径
```

### 查某个应用的详情
```bash
adb shell pm path com.example.app                 # APK 安装路径(可能多个,分包)
adb shell pm list packages -f | grep com.example  # 同上,格式不同
adb shell dumpsys package com.example.app         # 完整详情(权限、签名、Activity、版本……很长)
adb shell dumpsys package com.example.app | grep -E "versionName|targetSdk|firstInstallTime"  # 关键字段
```

### 找当前前台应用(查包名神器)
```bash
# Android 10 之前
adb shell dumpsys activity activities | grep mResumedActivity
# Android 10+
adb shell dumpsys activity activities | grep ResumedActivity
# 通用(查当前焦点窗口)
adb shell dumpsys window | grep -E "mCurrentFocus|mFocusedApp"
```

---

## 启动 / 停止应用

```bash
adb shell am start -n com.example.app/.MainActivity             # 启动指定 Activity
adb shell am start -n com.example.app/.MainActivity --es key value  # 带 extra
adb shell am start -a android.intent.action.VIEW -d "https://example.com"  # 隐式 Intent(打开网址)
adb shell am start -a android.intent.action.VIEW -d "content://..." -t "image/*"  # 打开图库
adb shell monkey -p com.example.app -c android.intent.category.LAUNCHER 1  # 用 monkey 启动主 Activity(不用知道类名)
adb shell am force-stop com.example.app                        # 强制停止
adb shell am kill com.example.app                              # 杀后台进程(不杀前台)
adb shell pm clear com.example.app                             # 清除数据(等于应用重置)
```

**启动 Service / 发广播**:
```bash
adb shell am startservice -n com.example.app/.MyService
adb shell am broadcast -a com.example.MY_ACTION --es msg "hello"
```

---

## 权限管理

```bash
adb shell pm grant com.example.app android.permission.CAMERA    # 授予权限
adb shell pm revoke com.example.app android.permission.CAMERA   # 撤销权限
adb shell dumpsys package com.example.app | grep -A1 "runtime permissions"  # 查运行时权限状态
adb shell pm reset-permissions com.example.app                 # 重置权限为默认
```

**危险权限组**(授予一个同组自动授):READ/WRITE_CONTACTS、READ/WRITE_CALENDAR、CAMERA、RECORD_AUDIO、ACCESS_FINE/COARSE_LOCATION、READ/WRITE_EXTERNAL_STORAGE 等。

---

## 备份 / 恢复应用数据

```bash
adb backup -f E:/backup.ab -noapk com.example.app    # 备份数据(非 root)
adb restore E:/backup.ab                              # 恢复
# -noapk 不含 APK;-apk 含 APK;-all 全部;-shared 含共享存储
```
> 注意:`adb backup` 在 Android 12+ 已废弃,不可靠。完整备份建议用 root 直接 tar,或用 `references/advanced.md` 里的方案。

---

## APK 分析(电脑端)

```bash
# 看 APK 信息(需 aapt,在 Android SDK build-tools 里)
aapt dump badging app.apk | grep -E "package|launchable-activity|sdkVersion"
# 看 APK 签名(需 apksigner)
apksigner verify --print-certs app.apk
# 解包/重打包(需 apktool)
apktool d app.apk -o app_src/
apktool b app_src/ -o app_new.apk
```
> aapt/apksigner/apktool 不在 platform-tools 里,需单独装(Android Studio 的 build-tools 或 apktool 官网)。
