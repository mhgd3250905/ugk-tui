# 设备连接参考

## 查看设备

```bash
adb devices -l          # 列出设备,带详情(型号、传输类型、产品名)
adb devices             # 简洁列表
```

输出格式:
```
List of devices attached
<serial>    state    (usb:xxx product:xxx model:xxx transport_id:N)
```

**设备状态含义**:
| state | 含义 |
|---|---|
| `device` | 正常,可操作 |
| `offline` | 设备未响应(重启 adb 或重插线) |
| `unauthorized` | 手机没点「允许 USB 调试」 |
| `recovery` | 在 recovery 模式 |
| `sideload` | 在 sideload 模式 |
| `fastboot` | 在 fastboot 模式(用 `fastboot devices` 看) |
| `no permissions` | Linux 上 udev 权限问题(Windows 不常见) |

---

## USB 连接

1. **手机开开发者选项**:设置 → 关于手机 → 连续点「版本号」7 次
2. **开 USB 调试**:设置 → 系统/更多设置 → 开发者选项 → USB 调试 = 开
3. **插 USB 线**(数据线,不是纯充电线)
4. **手机弹窗**「允许 USB 调试?」→ 勾「始终允许」→ 确定
5. 电脑端 `adb devices` 应出现设备号

**小米/MIUI 额外**:还需开「USB 调试(安全设置)」才能用 adb 装应用/改设置。
**华为/鸿蒙**:部分机型需登录华为账号才开调试。
**vivo/OPPO**:开发者选项藏在「更多设置」,且需验证码。

---

## 无线连接

### 方法 A:Android 10 及以下(先 USB 配)

```bash
# 1. 先用 USB 连上
adb devices                              # 确认在线
# 2. 设备监听 5555 端口
adb tcpip 5555
# 3. 查设备 IP:设置 → 关于手机 → 状态 → IP 地址,或
adb shell ip route                       # 查网关和网段
adb shell ifconfig wlan0 | grep inet     # 查 WiFi IP
# 4. 拔线,连接
adb connect 192.168.1.100:5555
adb devices                              # 应显示 <ip>:5555
```

### 方法 B:Android 11+ 无线调试(免 USB 配对)

1. 手机:开发者选项 → **无线调试** = 开
2. 点「使用配对码配对设备」→ 显示配对地址和 6 位配对码,例如 `192.168.1.100:43210  配对码 123456`
3. 电脑:
```bash
adb pair 192.168.1.100:43210            # 输入配对码
# 配对成功后,用「无线调试」主页显示的端口(注意:配对端口和连接端口不同!)
adb connect 192.168.1.100:43517         # 这个端口是主页上的,不是配对端口
adb devices
```

**端口易错点**:Android 11+ 的无线调试有**两个端口**——配对端口(临时,在配对页)和连接端口(在主页),两者不同。

### 断开无线
```bash
adb disconnect 192.168.1.100:5555       # 断指定
adb disconnect                          # 断所有无线
adb disconnect 192.168.1.100:5555 && adb connect 192.168.1.100:5555  # 重连
```

---

## 多设备管理

```bash
adb -s <serial> shell ...               # 指定设备(serial 是 devices 里的那一列)
adb -d shell ...                        # 只对 USB 设备
adb -e shell ...                        # 只对模拟器
adb -t <transport_id> shell ...         # 用 transport_id(devices -l 里有)
```

**批量操作所有设备**(bash 循环):
```bash
for d in $(adb devices | grep -v List | grep device$ | awk '{print $1}'); do
  echo "=== $d ==="
  adb -s "$d" shell getprop ro.product.model
done
```

---

## 连接故障排查

### unauthorized
- 手机上确认弹窗
- 或重置授权:`adb kill-server && adb start-server`(手机会重新弹窗)
- 清手机授权:`adb shell rm /data/misc/adb/adb_keys`(需 root),或手机里「撤销 USB 调试授权」

### offline
```bash
adb kill-server                         # 杀 adb 服务
adb start-server                        # 重启
adb devices                             # 再看
# 不行就:换数据线、换 USB 口、重启手机、重启电脑
```

### 设备完全不出现
- 检查「数据线」(很多线只能充电)
- Windows 设备管理器看有没有「Android ADB Interface」,黄色感叹号需装驱动(OEM USB 驱动)
- 通用驱动:Google USB Driver(Android Studio 里下载)

### no devices/emulator found
- 服务没起:`adb start-server`
- 端口被占:`netstat -ano | findstr 5037`(adb 默认 5037),杀掉占用进程

### 模拟器连不上
```bash
adb connect 127.0.0.1:7555              # MuMu
adb connect 127.0.0.1:62001            # 夜神
adb connect 127.0.0.1:21503            # 逍遥
adb connect 127.0.0.1:5555             # AVD / 通用
```

### 无线连上但不稳定
- 检查手机和电脑是否**同一 WiFi**
- 手机进省电模式会断 WiFi,关省电或插电
- 静态 IP 绑定(路由器)避免 IP 漂移

---

## 关闭/重启 adb 服务

```bash
adb kill-server                         # 杀服务(解决大多数连接异常)
adb start-server                        # 起服务
adb reconnect                           # 让离线设备重连
adb reconnect offline                   # 强制重置 offline 设备的连接
```

`adb` 命令首次执行会自动起服务,通常不需手动 `start-server`。只有排查问题时才用 `kill-server`。
