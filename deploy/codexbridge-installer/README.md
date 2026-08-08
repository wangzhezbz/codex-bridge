# CodexBridge 软件管理测试环境

这套文件只服务于全新的隔离环境：

- 程序根目录：`/opt/shanhai/codexbridge-installer/`
- 测试目录：`https://shanhaiyouling.com/codexbridge-install-test/`
- 不可变包前缀：`https://shanhaiyouling.com/codexbridge-test/packages/`
- 旧资源迁移的隔离 COS 前缀：`https://codex-1431412335.cos.ap-guangzhou.myqcloud.com/codexbridge-test/packages/`

公开读取对象存储不需要访问令牌。RSA 私钥不是对象存储凭据；它只用于给目录字节签名，必须始终留在发布机的 root-only 目录。公开写入会允许第三方覆盖或删除对象，签名虽能阻止客户端安装被篡改的内容，却不能阻止拒绝服务，因此推荐公开读、发布机独占写。

## 前置条件

1. 把官方 Node.js 24 Linux x64 运行时解压到 `/opt/shanhai/codexbridge-installer/runtime/node/`；新服务只使用该目录内的 `node` 和 `npm`，不安装或修改系统全局 Node。
2. Linux 发布机具备 OpenSSL、nginx 和 `osslsigncode`。
3. 将本仓库的已审核版本放到 `/opt/shanhai/codexbridge-installer/app/`，使用隔离运行时执行 `PATH=../runtime/node/bin:$PATH ../runtime/node/bin/npm ci --omit=dev`。
4. 确认 `node_modules/7zip-bin/linux/<arch>/7za` 可执行。
5. 将 `nginx-test-location.conf` 作为一次新的 include 加入 `shanhaiyouling.com` 的 server 块；安装脚本只安装独立 snippet，不会自行编辑其他 server 配置。
6. 对象存储若以挂载目录提供，把 `/opt/shanhai/codexbridge-installer/public/` 指向该隔离挂载点；不要与任何现有目录共用。

部署包内固定了 Microsoft 官方的 `Microsoft Identity Verification Root Certificate Authority 2020` 公共根证书（SHA-1：`F40042E2E5F7E8EF8189FED15519AECE42C3BFA2`）。安装脚本只复制到新环境的 `trust/`，不会写入系统全局 CA；Linux 发布机使用签名中受信任的时间戳验证已过期但签名时有效的代码签名证书。

## 安装

在审核完文件、并记录现有环境的只读哈希后，以 root 执行：

```bash
cd /path/to/repository/deploy/codexbridge-installer
./install-test.sh
```

脚本仅创建新根目录、独立 systemd unit 和独立 nginx snippet。首次运行会生成一把新的 RSA 私钥，权限为 `0600`，并只在终端输出 SPKI 公钥和 SHA256 指纹。把输出的公钥和指纹提交到桌面客户端之前，不得发包。

## 发布与同步

- 手工发布 ChatGPT：设置 `CBI_SIGNING_KEY_FILE`、`CBI_PUBLIC_ROOT`、`CBI_PACKAGE_BASE_URL` 后运行 `npm run software:publish:chatgpt -- --input /absolute/package/tree --version X.Y.Z.W`。
- 手工发布 Skills：运行 `npm run software:publish:skills -- --input /absolute/skills/root --version X.Y.Z`。
- 迁移已有 ChatGPT/Skills：先运行 `import-legacy-assets.py` 规范化并校验旧包；大文件可用 `upload-cos-multipart.py --file ... --url ... --state ...` 断点续传，完成对象哈希复核后再运行 `npm run software:publish:imported -- --metadata ...` 签目录。
- 定时同步：`codexbridge-installer-sync.timer` 调用 `npm run software:sync`，同步 V2RayN 固定包和 Git for Windows 官方 x64 安装包。
- GitHub API 令牌是可选的，仅用于提高 API 限额；对象下载和客户端读取不需要它。

## 验证

植入客户端公钥后，只读执行：

```bash
node deploy/codexbridge-installer/verify-test.mjs
```

验证器只发出 GET/HEAD，请求目录、签名和不可变包，逐个校验长度与 SHA256，不进行上传或修改。
