# 网络参考(端口转发 / 反向代理 / 抓包)

## 端口转发(forward)

**方向:电脑 → 设备**。电脑访问 `localhost:8080` 时,流量转到设备上的 `8080`。

```bash
adb forward tcp:8080 tcp:8080           # 电脑 8080 → 设备 8080
adb forward tcp:8080 localabstract:mysocket  # 设备 abstract unix 域 socket
adb forward tcp:8080 localreserved:mysock     # 保留命名空间
adb forward tcp:8080 jdwp:<pid>         # Java 调试(连 DDMS/调试器到设备上某 app 的 JDWP)
adb forward --list                       # 列出所有转发规则
adb forward --remove tcp:8080           # 移除某条
adb forward --remove-all                # 移除全部
```

**典型场景**:
- 设备上跑了个 web 服务(如 React Native packager),电脑浏览器访问:`adb forward tcp:8080 tcp:8080` → 浏览器开 `http://localhost:8080`
- 调试 WebView:配合 Chrome `chrome://inspect`

---

## 反向代理(reverse)

**方向:设备 → 电脑**。设备访问 `localhost:3000` 时,流量转到电脑的 `3000`。

```bash
adb reverse tcp:3000 tcp:3000           # 设备 3000 → 电脑 3000
adb reverse --list
adb reverse --remove tcp:3000
adb reverse --remove-all
```

**典型场景**:
- 设备上的 app 访问电脑上的后端 API(开发联调),app 里写 `http://10.0.2.2:3000` 只对模拟器有效;真机用 `adb reverse tcp:3000 tcp:3000`,app 里就能 `http://localhost:3000`
- React Native 真机调试:`adb reverse tcp:8081 tcp:8081`,手机访问 Metro packager

**forward vs reverse 记忆**:
- forward = 电脑要访问设备的服务
- reverse = 设备要访问电脑的服务

---

## 网络信息查询

```bash
adb shell ip addr                       # 所有网卡
adb shell ifconfig wlan0                # WiFi
adb shell ifconfig eth0                 # 有线(部分设备)
adb shell ip route                      # 路由
adb shell ip route | grep default        # 默认网关
adb shell cat /proc/net/route           # 路由表(原始)
adb shell netcfg                        # 旧命令(部分版本无)

adb shell settings get global http_proxy       # 当前 HTTP 代理
adb shell settings put global http_proxy :0     # 清代理(:0)
adb shell settings put global http_proxy 192.168.1.50:8888   # 设代理(抓包用)

adb shell dumpsys connectivity            # 网络连接详情
adb shell dumpsys wifi | grep -i "current SSID\|Ip"  # WiFi
adb shell dumpsys netstats                # 流量统计
adb shell cat /proc/net/dev               # 各网卡收发字节
```

---

## 抓包(Packet Capture)

### 方案 A:tcpdump(需 root 或抓自身 app)
```bash
# 把 tcpdump 推到设备(可执行 ARM 二进制)
adb push tcpdump /data/local/tmp/
adb shell chmod +x /data/local/tmp/tcpdump
adb shell su -c "/data/local/tmp/tcpdump -i any -s 0 -w /sdcard/capture.pcap"
# Ctrl+C 停,然后拉到电脑用 Wireshark 分析
adb pull /sdcard/capture.pcap E:/captures/
```

### 方案 B:HTTP 代理(抓 HTTP/HTTPS,无需 root)
```bash
# 电脑上跑 Charles/Fiddler/mitmproxy(假设在 192.168.1.50:8888)
adb shell settings put global http_proxy 192.168.1.50:8888   # 手机走代理
# HTTPS 需在手机装代理的 CA 证书(Charles 的 chls 可导出,Android 7+ 默认不信用户 CA,需 app 配 network_security_config)
# 抓完清代理
adb shell settings put global http_proxy :0
```

### 方案 C:VPN 抓包 app(免 root,推荐日常)
- [PCAPdroid](https://github.com/emanuele-f/PCAPdroid):开 VPN 在手机本地抓,导出 pcap
- [HttpCanary](https://www.httpcanary.com/):直接抓 HTTPS,装证书

### 方案 D:iftop / nethogs(实时流量,需 root)
```bash
adb shell su -c "iftop"        # 实时连接流量
```

---

## VPN / 路由调试

```bash
adb shell dumpsys connectivity | grep -A5 "VPN"   # VPN 状态
adb shell ip rule                              # 路由策略
adb shell iptables -L -n -v 2>/dev/null        # 防火墙(需 root)
```

---

## 测速 / 连通性

```bash
adb shell ping -c 4 8.8.8.8             # ping(PING 不一定有,部分精简 ROM 无)
adb shell ping -c 4 baidu.com           # 测 DNS + 连通
adb shell ping6 -c 4 ipv6.google.com    # IPv6(若有)
adb shell nc -z -w2 192.168.1.10 8080 && echo OK   # 测端口连通(若有 nc)
adb shell curl -s http://example.com 2>/dev/null | head   # (Android 8+ 内置 curl 可能不全)
```

---

## 实用:把设备当代理服务器(电脑走手机网络)

```bash
# 电脑通过 adb forward 访问设备上的代理 app(如 SocksDroid 等)
adb forward tcp:1080 tcp:1080
# 电脑浏览器/软件设 socks5://localhost:1080
```

---

## 模拟网络环境(测试用,需 root)

```bash
adb shell settings put global airplane_mode_on 1    # 开飞行模式(需广播才生效)
adb shell am broadcast -a android.intent.action.AIRPLANE_MODE
adb shell svc wifi disable                          # 关 WiFi(root)
adb shell svc wifi enable                           # 开 WiFi
adb shell svc data disable                          # 关移动数据
adb shell svc data enable
```
