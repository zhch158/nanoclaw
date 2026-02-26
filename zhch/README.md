# zhch 本地运行说明（LiteLLM + launchd）

本文说明三个问题：

1. `zhch/litellm-config.yaml` 在哪里定义、如何生效
2. `plist` 在哪里定义、如何加载
3. 日常如何启动、重启、排查

## 1) LiteLLM 配置文件定义位置

- 仓库内配置模板：`zhch/litellm-config.yaml`
- launchd 实际使用路径：`/Users/zhch158/.config/litellm/config.yaml`

`zhch/com.litellm.plist` 中的关键参数是：

- `--config /Users/zhch158/.config/litellm/config.yaml`
- `--port 4000`

这意味着：

- 你在仓库里维护的是版本化配置（`zhch/litellm-config.yaml`）
- LiteLLM 启动时读取的是用户目录下配置（`~/.config/litellm/config.yaml`）

建议同步方式（任选其一）：

```bash
# 方式 A：复制
mkdir -p ~/.config/litellm
cp zhch/litellm-config.yaml ~/.config/litellm/config.yaml

# 方式 B：软链接（推荐，仓库修改后立即生效）
mkdir -p ~/.config/litellm
ln -sf /Users/zhch158/workspace/repository.git/nanoclaw/zhch/litellm-config.yaml ~/.config/litellm/config.yaml
```

## 2) plist 定义位置

- LiteLLM launchd 定义文件（仓库版）：`zhch/com.litellm.plist`
- NanoClaw launchd 定义文件（仓库版）：`zhch/com.nanoclaw.plist`

macOS 实际加载目录通常为：

- `~/Library/LaunchAgents/com.litellm.plist`
- `~/Library/LaunchAgents/com.nanoclaw.plist`

可用以下方式部署：

```bash
mkdir -p ~/Library/LaunchAgents
cp zhch/com.litellm.plist ~/Library/LaunchAgents/com.litellm.plist
cp zhch/com.nanoclaw.plist ~/Library/LaunchAgents/com.nanoclaw.plist
```

## 3) 如何使用

### 3.1 加载服务

```bash
launchctl unload ~/Library/LaunchAgents/com.litellm.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.litellm.plist

launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### 3.2 重启服务

```bash
# 这两条命令会立即重启 LiteLLM 和 NanoClaw 服务。`kickstart -k` 强制杀死并重新启动指定的 launchd 服务，`gui/$(id -u)` 指定当前用户的 GUI 会话。
launchctl kickstart -k gui/$(id -u)/com.litellm
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 3.3 查看状态

```bash
launchctl list | grep -E 'com\.litellm|com\.nanoclaw'
```

### 3.4 查看日志

LiteLLM 日志（来自 `com.litellm.plist`）：

- `/Users/zhch158/Library/Logs/litellm.log`
- `/Users/zhch158/Library/Logs/litellm.error.log`

NanoClaw 日志（来自 `com.nanoclaw.plist`）：

- `/Users/zhch158/workspace/repository.git/nanoclaw/logs/nanoclaw.log`
- `/Users/zhch158/workspace/repository.git/nanoclaw/logs/nanoclaw.error.log`

## 4) 模型别名如何使用

`zhch/litellm-config.yaml` 里定义了模型别名，例如：

- `claude-sonnet-4-6`
- `claude-sonnet-4-5`
- `claude-opus-4-5`
- `claude-haiku-4-5`
- `gpt-4o`
- `gpt-4o-mini`
- `gpt-4.1`

客户端请求 LiteLLM 时，使用 `model_name`（左侧别名）即可。

## 5) 注意事项

- 代理环境变量（`HTTP_PROXY`/`HTTPS_PROXY`）已在 `plist` 里配置。
- 不要在 `litellm-config.yaml` 的 `litellm_settings` 再配置代理（注释已说明会触发端口冲突误判）。
- 变更 `plist` 后需要 `unload` + `load`（或 `kickstart -k`）让配置生效。
