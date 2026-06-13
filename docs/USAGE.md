# 使用说明

## 1. 准备工作

安装并确认以下内容可用：

- Windsurf
- Node.js 18 或更高版本
- 一个可用的 API Key

在 PowerShell 中可以用下面的命令检查 Node.js：

```powershell
node --version
```

## 2. 连接配置

打开程序后，先进入“连接配置”。

默认首次启动会使用：

```text
服务商模板：OpenAI 格式
接口地址：https://api.openai.com/v1
接口类型：OpenAI Responses
默认模型：gpt-5.5
```

常见配置示例：

### OpenAI 官方 API

```text
接口地址：https://api.openai.com/v1
接口类型：OpenAI Responses
默认模型：gpt-5.5
```

### DeepSeek 官方 API

```text
接口地址：https://api.deepseek.com/v1
接口类型：OpenAI Chat
默认模型：deepseek-chat
```

### OpenAI 兼容中转站

```text
接口地址：https://your-relay.example.com/v1
接口类型：OpenAI Chat 或 OpenAI Responses
默认模型：按你的中转站模型 ID 填写
```

### Anthropic 兼容接口

```text
接口地址：https://api.anthropic.com/v1
接口类型：Anthropic Messages
默认模型：claude-sonnet-4-5
```

如果上游没有写明模型 ID，先点击“拉取模型列表”。如果拉取失败，只能查看上游文档或控制台后台的模型名称。

## 3. 测试连接

填写接口地址、API Key、默认模型和接口类型后，点击“测试连接”。

测试成功说明：

- API Key 可用。
- 接口地址能访问。
- 模型名称大概率正确。
- 当前接口类型基本匹配。

测试请求默认发送 `ping`，期望模型回复类似 `pong`。这只是连通性测试，不代表真实对话质量。

## 4. 安装补丁

点击“安装补丁”后，程序会把 Windsurf 的 Cascade 请求地址改为本机代理地址。

默认本地端口是：

```text
127.0.0.1:3009
```

如果修改了本地端口，需要重新安装补丁并重启 Windsurf。

## 5. 启动代理

点击“启动代理”或“启动并打开 Windsurf”。

如果勾选“启动后打开 Windsurf”，按钮会显示“启动并打开 Windsurf”；否则显示“启动代理”。

程序关闭时：

- 选择“退出应用”：停止本程序启动的代理。
- 选择“最小化到托盘”：代理继续运行。

## 6. 模型路由

模型路由用于把 Windsurf 内部模型 ID 分配给不同上游。

操作方式：

1. 进入“模型路由”。
2. 点击“新增路由”。
3. 填写 Windsurf 模型 ID。
4. 填写上游接口地址、API Key、上游模型和接口类型。
5. 保存。

Windsurf 模型 ID 可以手动填写，也可以从预设下拉框选择。程序也支持“从日志发现模型”。

首次启动默认不会自动生成模型路由。没有配置路由时，所有未命中的请求都会走“连接配置”里的默认上游。

## 7. 推理和思考设置

不同接口使用不同参数：

| 接口类型 | 程序显示 | 实际发送 |
| --- | --- | --- |
| OpenAI Responses | 推理强度 | `reasoning.effort` |
| OpenAI Chat | 推理强度 | `reasoning_effort` |
| Anthropic Messages | 思考模式 / 思考强度 / 思考预算 | `thinking` / `output_config.effort` |

不是所有模型都支持所有强度。如果上游返回不支持参数，程序会自动去掉思考参数重试一次，并在日志中记录。

## 8. 恢复补丁

如果不想继续使用本地代理，点击“恢复补丁”，然后重启 Windsurf。

如果 Windsurf 更新后功能异常，也建议先恢复补丁，再重新安装补丁。
