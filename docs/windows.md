# Windows 注意事项

[← 返回 README](../README.md)

本插件不区分平台：`lib/` 里没有任何硬编码路径或平台分支，Windows 与 WSL/Linux 跑的是
同一份代码。这份文档只记 **Windows 上会踩到的坑**，以及在 Windows 上验过什么。

结论先放这儿：

- **运行时没有平台差异** —— 界面、按钮位置、卡片定位、凭据发现都一样（见
  [运行时](#运行时没有平台差异)）。
- **安装有一个 Windows 专属的坑**：用**本地路径**装、且源码与 `$DSH_HOME` **不在同一块盘**时，
  pnpm 会建出一个坏链接，安装整体失败（见下一节）。走 GitHub 安装不受影响。

## 本地路径安装：跨盘会建出坏链接

### 症状

`DSH_HOME` 在 `C:`、插件源码在 `F:` 时：

```powershell
dsh plugin --profile web add F:\project\tools\plugin\dsh-commandcode-quota
```

pnpm 这一半是成功的，但随后的 `reconcile` 会抛错、命令以 exit 1 结束：

```
dependencies:
+ dsh-commandcode-quota link:F:/project/tools/plugin/dsh-commandcode-quota
Done in 1.6s using pnpm v10.20.0

Error: dsh: cannot resolve profile bundle "dsh-away-notify" from the dsh installation
       or C:\Users\27045\.dsh\profiles\web
```

注意报的是**另一个** bundle。新包此时只写进了 `package.json` 的 `dependencies`，
**没有**进 `dsh.profile.bundles`——等于没装上。

### 根因

三层叠起来：

1. **junction 的目标是「相对路径」。** pnpm 给 `node_modules\<包>` 建的 junction，目标被
   Windows 按「链接所在目录」解析，于是实际指向一个不存在的路径：

   ```
   <JUNCTION> dsh-commandcode-quota [C:\Users\27045\.dsh\profiles\web\F:\project\tools\plugin\dsh-commandcode-quota]
   ```

2. **只有跨盘才会这样。** pnpm 用 `path.relative()` 算链接目标；同一块盘时它算出的是正确的
   相对路径（`..\..\..\dsh-commandcode-quota`），跨盘时只能返回绝对串 `F:\project\...`，
   而这个串在 junction 里又被当成相对目标。所以「profile 与源码同在 `F:`」的隔离环境里
   一次就成功，真实 profile 必失败。
   DSH 侧的 `anchorPathSpec`（`@deepseek-ai/dsh-plugin-manager` 的 `lib/types/operations.js`）
   只重写**相对**路径（`./x`、`../x`），绝对路径原样交给 pnpm，这一层也拦不住。

3. **失败会连坐。** `reconcile` 必须先把 profile 里**既有**的 bundle 全部解析成功，才能把新包
   追加进 `bundles`。上例里的 `dsh-away-notify` 同样是坏的跨盘链接 → 解析抛错 → 整个命令失败。
   而且**每次** `dsh plugin add` 都会让 pnpm 重新链接一遍，把手工修好的链接再次改坏。

> 顺带一提：profile 里只要有这种坏链接，DSH 启动时会**静默跳过**它——
> `dsh --profile web --dump-config` 会打印 `skipping profile bundle "..."`，
> 而插件本身不报错。上例中的 `dsh-away-notify` 就是这样连续几次启动都没加载。

### 自检

```powershell
$nm = "$env:USERPROFILE\.dsh\profiles\web\node_modules"

# 链接好不好：能取到 package.json 才是好的
Test-Path "$nm\dsh-commandcode-quota\package.json"

# profile 能不能组合：出现 skipping 就是有坏链接
dsh --profile web --dump-config | Select-String 'skipping|dsh-commandcode-quota'
```

### 修复

```powershell
$nm = "$env:USERPROFILE\.dsh\profiles\web\node_modules"

# rmdir 不带 /s：只摘掉 reparse point，绝不动源码目录
cmd /c "rmdir `"$nm\dsh-commandcode-quota`""
New-Item -ItemType Junction -Path "$nm\dsh-commandcode-quota" `
         -Target 'F:\project\tools\plugin\dsh-commandcode-quota'
```

然后把包名补进 profile 的 `dsh.profile.bundles`（这一步就是 `reconcile` 本该做的事）：

```json
"bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-away-notify",
  "dsh-commandcode-quota"
]
```

同样的处理要**对每一个本地链接的插件都做一遍**：任何一个坏链接都会让
`dsh plugin add` 整体失败。修完重启 `dsh web` 生效。

### 建议

- **装插件优先走 GitHub**（README 里的那条）：pnpm 把仓库取进 store 再落盘，不涉及跨盘链接，
  Windows 上直接可用。
- 想保留「改源码即时生效」的开发方式，就把源码放在与 `$DSH_HOME` **同一块盘**上；
  跨盘的话，按上面手工修好之后**别再跑 `dsh plugin add/install`**。
- 上游修复方向：`dsh plugin add` 收到绝对路径时，应把它规范成 pnpm 能正确处理的形式
  （例如 `file:` URL 或同盘相对路径），或在建链后校验链接可达。

## 运行时没有平台差异

以下都在 Windows 上实测过，与 WSL 一致：

- **凭据发现**：`~/.dsh/.credentials.yaml` 由 `os.homedir()` 解析，Windows 上得到
  `%USERPROFILE%`；`DSH_HOME` 环境变量、profile 的 `cordis.patch.yml` 路由照常生效。
  配置文件按 `/\r?\n/` 切行，CRLF 不影响解析。
- **路径拼接**：全部走 `node:path` 的 `join`/`basename`，没有硬编码 `/`。
- **按钮与卡片**：插槽 `conversation.session.header.utilities` 与 `position: fixed` 的卡片
  定位都是纯 CSS，无平台差异。
- **空白会话不显示按钮**：与 WSL 上一致，Windows 上同样是 DSH 头部处于 `headerBlank`
  变体、不渲染工具行。

## 测试

```powershell
node --test    # 32 项，全部离线
```

Windows 上也是 **32 / 32 通过**。`tests/quota.test.mjs` 的假文件系统原本用 POSIX 绝对路径
（`/dsh/...`）当键，而 `lib/quota.js` 用 `node:path.join` 拼路径，Windows 上拼出 `\dsh\...`
导致三个凭据发现用例假失败；现在 `fakeFs` 会把两侧的 `\` 都折成 `/` 再比对，夹具保持
POSIX 写法不变。这只影响测试夹具——生产路径由 `join` 一致生成、再用同一字符串读盘，本来
就是正确的。

## Windows 验收记录

在**隔离的 `DSH_HOME`**（临时目录）与独立端口上验的，不碰日常实例与配置：

| 检查项 | 结果 |
|---|---|
| `dsh plugin add <包目录>`（同盘） | ✅ exit 0，junction 目标正确，`dsh.profile.bundles` 自动追加 |
| `--dump-config` 组合出的 loader 树 | ✅ 含 `- id: dsh-commandcode-quota`，无 `skipping` |
| 宿主路由 `/api/dsh-commandcode-quota` | ✅ 200 + 真实四端点数据 |
| 无鉴权 cookie 的裸请求 | ✅ 401 |
| 凭据发现（真实 Windows home） | ✅ 命中 `credentials:COMMANDCODE_API_KEY` |
| 客户端 bundle 加载 | ✅ `<style id="dsh-commandcode-quota-style">` 恰好注入一次 |
| 页面内同源 `fetch` 打宿主路由 | ✅ 200 + 真实数据 |
| 会话头部按钮（已开始的会话） | ✅ 渲染 1 个，位置正确 |
| 点开卡片 | ✅ 268×430，视口内，数据与宿主返回逐项一致 |
| 插件清单页 | ✅ 「已安装」下列出本插件 |
| JS 异常 / `console.error` | ✅ 全程 0 / 0 |
| 与 `dsh-away-notify` 同时装载 | ✅ 两个插件共同启动、互不干扰 |

环境：Windows 10/11 · DSH 0.1.7-rc.2 · Node v24.11.0 · PowerShell 5.1 · pnpm 10.20.0
· Chrome 153（headless + CDP 驱动页面验收，与 [开发文档](development.md#验收记录) 里
Linux 那一轮同一套做法）。
