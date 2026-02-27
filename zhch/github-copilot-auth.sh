# Raw response from Copilot models endpoint
TOKEN=$(cat ~/.config/litellm/github_copilot/access-token 2>/dev/null)

COPILOT_TOKEN=$(curl -s -x http://127.0.0.1:7890 \
  -H "Authorization: token $TOKEN" \
  -H "Editor-Version: vscode/1.95.0" \
  -H "Copilot-Integration-Id: vscode-chat" \
  "https://api.github.com/copilot_internal/v2/token" | jq -r '.token')

# 查询可用模型列表
curl -s -x http://127.0.0.1:7890 \
  -H "Authorization: Bearer $COPILOT_TOKEN" \
  -H "Editor-Version: vscode/1.95.0" \
  -H "Copilot-Integration-Id: vscode-chat" \
  "https://api.individual.githubcopilot.com/models" | jq '[.data[] | {id, capabilities: .capabilities.type}]'

for model in "claude-sonnet-4-6" "claude-sonnet-4-5" "claude-opus-4-5" "claude-3-5-sonnet" "claude-3-5-sonnet-20241022"; do
  result=$(curl -s -x http://127.0.0.1:7890 \
    -H "Authorization: Bearer $COPILOT_TOKEN" \
    -H "Editor-Version: vscode/1.95.0" \
    -H "Copilot-Integration-Id: vscode-chat" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    "https://api.individual.githubcopilot.com/v1/messages" 2>/dev/null)
  if echo "$result" | grep -q '"type":"message"'; then
    echo "✓ $model — OK"
  else
    echo "✗ $model — $(echo $result | jq -r '.error.message // .error // .' 2>/dev/null | head -c 80)"
  fi
done
