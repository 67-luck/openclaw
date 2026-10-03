export const pastedApiKeyCases = [
  {
    name: "writes pasted API keys to the requested agent store",
    agent: "coder",
    input: "sk-openai-chatgpt-api-key-value",
    key: "sk-openai-chatgpt-api-key-value",
    piped: false,
  },
  {
    name: "normalizes line-wrapped piped OpenAI Codex API keys before storing",
    agent: undefined,
    input: "sk-openai-\nchat-api-key-value\n",
    key: "sk-openai-chat-api-key-value",
    piped: true,
  },
];
