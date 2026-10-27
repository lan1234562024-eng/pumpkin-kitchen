# 把自己的 AI 接入南瓜厨房

本页适用于完整本地版。网页试玩中的演示队友由规则驱动，不需要配置模型。

在包含 `package.json` 的项目根目录完成 `npm ci`，再保持 `npm run dev` 运行。游戏页面为 `http://127.0.0.1:5173`，MCP 服务为 `http://127.0.0.1:5230/mcp`。

## 方式一：本地 Streamable HTTP

如果 AI 客户端支持访问同一台电脑上的 MCP HTTP 服务，添加一项连接：

| 字段 | 内容 |
|---|---|
| 名称 | `pumpkin-kitchen` |
| 传输方式 | Streamable HTTP |
| URL | `http://127.0.0.1:5230/mcp` |

这个本地端点不要求填写模型 API 密钥。保存后按客户端当前界面启用或重新加载连接，让 AI 先调用 `game_brief` 和 `game_observe`。

客户端的配置位置和字段会有所不同，应依据该客户端当前支持的方式配置。只增加这一项，不覆盖用户现有的全部 MCP 配置。

## 方式二：本地 stdio 桥

如果客户端支持启动本地 MCP 进程，可以使用仓库已有的 `src/mcp/stdio.ts`。它将请求转发到已经运行的本机后端，**不会另起一份游戏房间**。

在项目根目录手动运行桥的命令为：

```sh
npm run mcp
```

客户端配置中推荐使用绝对路径，避免依赖客户端的默认工作目录。下面是采用 `mcpServers` 格式的客户端常见模板；其他配置格式应由 AI 按当前客户端文档转换。

```json
{
  "mcpServers": {
    "pumpkin-kitchen": {
      "command": "node",
      "args": [
        "--import",
        "file:///C:/REPLACE_WITH_PROJECT_FOLDER/node_modules/tsx/dist/loader.mjs",
        "C:/REPLACE_WITH_PROJECT_FOLDER/src/mcp/stdio.ts"
      ]
    }
  }
}
```

替换两个 `REPLACE_WITH_PROJECT_FOLDER`，使其都指向实际包含 `package.json` 的项目目录。项目目录可以叫 `pumpkin-kitchen`，也可以使用其他名称；不要额外添加 `game/` 子目录。

- `command` 中的 `node` 必须能被客户端找到；否则填写已安装 Node 可执行文件的实际绝对路径。
- loader 参数是 **file URL**，Windows 示例中的 `file:///` 不可删除。
- 最后一项是 stdio 入口的普通文件路径。
- 如果客户端要求显式传输类型，再按它的格式添加 stdio 类型字段。
- 路径包含空格或特殊字符时，用 Node 的 `pathToFileURL` 生成 loader URL，不要手工拼接。

例如，在 Windows 终端生成 loader URL：

```bat
node -e "console.log(require('node:url').pathToFileURL(process.argv[1]).href)" "C:\REPLACE_WITH_PROJECT_FOLDER\node_modules\tsx\dist\loader.mjs"
```

其他操作系统同样使用实际绝对路径和对应的 file URL。保存配置后按客户端要求重载，游戏启动终端仍须保持运行。

## 云端客户端：使用自己的受保护通道

云端工具访问的 `127.0.0.1` 是它自己的运行环境，不是你的电脑。它需要你自己账号下的受保护 MCP 隧道，或具有适当访问控制的 HTTPS 入口。

本项目没有为使用者创建云端账号、隧道或托管服务。可以让有相应能力的 AI 按客户端与通道服务的官方说明协助配置，优先复用你已有且适用的资源。保持游戏后端仅监听本机，不关闭身份验证，不把访问凭据放入公开文件。

完成后以实际 `game_brief` 和 `game_observe` 调用为准判断连接，不能只凭通道显示在线就宣称成功。

## 从连接成功到开局

把 [AI-START-HERE.md](../AI-START-HERE.md) 交给 AI。先只读检查，再连接 AI 席位，并停在大厅。由你点击开始，随后告诉 AI 已开局；新回合要重新取得控制上下文。

## 常见问题

| 情况 | 先检查什么 |
|---|---|
| 页面打不开 | `npm run dev` 是否仍在运行，终端是否报错，5173 是否被已有实例占用 |
| 页面正常但工具不可用 | MCP URL 是否为 5230 的 `/mcp`，客户端是否能访问本机，工具是否已启用 |
| stdio 进程启动失败 | `node` 是否可找到，两个绝对路径是否正确，依赖是否已安装，loader 是否为 file URL |
| `FORBIDDEN` 或控制丢失 | 是否开了新局、超过租约时间、被人工接管或已有其他 AI 控制流 |
| 依赖安装失败 | Node 版本、网络与实际 npm 错误；不要通过删除锁文件或任意升级依赖来掩盖错误 |
| AI 停着不动 | 是正在等待用户开局、等待工具审批、思考下一步，还是工具实际返回了失败 |

保留必要错误信息即可，不分享原始加入响应、控制凭据或账号配置。端口冲突时先识别已有实例，不结束不明进程。
