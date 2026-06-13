export const KNOWN_TOOL_NAMES = new Set([
  'read_file',
  'edit',
  'multi_edit',
  'write_to_file',
  'run_command',
  'grep_search',
  'find_by_name',
  'list_dir',
  'code_search',
  'command_status',
  'browser_preview',
  'todo_list',
  'ask_user_question',
  'deploy_web_app',
  'read_deployment_config',
  'check_deploy_status',
  'create_memory',
  'search_web',
  'read_url_content',
  'view_content_chunk',
  'skill',
  'edit_notebook',
  'read_notebook',
  'trajectory_search',
  'read_resource',
  'list_resources',
  'read_terminal',
]);

                                                                                export function normalizeToolInvocation(toolName, params) {
  let normalizedToolName = toolName;
  const mapped = normalizeToolArguments(params);
  const toolAliases = {
    view_file: 'read_file',
    open_file: 'read_file',
    readFile: 'read_file',
    read: 'read_file',
    cat_file: 'read_file',
    ls: 'list_dir',
    dir: 'list_dir',
    list_directory: 'list_dir',
    list_files: 'list_dir',
    search_code: 'code_search',
    search_repo: 'code_search',
    search_in_codebase: 'code_search',
    grep: 'grep_search',
    rg: 'grep_search',
    search_text: 'grep_search',
    run_terminal_command: 'run_command',
    execute_command: 'run_command',
    run_command_line: 'run_command',
    shell_command: 'run_command',
    askUserQuestion: 'ask_user_question',
    ask_user: 'ask_user_question',
    ask_human: 'ask_user_question',
    ask_followup_question: 'ask_user_question',
    update_todo_list: 'todo_list',
    todo_list_create: 'todo_list',
    create_todo_list: 'todo_list',
    update_todos: 'todo_list',
    manage_todos: 'todo_list',
    write_file: 'write_to_file',
    create_file: 'write_to_file',
    save_file: 'write_to_file',
    writeFile: 'write_to_file',
    find_file: 'find_by_name',
    find_files: 'find_by_name',
    search_files: 'find_by_name',
    edit_file: 'edit',
    replace_in_file: 'edit',
    web_search: 'search_web',
    browser: 'browser_preview',
  };

  normalizedToolName = toolAliases[normalizedToolName] || normalizedToolName;

  if (normalizedToolName === 'read_file') {
    remapKey(mapped, 'target_file', 'file_path');
    remapKey(mapped, 'path', 'file_path');
    remapKey(mapped, 'TargetFile', 'file_path');
  }

  if (normalizedToolName === 'list_dir') {
    remapKey(mapped, 'directory', 'DirectoryPath');
    remapKey(mapped, 'path', 'DirectoryPath');
  }

  if (normalizedToolName === 'code_search') {
    remapKey(mapped, 'query', 'search_term');
    remapKey(mapped, 'prompt', 'search_term');
    remapKey(mapped, 'path', 'search_folder_absolute_uri');
    remapKey(mapped, 'directory', 'search_folder_absolute_uri');
    remapKey(mapped, 'SearchPath', 'search_folder_absolute_uri');
  }

  if (normalizedToolName === 'grep_search') {
    remapKey(mapped, 'path', 'SearchPath');
    remapKey(mapped, 'directory', 'SearchPath');
    remapKey(mapped, 'query', 'Query');
    remapKey(mapped, 'pattern', 'Query');
    remapArrayKey(mapped, 'include', 'Includes');
    remapArrayKey(mapped, 'includes', 'Includes');
  }

  if (normalizedToolName === 'run_command') {
    remapKey(mapped, 'command', 'CommandLine');
    remapKey(mapped, 'cmd', 'CommandLine');
    remapKey(mapped, 'cwd', 'Cwd');
    remapKey(mapped, 'working_directory', 'Cwd');
    remapKey(mapped, 'blocking', 'Blocking');
    remapKey(mapped, 'safe', 'SafeToAutoRun');
  }

  if (normalizedToolName === 'todo_list') {
    if (mapped.items !== undefined && mapped.todos === undefined) {
      const rawItems = Array.isArray(mapped.items)
        ? mapped.items
        : String(mapped.items).split(/[,，]/).map(s => s.trim()).filter(Boolean);
      mapped.todos = rawItems.map((content, index) => ({
        id: String(index + 1),
        content: typeof content === 'string' ? content : (content.content || content.text || String(content)),
        priority: 'medium',
        status: 'pending',
      }));
      delete mapped.items;
    }
    if (mapped.tasks !== undefined && mapped.todos === undefined) {
      mapped.todos = Array.isArray(mapped.tasks) ? mapped.tasks : [];
      delete mapped.tasks;
    }
    if (Array.isArray(mapped.todos)) {
      mapped.todos = mapped.todos.map((item, index) => {
        if (typeof item === 'string') {
          return { id: String(index + 1), content: item, priority: 'medium', status: 'pending' };
        }
        if (typeof item === 'object' && item !== null) {
          return {
            id: item.id || String(index + 1),
            content: item.content || item.text || item.title || String(item),
            priority: item.priority || 'medium',
            status: item.status || 'pending',
          };
        }
        return { id: String(index + 1), content: String(item), priority: 'medium', status: 'pending' };
      });
    }
    delete mapped.operation;
  }

  if (normalizedToolName === 'write_to_file') {
    remapKey(mapped, 'file_path', 'TargetFile');
    remapKey(mapped, 'path', 'TargetFile');
    remapKey(mapped, 'target_file', 'TargetFile');
    remapKey(mapped, 'content', 'CodeContent');
    remapKey(mapped, 'code', 'CodeContent');
    remapKey(mapped, 'text', 'CodeContent');
    if (mapped.EmptyFile === undefined) mapped.EmptyFile = false;
  }

  if (normalizedToolName === 'ask_user_question') {
    remapKey(mapped, 'question_text', 'question');
    remapKey(mapped, 'prompt', 'question');
    remapKey(mapped, 'message', 'question');
    remapKey(mapped, 'choices', 'options');
    remapKey(mapped, 'allow_multiple', 'allowMultiple');
    remapKey(mapped, 'multi', 'allowMultiple');
    remapKey(mapped, 'multiple', 'allowMultiple');
  }

  if (normalizedToolName === 'edit') {
    remapKey(mapped, 'path', 'file_path');
    remapKey(mapped, 'target_file', 'file_path');
    remapKey(mapped, 'search', 'old_string');
    remapKey(mapped, 'replace', 'new_string');
    remapKey(mapped, 'description', 'explanation');
  }

  if (normalizedToolName === 'multi_edit') {
    remapKey(mapped, 'path', 'file_path');
    remapKey(mapped, 'target_file', 'file_path');
    remapKey(mapped, 'description', 'explanation');
  }

  if (normalizedToolName === 'find_by_name') {
    remapKey(mapped, 'path', 'SearchDirectory');
    remapKey(mapped, 'directory', 'SearchDirectory');
    remapKey(mapped, 'pattern', 'Pattern');
    remapKey(mapped, 'type', 'Type');
  }

  if (normalizedToolName === 'browser_preview') {
    remapKey(mapped, 'title', 'Name');
    remapKey(mapped, 'name', 'Name');
    remapKey(mapped, 'url', 'Url');
  }

  if (normalizedToolName === 'search_web') {
    remapKey(mapped, 'q', 'query');
    remapKey(mapped, 'term', 'query');
    remapKey(mapped, 'site', 'domain');
  }

  const normalized = normalizeToolParams(normalizedToolName, mapped);
  return { toolName: normalizedToolName, params: normalized };
}

export function normalizeToolArguments(raw) {
  if (raw == null) return {};

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const looksJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (looksJson) {
      try {
        return normalizeToolArguments(JSON.parse(trimmed));
      } catch {
        return raw;
      }
    }
    return raw;
  }

  if (Array.isArray(raw)) {
    return raw.map(item => normalizeToolArguments(item));
  }

  if (typeof raw === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(raw)) {
      result[key] = normalizeToolArguments(value);
    }
    return result;
  }

  return raw;
}

export function normalizeToolParams(toolName, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return params;
  }

  const result = {};
  for (const [key, rawVal] of Object.entries(params)) {
    let val = rawVal;
    if (typeof val !== 'string') {
      result[key] = normalizeToolArguments(val);
      continue;
    }
    const trimmed = val.trim();
    if (trimmed === 'true') {
      result[key] = true;
      continue;
    }
    if (trimmed === 'false') {
      result[key] = false;
      continue;
    }
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        result[key] = normalizeToolArguments(JSON.parse(trimmed));
        continue;
      } catch {
      }
    }
    result[key] = val;
  }

  if (toolName === 'ask_user_question' && result.options !== undefined) {
    result.options = normalizeAskUserOptions(result.options);
    if (result.allowMultiple === undefined) result.allowMultiple = false;
  }

  return result;
}

export function normalizeAskUserOptions(options) {
  if (Array.isArray(options)) {
    return options
      .map((option) => {
        if (typeof option === 'string') {
          const text = option.trim();
          if (!text) return null;
          return { label: text, description: text };
        }
        if (option && typeof option === 'object') {
          const label = String(option.label || option.name || option.title || '').trim();
          const description = String(option.description || option.detail || label).trim();
          if (!label) return null;
          return { label, description: description || label };
        }
        return null;
      })
      .filter(Boolean);
  }

  if (typeof options === 'string') {
    return options
      .split(/[|,，\n]/)
      .map(part => part.trim())
      .filter(Boolean)
      .map(text => ({ label: text, description: text }));
  }

  return [];
}

function remapKey(target, from, to) {
  if (target[from] !== undefined && target[to] === undefined) {
    target[to] = target[from];
    delete target[from];
  }
}

function remapArrayKey(target, from, to) {
  if (target[from] !== undefined && target[to] === undefined) {
    target[to] = Array.isArray(target[from]) ? target[from] : [target[from]];
    delete target[from];
  }
}
