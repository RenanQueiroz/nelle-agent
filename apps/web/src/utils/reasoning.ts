/**
 * Kwargs a chat template reads to turn thinking on or off, mirroring
 * llama.cpp's own `chat-template-thinking-detector`. Qwen3 and Gemma 4 both
 * declare `enable_thinking`; a template that declares none of these cannot
 * think, so Nelle disables the reasoning control for it.
 */
const THINKING_KWARG_VARS = ['enable_thinking', 'reasoning_effort', 'thinking_budget'] as const;

/** Templates that carry no kwarg but still emit a thinking block. */
const THINKING_TAG_PAIRS = [
  ['<think>', '</think>'],
  ['<thinking>', '</thinking>'],
  ['<|channel>thought', '<channel|>'],
] as const;

/**
 * Whether a model can think is a property of its chat template, not its name.
 * llama.cpp reports the template on `/props`, which Nelle proxies as
 * `LlamaModelProps.chatTemplate`.
 */
export function templateSupportsThinking(chatTemplate: string | null | undefined): boolean {
  if (!chatTemplate) {
    return false;
  }
  if (THINKING_KWARG_VARS.some(variable => chatTemplate.includes(variable))) {
    return true;
  }
  return THINKING_TAG_PAIRS.some(
    ([open, close]) => chatTemplate.includes(open) && chatTemplate.includes(close),
  );
}
