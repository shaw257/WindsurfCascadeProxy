# 配置说明

配置文件位于：

```text
%LOCALAPPDATA%\WindsurfCascadeProxy\Runtime\windsurf-proxy-config.json
```

一般不需要手动编辑配置文件。推荐在图形界面中修改。

## 主要字段

| 字段 | 含义 |
| --- | --- |
| `openaiBaseUrl` | 默认上游接口地址 |
| `openaiApiKey` | 默认 API Key |
| `openaiModel` | 默认上游模型 |
| `openaiWireApi` | 默认接口类型：`chat`、`responses`、`anthropic` |
| `port` | 本地代理端口 |
| `launchWindsurfOnStart` | 启动代理后是否打开 Windsurf |
| `modelRoutes` | 按 Windsurf 模型 ID 配置的路由表 |

首次启动时 `modelRoutes` 默认为空。需要单独路由某个 Windsurf 模型时，再在界面里手动新增。

## 接口类型

### `chat`

OpenAI Chat Completions 兼容接口。

常见路径：

```text
/v1/chat/completions
```

### `responses`

OpenAI Responses 兼容接口。

常见路径：

```text
/v1/responses
```

### `anthropic`

Anthropic Messages 兼容接口。

常见路径：

```text
/v1/messages
```

## 安全注意

当前版本为了易用性，API Key 明文保存在本机配置文件中。

请注意：

- 不要把配置文件上传。
- 不要截图公开 API Key。
- 共享日志前检查是否包含上游返回的敏感内容。
- 发现泄露后应立即在对应服务商后台撤销 Key。
