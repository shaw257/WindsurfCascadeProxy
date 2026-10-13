// handlers/parse-request.js — Full protobuf parser for GetChatMessageRequest
//
// GetChatMessageRequest {
//   Metadata metadata = 1;
//   string prompt = 2;                                   // top-level system prompt
//   repeated ChatMessagePrompt chat_message_prompts = 3; // conversation history
//   repeated ChatToolDefinition tools = 10;              // tool definitions
//   ChatToolChoice tool_choice = 12;                     // tool choice policy
//   string chat_model_uid = 21;                          // model ID
// }

import fs from 'node:fs';
import path from 'node:path';
import { parseFields, getField, getAllFields } from '../proto.js';
import { unwrapRequest } from '../connect.js';
import { KNOWN_TOOL_NAMES, normalizeToolInvocation } from './tool-normalization.js';

// ─── System prompt override ─────────────────────────────────
//
// Replace the static Cascade prompt (proto field 2) with a custom one.
// Dynamic IDE additions (SOURCE.SYSTEM_PROMPT messages: workspace rules,
// memories, context) are still appended after the override.
//
// Hot-reloads on file change — edit the file, next request picks it up.

const SYSTEM_PROMPT_OVERRIDE = process.env.SYSTEM_PROMPT_OVERRIDE === 'true';
const SYSTEM_PROMPT_PATH     = process.env.SYSTEM_PROMPT_PATH || '';
const DEBUG_UNKNOWN_FIELDS   = process.env.DEBUG_UNKNOWN_FIELDS === '1';
const DEBUG_EXPORT_SYSTEM_PROMPT = process.env.DEBUG_EXPORT_SYSTEM_PROMPT === '1';
const DEBUG_SYSTEM_PROMPT_DUMP_PATH = process.env.DEBUG_SYSTEM_PROMPT_DUMP_PATH || './debug/original-system-prompt.txt';

let _promptCache = { content: '', mtime: 0, path: '' };
let _promptDumpCache = { content: '', path: '' };

function getCustomSystemPrompt() {
  if (!SYSTEM_PROMPT_OVERRIDE || !SYSTEM_PROMPT_PATH) return '';
  try {
    const stat = fs.statSync(SYSTEM_PROMPT_PATH);
    if (_promptCache.path === SYSTEM_PROMPT_PATH && _promptCache.mtime === stat.mtimeMs) {
      return _promptCache.content;
    }
    const content = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8').trim();
    _promptCache = { content, mtime: stat.mtimeMs, path: SYSTEM_PROMPT_PATH };
    console.log(`  📝 Custom system prompt loaded (${content.length} chars)`);
    return content;
  } catch (err) {
    console.error(`  ❌ Failed to load custom system prompt: ${err.message}`);
    return '';
  }
}

function dumpOriginalSystemPrompt(prompt) {
  if (!DEBUG_EXPORT_SYSTEM_PROMPT || !prompt) return;

  const targetPath = path.isAbsolute(DEBUG_SYSTEM_PROMPT_DUMP_PATH)
    ? DEBUG_SYSTEM_PROMPT_DUMP_PATH
    : path.resolve(process.cwd(), DEBUG_SYSTEM_PROMPT_DUMP_PATH);

  if (_promptDumpCache.path === targetPath && _promptDumpCache.content === prompt) return;

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    // Sanitize: strip lines that look like keys/tokens/secrets
    const sanitized = prompt.split('\n')
      .map(line => /(?:key|token|secret|password|credential)\s*[:=]\s*\S/i.test(line) ? '[REDACTED]' : line)
      .join('\n');
    fs.writeFileSync(targetPath, `${sanitized.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
    _promptDumpCache = { content: prompt, path: targetPath };
    console.log(`  📝 Dumped original system prompt to ${targetPath} (${prompt.length} chars)`);
    console.warn(`  ⚠️  DEBUG_EXPORT_SYSTEM_PROMPT is ON — disable in production`);
  } catch (err) {
    console.error(`  ❌ Failed to dump original system prompt: ${err.message}`);
  }
}

// ─── Functional section extractor ──────────────────────────
//
// Keeps functional XML sections from the original Cascade prompt,
// drops marketing identity and non-functional fluff.

const KEEP_SECTIONS = [
  'tool_calling',
  'making_code_changes',
  'debugging',
  'running_commands',
  'calling_external_apis',
  'communication',
  'workflows',
];

// Also keep standalone lines that contain functional instructions
const KEEP_LINE_PATTERNS = [
  /^There will be an <ephemeral_message>/,
];

function extractFunctionalSections(original) {
  const parts = [];

  // Extract XML sections by tag name
  for (const tag of KEEP_SECTIONS) {
    const regex = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');
    let match;
    while ((match = regex.exec(original)) !== null) {
      parts.push(match[0]);
    }
    // Also match sections that contain nested tags (e.g. workspace_layout inside workspace_information)
    const openTag = `<${tag} `;
    const closeTag = `</${tag}>`;
    let idx = original.indexOf(openTag);
    while (idx !== -1) {
      const end = original.indexOf(closeTag, idx);
      if (end !== -1) {
        parts.push(original.slice(idx, end + closeTag.length));
      }
      idx = original.indexOf(openTag, idx + 1);
    }
  }

  // Extract standalone functional lines
  for (const line of original.split('\n')) {
    const trimmed = line.trim();
    if (KEEP_LINE_PATTERNS.some(p => p.test(trimmed))) {
      parts.push(trimmed);
    }
  }

  return parts.join('\n\n');
}

function compactPromptText(text) {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ChatMessageSource enum values
const SOURCE = {
  UNSPECIFIED:   0,
  USER:          1,
  SYSTEM:        2,  // maps to assistant role
  UNKNOWN:       3,  // assistant
  TOOL:          4,  // tool result
  SYSTEM_PROMPT: 5,  // folded into systemPrompt
};

// ─── Nested parsers ────────────────────────────────────────

/**
 * Parse an ImageData message buffer.
 *
 * ImageData {
 *   string base64_data = 1;
 *   string mime_type = 2;
 *   string caption = 3;
 * }
 */
function parseImageData(buf) {
  const fields = parseFields(buf);
  const base64Field = getField(fields, 1, 2);
  const mimeField   = getField(fields, 2, 2);
  const captionField = getField(fields, 3, 2);
  return {
    base64_data: base64Field ? base64Field.value.toString('utf8') : '',
    mime_type:   mimeField   ? mimeField.value.toString('utf8')   : 'image/png',
    caption:     captionField ? captionField.value.toString('utf8') : '',
  };
}

/**
 * Parse a ChatToolCall message buffer.
 *
 * ChatToolCall {
 *   string id = 1;
 *   string name = 2;
 *   string arguments_json = 3;
 * }
 */
function parseChatToolCall(buf) {
  const fields = parseFields(buf);
  const idField    = getField(fields, 1, 2);
  const nameField  = getField(fields, 2, 2);
  const argsField  = getField(fields, 3, 2);
  const rawName = nameField ? nameField.value.toString('utf8') : '';
  const rawArgs = argsField ? argsField.value.toString('utf8') : '{}';
  const invocation = normalizeToolInvocation(rawName, rawArgs);
  return {
    id:             idField   ? idField.value.toString('utf8')   : '',
    name:           invocation.toolName,
    arguments_json: JSON.stringify(invocation.params ?? {}),
  };
}

/**
 * Parse a ChatMessagePrompt message buffer.
 *
 * ChatMessagePrompt {
 *   string message_id = 1;
 *   ChatMessageSource source = 2;      // varint enum
 *   string prompt = 3;
 *   uint32 num_tokens = 4;
 *   repeated ChatToolCall tool_calls = 6;
 *   string tool_call_id = 7;
 *   bool tool_result_is_error = 9;
 *   repeated ImageData images = 10;
 *   string thinking = 11;
 *   string signature = 12;
 * }
 */
function parseChatMessagePrompt(buf) {
  const fields = parseFields(buf);

  const messageIdField        = getField(fields, 1, 2);
  const sourceField           = getField(fields, 2, 0);
  const promptField           = getField(fields, 3, 2);
  const toolCallIdField       = getField(fields, 7, 2);
  const toolResultIsErrorField = getField(fields, 9, 0);
  const thinkingField         = getField(fields, 11, 2);
  const signatureField        = getField(fields, 12, 2);

  const toolCallFields = getAllFields(fields, 6);
  const imageFields    = getAllFields(fields, 10);

  return {
    messageId:        messageIdField        ? messageIdField.value.toString('utf8')        : '',
    source:           sourceField           ? sourceField.value                            : 0,
    prompt:           promptField           ? promptField.value.toString('utf8')           : '',
    toolCalls:        toolCallFields.map(f => parseChatToolCall(f.value)),
    toolCallId:       toolCallIdField       ? toolCallIdField.value.toString('utf8')       : '',
    toolResultIsError: toolResultIsErrorField ? Boolean(toolResultIsErrorField.value)      : false,
    images:           imageFields.map(f => parseImageData(f.value)),
    thinking:         thinkingField         ? thinkingField.value.toString('utf8')         : '',
    signature:        signatureField        ? signatureField.value.toString('utf8')        : '',
  };
}

/**
 * Parse a ChatToolDefinition message buffer.
 *
 * ChatToolDefinition {
 *   string name = 1;
 *   string description = 2;
 *   string json_schema_string = 3;
 *   bool strict = 4;
 * }
 *
 * Returns Anthropic native tool format.
 */
function parseChatToolDefinition(buf) {
  const fields = parseFields(buf);
  const nameField   = getField(fields, 1, 2);
  const descField   = getField(fields, 2, 2);
  const schemaField = getField(fields, 3, 2);

  const rawName = nameField ? nameField.value.toString('utf8') : '';
  const description = descField ? descField.value.toString('utf8') : '';
  const schemaStr = schemaField ? schemaField.value.toString('utf8') : '{}';

  let input_schema;
  try {
    input_schema = JSON.parse(schemaStr);
  } catch {
    input_schema = { type: 'object', properties: {} };
  }

  if (!input_schema.type) {
    input_schema.type = 'object';
  }
  if (input_schema.type === 'object' && !input_schema.properties) {
    input_schema.properties = {};
  }

  const toolAliases = KNOWN_TOOL_NAMES.has(rawName) ? rawName : (normalizeToolInvocation(rawName, {}).toolName || rawName);
  return { name: toolAliases, description, input_schema };
}

/**
 * Parse a ChatToolChoice message buffer.
 *
 * ChatToolChoice {
 *   string option_name = 1;   // "auto" | "any" | "none"
 *   string tool_name = 2;     // specific tool name (oneof alternative)
 * }
 *
 * Returns Anthropic tool_choice object or undefined.
 */
function parseChatToolChoice(buf) {
  const fields = parseFields(buf);

  const optionNameField = getField(fields, 1, 2);
  const toolNameField   = getField(fields, 2, 2);

  const rawToolName = toolNameField ? toolNameField.value.toString('utf8').trim() : '';
  const optionName = optionNameField ? optionNameField.value.toString('utf8').trim() : '';

  if (rawToolName) {
    const invocation = normalizeToolInvocation(rawToolName, {});
    return { type: 'tool', name: invocation.toolName };
  }
  if (optionName) {
    return { type: optionName };
  }
  return undefined;
}

function toAnthropicMessage(parsed) {
  const { source, prompt, toolCalls, toolCallId, toolResultIsError, images, thinking, signature } = parsed;

  if (source === SOURCE.SYSTEM_PROMPT || source === SOURCE.UNSPECIFIED) {
    return null;
  }

  if (source === SOURCE.TOOL) {
    const block = {
      type: 'tool_result',
      tool_use_id: toolCallId,
      content: prompt,
    };
    if (toolResultIsError) block.is_error = true;
    return { role: 'user', content: [block] };
  }

  if (source === SOURCE.USER) {
    if (images && images.length > 0) {
      const contentBlocks = [];
      for (const img of images) {
        if (img.base64_data) {
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mime_type || 'image/png',
              data: img.base64_data,
            },
          });
        }
      }
      if (prompt) {
        contentBlocks.push({ type: 'text', text: prompt });
      }
      return { role: 'user', content: contentBlocks };
    }
    return { role: 'user', content: prompt };
  }

  if (source === SOURCE.UNKNOWN || source === SOURCE.SYSTEM) {
    const contentBlocks = [];

    if (thinking) {
      const thinkingBlock = { type: 'thinking', thinking };
      if (signature) thinkingBlock.signature = signature;
      contentBlocks.push(thinkingBlock);
    }

    if (prompt) {
      contentBlocks.push({ type: 'text', text: prompt });
    }

    for (const tc of toolCalls) {
      let input;
      try {
        input = JSON.parse(tc.arguments_json);
      } catch {
        input = {};
      }
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input,
      });
    }

    if (contentBlocks.length > 1 || (contentBlocks.length === 1 && contentBlocks[0].type !== 'text')) {
      return { role: 'assistant', content: contentBlocks };
    }
    return { role: 'assistant', content: prompt };
  }

  return null;
}

function normalizeContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function mergeConsecutiveMessages(messages) {
  if (messages.length <= 1) return messages;

  const merged = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = messages[i];

    if (prev.role === curr.role) {
      const prevBlocks = normalizeContent(prev.content);
      const currBlocks = normalizeContent(curr.content);
      prev.content = [...prevBlocks, ...currBlocks];
    } else {
      merged.push(curr);
    }
  }

  for (const m of merged) {
    if (Array.isArray(m.content) && m.content.length === 1 && m.content[0].type === 'text') {
      m.content = m.content[0].text;
    }
  }

  return merged;
}

export { extractFunctionalSections, compactPromptText };

export function parseGetChatMessageRequest(body, headers) {
  const protoBuf = unwrapRequest(body, headers);
  const fields   = parseFields(protoBuf);

  const knownFields = new Set([1, 2, 3, 10, 12, 21]);
  const unknownFields = fields.filter(f => !knownFields.has(f.field));
  if (unknownFields.length > 0) {
    const summary = unknownFields.map(f => `${f.field}/${f.wireType}`).join(', ');
    if (DEBUG_UNKNOWN_FIELDS) {
      console.log(`  🔍 GetChatMessage unknown fields: ${summary}`);
      for (const f of unknownFields) {
        if (f.wireType === 0) console.log(`    field ${f.field} (varint): ${f.value}`);
        else if (f.wireType === 2) {
          const str = f.value.toString('utf8');
          const isPrintable = /^[\x20-\x7e\n\r\t]+$/.test(str.slice(0, 50));
          console.log(`    field ${f.field} (bytes/${f.value.length}b): ${isPrintable ? str.slice(0, 120) : '[binary ' + f.value.toString('hex').slice(0, 40) + ']'}`);
        }
        else console.log(`    field ${f.field} (wire ${f.wireType}): ${f.value?.toString?.('hex')?.slice(0, 40)}`);
      }
    }
  }

  const systemField = getField(fields, 2, 2);
  let systemPrompt  = systemField ? systemField.value.toString('utf8') : '';

  dumpOriginalSystemPrompt(systemPrompt);

  if (SYSTEM_PROMPT_OVERRIDE) {
    const custom = getCustomSystemPrompt();
    if (custom) {
      const originalLen = systemPrompt.length;
      const preserved = compactPromptText(extractFunctionalSections(systemPrompt));
      systemPrompt = compactPromptText(preserved ? `${custom}\n\n${preserved}` : custom);
      console.log(`  🔀 System prompt: custom ${custom.length} + preserved ${preserved.length} chars (was ${originalLen})`);
    }
  }

  const modelField = getField(fields, 21, 2);
  const requestedModel = modelField ? modelField.value.toString('utf8') : '';

  const promptFields = getAllFields(fields, 3, 2);
  const parsedPrompts = promptFields.map(f => parseChatMessagePrompt(f.value));
  for (const parsed of parsedPrompts) {
    if (parsed.source === SOURCE.SYSTEM_PROMPT && parsed.prompt) {
      systemPrompt += (systemPrompt ? '\n\n' : '') + parsed.prompt;
    }
  }
  systemPrompt = compactPromptText(systemPrompt);

  let initiator = 'agent';
  const nonSystemPrompts = parsedPrompts.filter(parsed =>
    parsed.source !== SOURCE.SYSTEM_PROMPT && parsed.source !== SOURCE.UNSPECIFIED
  );
  if (nonSystemPrompts.length > 0) {
    const lastParsed = nonSystemPrompts[nonSystemPrompts.length - 1];
    if (lastParsed.source === SOURCE.USER) {
      const secondToLast = nonSystemPrompts.length >= 2
        ? nonSystemPrompts[nonSystemPrompts.length - 2]
        : null;
      if (!secondToLast || secondToLast.source !== SOURCE.TOOL) {
        initiator = 'user';
      } else {
        console.log(`  🔍 Agent-round trailing USER text (${lastParsed.prompt.length} chars): "${lastParsed.prompt.slice(0, 150)}..."`);
      }
    }
  }

  const messages = mergeConsecutiveMessages(
    parsedPrompts
      .map(toAnthropicMessage)
      .filter(Boolean)
  );

  const toolsField = getAllFields(fields, 10, 2);
  let tools = toolsField.map(f => parseChatToolDefinition(f.value)).filter(t => t.name);
  if (tools.length > 0) {
    const deduped = new Map();
    for (const tool of tools) {
      if (!tool.name) continue;
      if (!KNOWN_TOOL_NAMES.has(tool.name) && !tool.name.startsWith('mcp0_')) {
        console.log(`  ⚠️  Dropping unknown tool definition: ${tool.name}`);
        continue;
      }
      if (!deduped.has(tool.name)) deduped.set(tool.name, tool);
    }
    tools = [...deduped.values()];
  }
  if (tools.length === 0) tools = undefined;

  const toolChoiceField = getField(fields, 12, 2);
  const toolChoice = toolChoiceField ? parseChatToolChoice(toolChoiceField.value) : undefined;

  return {
    systemPrompt,
    messages,
    tools,
    toolChoice,
    requestedModel,
    initiator,
  };
}
