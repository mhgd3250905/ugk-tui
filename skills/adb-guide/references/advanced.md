# 高级参考(fastboot / root / 备份 / 系统操作 / 故障排查)

> ⚠️ **本章多数操作有风险**(可能清空数据、变砖、丢保修)。执行前:
> 1. 向用户复述命令并明确确认
> 2. 务必备份(见下方备份章节)
> 3. 确认设备型号与 ROM 匹配(刷错包会变砖)

---

## 备份(动手前的标配)

### 应用数据(adb backup,Android 11 以下)
```bash
adb backup -f E:/backup/app.ab -apk com.example.app    # 含 APK + 数据
adb backup -f E:/backup/all.ab -apk -shared -all        # 全部 + 共享存储
adb backup -f E:/backup/app.ab -noapk -shared com.example.app
adb restore E:/backup/app.ab                            # 恢复
```
> Android 12+ adb backup 基本失效(系统不再信任)。需用 root 直接打包或厂商迁移工具。

### 文件备份(照片/文档)
```bash
adb pull /sdcard/DCIM/. E:/Backup/DCIM/         # 相册
adb pull /sdcard/Download/. E:/Backup/Download/
adb pull /sdcard/Pictures/. E:/Backup/Pictures/
adb pull /sdcard/Documents/. E:/Backup/Documents/
# 全部(慢,GB 级)
adb pull /sdcard/. E:/Backup/sdcard/
```

### 应用 APK + 数据(root)
```bash
PKG=com.example.app
APK=$(adb shell pm path $PKG | head -1 | cut -d: -f2)   # APK 路径
adb pull $APK E:/backup/$PKG.apk
adb shell su -c "tar -czf /sdcard/${PKG}_data.tar.gz /data/data/$PKG /data/media/0/Android/data/$PKG"
adb pull /sdcard/${PKG}_data.tar.gz E:/backup/
```

### 通讯录/短信(root 或厂商工具)
```bash
# 通讯录 vCard
adb shell content query --uri content://com.android.contacts/...  (复杂)
# 推荐用厂商工具:华为 HiSuite、小米 Mi Assistant、三星 Smart Switch
```

### 短信/通话记录(需 app 或 root)
应用「SMS Backup & Restore」之类最省事,导出 XML 后 adb pull。

---

## bootloadloader / fastboot 模式

### 进入 fastboot
```bash
adb reboot bootloader                  # 从系统进 fastboot
# 或关机后按 音量下 + 电源(机型不同组合不同)
fastboot devices                       # 确认连上(注意是 fastboot 命令,不是 adb)
```

### 解锁 bootloader(**会清空所有数据**)
```bash
# 标准 A/B 设备(Pixel、部分摩托、一加等)
fastboot flashing unlock
# 老设备
fastboot oem unlock
# 小米/红米:需先在 i.mi.com 申请解锁权限,用 MiUnlock 工具
# 索尼:需在 developer.sonymobile.com 申请解锁码
# 三星:基本不允许(美版/国行多数锁死)
# 华为:2018 后停止提供解锁码
```
解锁后设备会**自动 wipe**。开机后联网会重置,提前备份。

### 上锁(刷回官方)
```bash
fastboot flashing lock                 # 上锁(同样会 wipe)
# 部分:`fastboot oem lock`
```

---

## 刷写镜像(fastboot)

```bash
fastboot flash boot boot.img           # 刷 boot
fastboot flash system system.img       # 刷 system
fastboot flash vendor vendor.img       # 刷 vendor
fastboot flash recovery recovery.img   # 刷 recovery(TWRP 等)
fastboot flash radio radio.img         # 刷基带
fastboot boot boot.img                 # 不刷入,临时从镜像启动(测内核常用)
fastboot update ota.zip                # 整包 OTA 升级
fastboot erase boot                    # 擦除分区(危险)
fastboot format:ext4 userdata          # 格式化 data(清数据)
fastboot reboot                        # 重启回系统
fastboot reboot bootloader             # 回 bootloader
fastboot reboot recovery               # 进 recovery
```

**A/B 分区设备**:无 recovery 分区,刷 boot 即可。`fastboot getvar current-slot` 看当前槽位。

---

## Recovery 操作

```bash
adb reboot recovery                    # 进 recovery
# Recovery 下 adb 可能仍可用(sideload 模式)
adb reboot sideload                    # 进 sideload
adb sideload ota.zip                   # 推送 OTA 包刷入
```

TWRP 下:
```bash
adb shell twrp install /sdcard/magisk.zip   # TWRP 命令行装包
```

---

## root(Magisk)

```bash
# 1. 拿到当前 boot.img(从同版本 ROM 解包,或 payload.bin 提取)
# 2. 推到手机,用 Magisk app 给 boot.img 打补丁(生成 magisk_patched-xxx.img)
# 3. 拉到电脑
adb pull /sdcard/Download/magisk_patched-23000_xxxx.img E:/
# 4. 进 fastboot 刷
adb reboot bootloader
fastboot flash boot E:/magisk_patched-23000_xxxx.img
fastboot reboot
```

root 后用 root 命令:
```bash
adb shell su -c "id"                   # 验证 root(uid=0)
adb shell su -c "ls /data/data/"       # 访问应用私有数据
adb root                               # 尝试 root 模式 adbd(部分 ROM 可用)
```

---

## 完整系统备份/恢复(dd,需 root + unlocked)

```bash
# 列分区
adb shell su -c "ls -l /dev/block/by-name/"
# 备份 boot(刷机必备,救砖)
adb shell su -c "dd if=/dev/block/by-name/boot_a of=/sdcard/boot.img"
adb pull /sdcard/boot.img E:/backup/
# 备份 system(体积大)
adb shell su -c "dd if=/dev/block/by-name/system_a of=/sdcard/system.img bs=1M"
# 备份全部分区(超大,仅必要)
adb shell su -c "dd if=/dev/block/mmcblk0 of=/sdcard/mmcblk0.img bs=1M"
```

---

## 常用系统设置修改(settings)

```bash
adb shell settings list global            # 列全局设置
adb shell settings list system
adb shell settings list secure

adb shell settings put global stay_on_while_plugged_in 3    # 插电不锁屏(3=USB/AC/无线都算,1=AC)
adb shell settings put global development_settings_enabled 1
adb shell settings put global wifi_sleep_policy 2          # WiFi 永不睡眠(2=NEVER)
adb shell settings put global screen_off_timeout 600000    # 息屏超时 10 分钟(ms)
adb shell settings put secure screen_off_timeout 600000

# 动画速度(调节手感,不改性能)
adb shell settings put global window_animation_scale 0.5
adb shell settings put global transition_animation_scale 0.5
adb shell settings put global animator_duration_scale 0.5
# 0 = 关闭动画(最快但生硬)

# 默认输入法
adb shell ime list -s                     # 列所有输入法
adb shell ime set com.iflytek.inputmethod/.MainActivity
```

---

## 属性读写(setprop,部分需 root)

```bash
adb shell setprop debug.layout 1          # 显示布局边界(等同开发者选项)
adb shell setprop debug.gpu.overdraw show # 显示过度绘制
adb shell setprop debug.hwui.renderer opengl   # 改渲染器
adb shell setprop persist.sys.usb.config adb   # 改 USB 默认模式(部分版本)
# persist.* 开头的重启保留
```

---

## 设备重启 / 关机

```bash
adb reboot                    # 重启到系统
adb reboot bootloader         # 到 fastboot
adb reboot recovery           # 到 recovery
adb reboot sideload           # sideload
adb reboot restart            # 普通
adb shell reboot -p           # 关机(poweroff)
adb shell reboot bootloader
```

---

## 故障排查速查

| 症状 | 处理 |
|---|---|
| `adb devices` 空 | 换数据线/USB 口;装 OEM USB 驱动;`adb kill-server && adb start-server` |
| `unauthorized` | 手机确认弹窗;`adb kill-server`;清授权 `/data/misc/adb/adb_keys`(root) |
| `offline` | `adb reconnect offline`;重启手机;重启 adb server |
| 装应用 `INSTALL_FAILED_VERIFICATION_TIMEOUT` | 关 Play Protect,或 `adb install -t` |
| 装应用签名冲突 | 卸载旧版再装,或 `adb install -r` 覆盖(需同签名) |
| logcat 看不到某应用日志 | 确认应用未死(`pidof`),检查 SELinux `getenforce`,或 logcat 缓冲区被刷(调大 `-G`) |
| `adb forward` 端口被占 | `netstat -ano \| findstr <port>`,杀占用进程,或换端口 |
| wireless 连接频繁断 | 手机省电模式关;静态 IP;保持屏幕常亮 |
| fastboot 不识别 | Windows 驱动(Android Bootloader Interface),设备管理器看 |
| 变砖(开机循环) | 进 fastboot → 刷回原版 boot.img/system.img;无原版用 OTA 整包 |
| root 后 SafetyNet/Play Integrity 失败 | 装 Shamiko/MagiskHide,隐藏 root;部分银行 app 仍拒 |
| 降级安装被拒 | `adb install -d`;部分厂商禁止降级,需 root 改 |

---

## 安全清理(卖了/送人前)

```bash
adb shell am factory-reset                 # 出厂复位(部分版本)
fastboot -w                                # fastboot 下擦 userdata + cache
fastboot erase userdata
fastboot erase cache
# 然后开机完成初始化向导,不登录账号
```

> 物理清数据(防恢复)需多次覆盖,普通 wipe 对恢复软件有风险。极高敏感场景建议物理销毁存储芯片。

---

## adb 服务端调试

```bash
adb -P 5038 start-server          # 用非默认端口(避免冲突)
adb -H 127.0.0.1 -P 5038 devices  # 连指定地址端口
ADB_TRACE=all adb devices         # 全调试日志(排查连接问题)
adb version                       # 版本
adb host-features                 # 服务端特性
adb shell echo test               # 最简连通测试
```

---

## 实用脚本片段

### 等待设备就绪
```bash
adb wait-for-device                # 阻塞直到有设备
adb wait-for-device shell getprop sys.boot_completed   # 等开机完成
```

### 抓 ANR 自动化
```bash
(adb logcat -b crash -v threadtime *:E &) ; sleep 60 ; adb shell ls /data/anr/
```

### 启动 app 并等就绪
```bash
adb shell am start -W -n com.example.app/.MainActivity
# -W 等待启动完成,返回 ThisTime/TotalTime/WaitTime(Launch 性能)
```

### 录屏 + 日志同步(回归测试常用)
```bash
adb logcat -c                       # 清日志
adb shell screenrecord /sdcard/t.mp4 &
LOGPID=$!
adb shell monkey -p com.example.app 1   # 操作
sleep 10
kill $LOGPID
adb pull /sdcard/t.mp4 E:/test/
adb logcat -d > E:/test/log.txt
```
