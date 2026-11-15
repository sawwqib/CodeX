(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const app = $("#app");
  const filesByPath = new Map();
  const openFiles = new Map();
  let activePath = null;
  let previewUrl = null;
  let toastTimer = null;
  let searchTimer = null;
  let terminalHistory = [];
  let historyIndex = 0;
  let pendingAgent = null;
  let cmEditor = null;
  const TYPE = {
    ".py": ["file-type-python", "PY"], ".html": ["file-type-html", "HT"], ".htm": ["file-type-html", "HT"],
    ".css": ["file-type-css", "CS"], ".scss": ["file-type-sass", "SC"], ".js": ["file-type-js", "JS"],
    ".jsx": ["file-type-reactjs", "JS"], ".ts": ["file-type-typescript", "TS"], ".tsx": ["file-type-reactts", "TS"],
    ".json": ["file-type-json", "{}"], ".md": ["file-type-markdown", "MD"], ".txt": ["file-type-text", "TXT"],
    ".svg": ["file-type-svg", "SVG"], ".yaml": ["file-type-yaml", "Y"], ".yml": ["file-type-yaml", "Y"],
    ".xml": ["file-type-xml", "XML"], ".sql": ["file-type-sql", "DB"], ".rs": ["file-type-rust", "RS"],
    ".go": ["file-type-go", "GO"], ".java": ["file-type-java", "JV"], ".c": ["file-type-c", "C"],
    ".h": ["file-type-c", "H"], ".cpp": ["file-type-cpp", "C++"], ".cs": ["file-type-csharp", "C#"],
    ".php": ["file-type-php", "PHP"], ".toml": ["file-type-toml", "TOML"], ".ini": ["file-type-config", "INI"],
    ".csv": ["file-type-excel", "CSV"], ".ps1": ["file-type-powershell", "PS"], ".bat": ["file-type-batch", "BAT"],
    ".sh": ["file-type-shell", "SH"], ".png": ["file-type-image", "IMG"], ".jpg": ["file-type-image", "IMG"],
    ".jpeg": ["file-type-image", "IMG"], ".gif": ["file-type-image", "IMG"], ".webp": ["file-type-image", "IMG"],
  };

  function iconFor(path, isDir = false) {
    if (isDir) {
      const folder = path.split("/").at(-1).toLowerCase();
      const named = { src: "folder-type-src", test: "folder-type-test", tests: "folder-type-test", docs: "folder-type-docs", public: "folder-type-public", images: "folder-type-images", config: "folder-type-config", ".github": "folder-type-github" };
      return { id: named[folder] || "mdi:folder-outline", fallback: "▸" };
    }
    const extension = (path.match(/\.[^.\\/]+$/) || [""])[0].toLowerCase();
    const type = TYPE[extension];
    return type ? { id: type[0], fallback: type[1] } : { id: "mdi:file-outline", fallback: "·" };
  }

  function iconUrl(id) {
    const [collection, name] = id.includes(":") ? id.split(":", 2) : ["vscode-icons", id];
    return `https://api.iconify.design/${encodeURIComponent(collection)}/${encodeURIComponent(name)}.svg`;
  }

  function makeFileIcon(path, isDir = false) {
    const descriptor = iconFor(path, isDir);
    const wrapper = document.createElement("span");
    wrapper.className = "file-icon-wrap";
    const image = document.createElement("img");
    image.className = "file-theme-icon";
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.src = iconUrl(descriptor.id);
    const fallback = document.createElement("span");
    fallback.className = "file-glyph hidden";
    fallback.textContent = descriptor.fallback;
    image.addEventListener("error", () => {
      image.classList.add("hidden");
      fallback.classList.remove("hidden");
    }, { once: true });
    wrapper.append(image, fallback);
    return wrapper;
  }

  function escapeHtml(text) {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function highlightSource() {
    const source = $("#source");
    const text = source.value;
    const extension = (activePath?.match(/\.[^.]+$/) || [""])[0].toLowerCase();
    let html;
    if ([".html", ".htm", ".xml", ".svg"].includes(extension)) {
      let output = "";
      let cursor = 0;
      const tags = /<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?:\s[^<>]*?)?\/?>/gi;
      for (const match of text.matchAll(tags)) {
        output += escapeHtml(text.slice(cursor, match.index));
        const tag = match[0];
        if (tag.startsWith("<!--")) {
          output += `<span class="syntax-comment">${escapeHtml(tag)}</span>`;
        } else {
          const parsed = tag.match(/^<(\/?)\s*([\w:-]+)([\s\S]*?)(\/?)>$/);
          if (!parsed) output += escapeHtml(tag);
          else {
            const [, slash, name, attributes, close] = parsed;
            output += `&lt;${slash}<span class="syntax-tag">${escapeHtml(name)}</span>`;
            const attrPattern = /(\s+)([\w:.-]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
            let attrCursor = 0;
            for (const attr of attributes.matchAll(attrPattern)) {
              output += escapeHtml(attributes.slice(attrCursor, attr.index));
              output += escapeHtml(attr[1]) + `<span class="syntax-attribute">${escapeHtml(attr[2])}</span>`;
              if (attr[3]) output += `<span class="syntax-string">${escapeHtml(attr[3])}</span>`;
              attrCursor = attr.index + attr[0].length;
            }
            output += escapeHtml(attributes.slice(attrCursor)) + `${close}&gt;`;
          }
        }
        cursor = match.index + tag.length;
      }
      output += escapeHtml(text.slice(cursor));
      html = output;
    } else {
      const isPython = extension === ".py";
      const comment = isPython ? "#[^\\n]*" : "(?:\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)";
      const strings = "(?:\\\"\\\"\\\"[\\s\\S]*?\\\"\\\"\\\"|'''[\\s\\S]*?'''|\\\"(?:\\\\.|[^\\\"\\\\])*\\\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)";
      const keywords = isPython
        ? "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield"
        : "async|await|break|case|catch|class|const|continue|default|do|else|export|extends|false|finally|for|from|function|if|import|in|interface|let|new|null|of|return|static|switch|this|throw|true|try|type|var|void|while|with|yield|public|private|def|return|pass|None|True|False";
      const pattern = new RegExp(`(${comment})|(${strings})|(\\b(?:${keywords})\\b)|(\\b\\d+(?:\\.\\d+)?\\b)`, "g");
      let cursor = 0;
      let output = "";
      for (const match of text.matchAll(pattern)) {
        output += escapeHtml(text.slice(cursor, match.index));
        const cls = match[1] ? "syntax-comment" : match[2] ? "syntax-string" : match[3] ? "syntax-keyword" : "syntax-number";
        output += `<span class="${cls}">${escapeHtml(match[0])}</span>`;
        cursor = match.index + match[0].length;
      }
      html = output + escapeHtml(text.slice(cursor));
      html = html.replace(/\b([A-Za-z_$][\w$]*)(?=\s*\()/g, '<span class="syntax-function">$1</span>');
    }
    $("#highlight").innerHTML = html + (text.endsWith("\n") ? " " : "");
  }

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("visible"), 2800);
  }

  function setStatus(message) {
    $("#status-message").textContent = message;
  }

  function getEditorValue() {
    return cmEditor ? cmEditor.getValue() : $("#source").value;
  }

  function modeForPath(path) {
    const extension = (path.match(/\.[^.]+$/) || [""])[0].toLowerCase();
    return ({
      ".py": "python", ".html": "htmlmixed", ".htm": "htmlmixed", ".xml": "xml", ".svg": "xml",
      ".css": "css", ".js": "javascript", ".jsx": "javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
      ".json": "application/json", ".yaml": "yaml", ".yml": "yaml", ".sql": "text/x-sql", ".md": "markdown",
      ".sh": "shell", ".bash": "shell", ".ps1": "shell", ".java": "text/x-java", ".c": "text/x-csrc",
      ".h": "text/x-csrc", ".cpp": "text/x-c++src", ".cs": "text/x-csharp", ".php": "application/x-httpd-php",
      ".go": "text/x-go", ".rs": "text/x-rust", ".toml": "toml",
    })[extension] || "text/plain";
  }

  function initializeCodeMirror() {
    if (!window.CodeMirror) return;
    cmEditor = window.CodeMirror($(".code-surface"), {
      value: "", mode: "text/plain", theme: "material-darker", lineNumbers: true,
      lineWrapping: false, indentUnit: 4, tabSize: 4, viewportMargin: 20,
      extraKeys: { Tab: (editor) => editor.replaceSelection("    ", "end"), "Ctrl-S": saveActive, "Cmd-S": saveActive },
    });
    $("#source").classList.add("hidden");
    $("#line-numbers").classList.add("hidden");
    document.body.classList.add("codemirror-ready");
    cmEditor.on("change", updateDirtyState);
    cmEditor.on("cursorActivity", refreshLineNumbers);
    cmEditor.on("scroll", refreshLineNumbers);
  }

  function refreshLineNumbers() {
    let cursor, scrollTop, scrollLeft;
    if (cmEditor) {
      cursor = cmEditor.getCursor();
      const scroll = cmEditor.getScrollInfo();
      scrollTop = scroll.top;
      scrollLeft = scroll.left;
    } else {
      const source = $("#source");
      const before = source.value.slice(0, source.selectionStart);
      cursor = { line: before.split("\n").length - 1, ch: before.length - before.lastIndexOf("\n") - 1 };
      scrollTop = source.scrollTop;
      scrollLeft = source.scrollLeft;
      $("#line-numbers").textContent = Array.from({ length: source.value.split("\n").length }, (_, i) => i + 1).join("\n");
      $("#line-numbers").scrollTop = scrollTop;
    }
    $("#status-line").textContent = `Ln ${cursor.line + 1}, Col ${cursor.ch + 1}`;
    const item = openFiles.get(activePath);
    if (item) {
      item.cursor = cursor;
      item.scrollTop = scrollTop;
      item.scrollLeft = scrollLeft;
    }
  }

  function updateDirtyState() {
    const item = openFiles.get(activePath);
    if (!item) return;
    item.content = getEditorValue();
    item.dirty = item.content !== item.savedContent;
    renderTabs();
    $("#save-button").classList.toggle("modified", item.dirty);
    refreshLineNumbers();
  }

  function renderTabs() {
    const tabs = $("#tabs");
    tabs.replaceChildren();
    for (const [path, item] of openFiles) {
      const button = document.createElement("button");
      button.className = `file-tab${path === activePath ? " active" : ""}`;
      button.title = path;
      const type = makeFileIcon(path);
      type.classList.add("tab-icon");
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = path.split("/").at(-1);
      const dirty = document.createElement("span");
      dirty.className = item.dirty ? "dirty-dot" : "tab-close";
      dirty.textContent = item.dirty ? "" : "×";
      dirty.title = item.dirty ? "Unsaved changes" : "Close file";
      dirty.addEventListener("click", (event) => {
        event.stopPropagation();
        closeFile(path);
      });
      button.append(type, label, dirty);
      button.addEventListener("click", () => selectFile(path));
      tabs.append(button);
    }
  }

  function setEditorVisible(visible) {
    $("#welcome").classList.toggle("hidden", visible);
    $("#editor").classList.toggle("hidden", !visible);
    $("#preview").classList.add("hidden");
  }

  function selectFile(path) {
    const item = openFiles.get(path);
    if (!item) return;
    activePath = path;
    setEditorVisible(true);
    if (cmEditor) {
      cmEditor.setOption("mode", modeForPath(path));
      cmEditor.setValue(item.content);
      cmEditor.setCursor(item.cursor || { line: 0, ch: 0 });
      cmEditor.scrollTo(item.scrollLeft || 0, item.scrollTop || 0);
      cmEditor.refresh();
    } else {
      const source = $("#source");
      source.value = item.content;
      const cursor = typeof item.cursor === "number" ? item.cursor : 0;
      source.setSelectionRange(cursor, cursor);
      source.scrollTop = item.scrollTop || 0;
      source.scrollLeft = item.scrollLeft || 0;
    }
    $("#breadcrumbs").textContent = path.split("/").join("  ›  ");
    const [label] = iconFor(path);
    const extension = (path.match(/\.[^.]+$/) || [""])[0].slice(1).toUpperCase();
    $("#status-language").textContent = extension || "Plain Text";
    $("#save-button").classList.toggle("modified", item.dirty);
    renderTabs();
    refreshLineNumbers();
    renderTree();
    setStatus(item.dirty ? "Unsaved changes" : "Ready");
    if (cmEditor) cmEditor.focus();
    else $("#source").focus();
  }

  async function openFile(path) {
    if (openFiles.has(path)) {
      selectFile(path);
      return;
    }
    const result = await window.pywebview.api.get_file(path);
    if (!result.ok) return toast(result.error);
    openFiles.set(result.path, { content: result.content, savedContent: result.content, dirty: false });
    selectFile(result.path);
  }

  async function saveActive() {
    if (!activePath) return toast("Open a file before saving.");
    const item = openFiles.get(activePath);
    if (!item) return;
    item.content = getEditorValue();
    const result = await window.pywebview.api.save_file(activePath, item.content);
    if (!result.ok) return toast(result.error);
    item.savedContent = item.content;
    item.dirty = false;
    renderTabs();
    $("#save-button").classList.remove("modified");
    setStatus("Saved");
    toast("Saved");
    await refreshTree();
  }

  async function closeFile(path) {
    const item = openFiles.get(path);
    if (item?.dirty && !confirm(`Save changes to ${path.split("/").at(-1)} before closing?`)) {
      if (confirm("Discard those unsaved changes?")) openFiles.delete(path);
      else return;
    } else {
      if (item?.dirty) {
        const current = activePath;
        if (current === path && cmEditor) cmEditor.setValue(item.content);
        const result = await window.pywebview.api.save_file(path, item.content);
        if (!result.ok) return toast(result.error);
      }
      openFiles.delete(path);
    }
    if (activePath === path) {
      activePath = [...openFiles.keys()].at(-1) || null;
      if (activePath) selectFile(activePath);
      else {
        setEditorVisible(false);
        $("#breadcrumbs").textContent = "";
        renderTabs();
      }
    } else renderTabs();
  }

  function renderTree() {
    const container = $("#file-tree");
    container.replaceChildren();
    const entries = [...filesByPath.values()].sort((a, b) => {
      const depth = a.path.split("/").length - b.path.split("/").length;
      if (depth) return depth;
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
    });
    const collapsed = new Set([...container.querySelectorAll(".tree-row.folder.collapsed")].map((e) => e.dataset.path));
    if (!entries.length) {
      container.innerHTML = '<div class="tree-empty">This folder is empty.<br>Create a file or open a project folder.</div>';
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("button");
      const depth = entry.path.split("/").length - 1;
      row.className = `tree-row${entry.is_dir ? " folder collapsed" : ""}${entry.path === activePath ? " active" : ""}`;
      row.style.setProperty("--depth", depth);
      row.dataset.path = entry.path;
      row.dataset.dir = String(entry.is_dir);
      row.title = entry.path;
      const caret = document.createElement("span");
      caret.className = "caret";
      caret.textContent = entry.is_dir ? "›" : "";
      const type = makeFileIcon(entry.path, entry.is_dir);
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = entry.name;
      row.append(caret, type, name);
      if (!entry.is_dir) {
        row.addEventListener("click", () => openFile(entry.path));
        row.addEventListener("contextmenu", (event) => showFileMenu(event, entry));
      } else {
        row.addEventListener("click", () => {
          row.classList.toggle("collapsed");
          row.querySelector(".caret").textContent = row.classList.contains("collapsed") ? "›" : "⌄";
          renderTreeWithCollapse();
        });
      }
      container.append(row);
    }
    renderTreeWithCollapse();
  }

  function renderTreeWithCollapse() {
    const rows = [...$("#file-tree").querySelectorAll(".tree-row")];
    const collapsedPaths = new Set(rows.filter((row) => row.classList.contains("folder") && row.classList.contains("collapsed")).map((row) => row.dataset.path));
    for (const row of rows) {
      const parts = row.dataset.path.split("/");
      const parents = parts.slice(0, row.dataset.dir === "true" ? -1 : -1);
      row.hidden = parents.some((_part, i) => collapsedPaths.has(parts.slice(0, i + 1).join("/")));
      if (row.dataset.dir === "true") row.querySelector(".caret").textContent = row.classList.contains("collapsed") ? "›" : "⌄";
    }
  }

  function showFileMenu(event, entry) {
    event.preventDefault();
    const action = prompt(`File: ${entry.name}\nType rename or delete`, "rename");
    if (!action) return;
    if (action.toLowerCase() === "rename") {
      const name = prompt("New file name", entry.name);
      if (name) renameFile(entry.path, name);
    } else if (action.toLowerCase() === "delete") {
      deleteFile(entry.path);
    }
  }

  async function renameFile(path, name) {
    const result = await window.pywebview.api.rename_file(path, name);
    if (!result.ok) return toast(result.error);
    if (openFiles.has(path)) {
      const item = openFiles.get(path);
      openFiles.delete(path);
      openFiles.set(result.path, item);
      if (activePath === path) activePath = result.path;
    }
    await refreshTree();
    renderTabs();
    if (activePath) selectFile(activePath);
  }

  async function deleteFile(path) {
    if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
    const result = await window.pywebview.api.delete_file(path);
    if (!result.ok) return toast(result.error);
    openFiles.delete(path);
    if (activePath === path) {
      activePath = [...openFiles.keys()].at(-1) || null;
      if (activePath) selectFile(activePath);
      else setEditorVisible(false);
    }
    await refreshTree();
    renderTabs();
  }

  async function refreshTree() {
    const data = await window.pywebview.api.list_files();
    filesByPath.clear();
    for (const entry of data.files || []) filesByPath.set(entry.path, entry);
    renderTree();
  }

  async function createFile() {
    const path = prompt("New file path, relative to this project");
    if (!path) return;
    const result = await window.pywebview.api.create_file(path);
    if (!result.ok) return toast(result.error);
    await refreshTree();
    openFiles.set(result.path, { content: "", savedContent: "", dirty: false });
    selectFile(result.path);
  }

  async function openFileDialog() {
    const result = await window.pywebview.api.open_file_dialog();
    if (result.ok) {
      openFiles.set(result.path, { content: result.content, savedContent: result.content, dirty: false });
      await refreshTree();
      selectFile(result.path);
    } else if (!result.cancelled) toast(result.error);
  }

  async function chooseProject() {
    if ([...openFiles.values()].some((item) => item.dirty) && !confirm("Switch projects and discard unsaved changes?")) return;
    const result = await window.pywebview.api.choose_project();
    if (!result.ok) {
      if (!result.cancelled) toast(result.error);
      return;
    }
    openFiles.clear();
    filesByPath.clear();
    for (const entry of result.files || []) filesByPath.set(entry.path, entry);
    activePath = null;
    setEditorVisible(false);
    renderTabs();
    renderTree();
    toast("Project opened");
  }

  async function findInProject() {
    const query = $("#search-input").value.trim();
    if (!query) return;
    const results = await window.pywebview.api.search(query);
    const container = $("#search-results");
    container.replaceChildren();
    const count = document.createElement("div");
    count.className = "search-count";
    count.textContent = `${results.length} result${results.length === 1 ? "" : "s"}`;
    container.append(count);
    for (const match of results) {
      const button = document.createElement("button");
      button.className = "search-result";
      const file = document.createElement("strong");
      file.textContent = `${match.path}:${match.line}`;
      const text = document.createElement("span");
      text.textContent = match.text;
      button.append(file, text);
      button.addEventListener("click", async () => {
        await openFile(match.path);
        if (cmEditor) {
          cmEditor.setCursor({ line: match.line - 1, ch: 0 });
          cmEditor.scrollIntoView({ line: match.line - 1, ch: 0 }, 80);
          cmEditor.focus();
        } else {
          const editor = $("#source");
          const start = editor.value.split("\n").slice(0, match.line - 1).join("\n").length + (match.line > 1 ? 1 : 0);
          editor.focus();
          editor.setSelectionRange(start, start);
          editor.scrollTop = Math.max(0, (match.line - 2) * 22);
        }
        refreshLineNumbers();
      });
      container.append(button);
    }
    if (!results.length) {
      const none = document.createElement("div");
      none.className = "tree-empty";
      none.textContent = "No matches found.";
      container.append(none);
    }
  }

  async function previewActive() {
    if (!activePath) return toast("Open an HTML file to preview it.");
    const item = openFiles.get(activePath);
    if (item?.dirty) {
      const result = await window.pywebview.api.save_file(activePath, getEditorValue());
      if (!result.ok) return toast(result.error);
      item.content = getEditorValue();
      item.savedContent = item.content;
      item.dirty = false;
      renderTabs();
    }
    const result = await window.pywebview.api.preview_file(activePath);
    if (!result.ok) return toast(result.error);
    previewUrl = result.url;
    $("#preview-url").textContent = result.url;
    $("#preview-frame").src = result.url;
    $("#editor").classList.add("hidden");
    $("#welcome").classList.add("hidden");
    $("#preview").classList.remove("hidden");
    toast("Live preview is running");
  }

  function addMessage(role, text, id = null) {
    $("#chat-empty").classList.add("hidden");
    const node = document.createElement("div");
    node.className = `chat-message ${role}`;
    if (id) node.id = id;
    if (role === "assistant") {
      const label = document.createElement("span");
      label.className = "message-label";
      label.textContent = "CODEX";
      const content = document.createElement("span");
      content.textContent = text;
      node.append(label, content);
    } else node.textContent = text;
    $("#chat-messages").append(node);
    $("#chat-scroll").scrollTop = $("#chat-scroll").scrollHeight;
    return node;
  }

  async function sendPrompt() {
    const input = $("#prompt-input");
    const prompt = input.value.trim();
    if (!prompt) return;
    input.value = "";
    addMessage("user", prompt);
    const pendingId = `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    addMessage("assistant", "Thinking…", pendingId);
    $("#send-button").disabled = true;
    const response = await window.pywebview.api.ask_ai(prompt, $("#ai-mode").value, $("#include-context").checked, pendingId);
    if (!response.ok) {
      $("#send-button").disabled = false;
      const pending = document.getElementById(pendingId);
      if (pending) pending.remove();
      return toast(response.error);
    }
  }

  function showAgentReview(agent) {
    const actions = Array.isArray(agent?.actions) ? agent.actions : [];
    const files = actions.filter((action) => action && action.type === "write_file" && typeof action.content === "string" && typeof action.path === "string");
    const commands = actions.filter((action) => action && action.type === "run_command" && typeof action.command === "string");
    if (!files.length && !commands.length) return;
    pendingAgent = { files, commands };
    $("#agent-message").textContent = String(agent.message || "CodeX proposed the following changes.");
    const container = $("#agent-changes");
    container.replaceChildren();
    if (files.length) {
      for (const file of files) {
        const row = document.createElement("div");
        row.className = "agent-change";
        const name = document.createElement("strong");
        name.textContent = file.path;
        const preview = document.createElement("pre");
        preview.textContent = file.content.slice(0, 2500) + (file.content.length > 2500 ? "\n…" : "");
        row.append(name, preview);
        container.append(row);
      }
    }
    if (commands.length) {
      const row = document.createElement("div");
      row.className = "agent-change";
      const label = document.createElement("strong");
      label.textContent = `${commands.length} proposed terminal command${commands.length === 1 ? "" : "s"}`;
      const preview = document.createElement("pre");
      preview.textContent = commands.map((item) => item.command).join("\n\n");
      row.append(label, preview);
      container.append(row);
    }
    $("#agent-apply").textContent = files.length ? `Apply ${files.length} file change${files.length === 1 ? "" : "s"}` : "Review commands";
    $("#agent-modal").classList.remove("hidden");
  }

  async function applyAgentReview() {
    if (!pendingAgent) return;
    const pending = pendingAgent;
    pendingAgent = null;
    $("#agent-modal").classList.add("hidden");
    if (pending.files.length) {
      const result = await window.pywebview.api.apply_agent_files(pending.files);
      if (!result.ok) toast(result.error);
      else {
        toast(`Applied ${result.written.length} file change${result.written.length === 1 ? "" : "s"}`);
        await refreshTree();
        for (const path of result.written) {
          if (openFiles.has(path)) {
            const loaded = await window.pywebview.api.get_file(path);
            if (loaded.ok) openFiles.set(path, { content: loaded.content, savedContent: loaded.content, dirty: false });
          }
        }
        if (activePath && openFiles.has(activePath)) selectFile(activePath);
      }
    }
    for (const item of pending.commands) {
      if (confirm(`Run this command in the project terminal?\n\n${item.command}`)) {
        await submitCommand(item.command);
      }
    }
  }

  function appendTerminal(text, className = "") {
    const output = $("#terminal-output");
    const line = document.createElement("div");
    line.className = `terminal-line ${className}`;
    line.textContent = text;
    output.append(line);
    output.scrollTop = output.scrollHeight;
  }

  async function submitCommand(command) {
    command = command.trim();
    if (!command) return;
    appendTerminal(`PS> ${command}`, "command");
    const result = await window.pywebview.api.execute_command(command);
    if (!result.ok) appendTerminal(result.error, "error");
  }

  function toggleExplorer(view = "explorer") {
    const isSearch = view === "search";
    app.classList.remove("explorer-collapsed");
    $("#explorer-view").classList.toggle("hidden", isSearch);
    $("#search-view").classList.toggle("hidden", !isSearch);
    document.querySelectorAll("[data-activity]").forEach((button) => button.classList.toggle("selected", button.dataset.activity === view));
    if (isSearch) $("#search-input").focus();
    else $("#file-tree").focus();
  }

  function toggleAI() {
    app.classList.toggle("ai-collapsed");
    const collapsed = app.classList.contains("ai-collapsed");
    const button = document.querySelector('[data-activity="ai"]');
    button.classList.toggle("selected", !collapsed);
  }

  function toggleTerminal(force) {
    const terminal = $("#terminal");
    const show = typeof force === "boolean" ? force : terminal.classList.contains("hidden");
    terminal.classList.toggle("hidden", !show);
    document.querySelector('[data-activity="terminal"]').classList.toggle("selected", show);
    if (show) $("#terminal-input").focus();
  }

  function activateCommand(command) {
    if (command === "new") createFile();
    else if (command === "open") openFileDialog();
    else if (command === "search") toggleExplorer("search");
  }

  async function initialize() {
    await refreshTree();
    setStatus("Ready");
  }

  document.querySelectorAll("[data-activity]").forEach((button) => button.addEventListener("click", () => {
    const activity = button.dataset.activity;
    if (activity === "explorer") {
      if (app.classList.contains("explorer-collapsed")) toggleExplorer("explorer");
      else if (!$("#search-view").classList.contains("hidden")) toggleExplorer("explorer");
      else app.classList.add("explorer-collapsed");
    } else if (activity === "search") toggleExplorer("search");
    else if (activity === "ai") toggleAI();
    else if (activity === "terminal") toggleTerminal();
  }));
  $("#open-project").addEventListener("click", chooseProject);
  $("#project-root").addEventListener("click", chooseProject);
  $("#new-file").addEventListener("click", createFile);
  $("#refresh-files").addEventListener("click", refreshTree);
  $("#save-button").addEventListener("click", saveActive);
  $("#preview-button").addEventListener("click", previewActive);
  $("#preview-refresh").addEventListener("click", () => { if (previewUrl) $("#preview-frame").src = previewUrl; });
  $("#preview-browser").addEventListener("click", async () => {
    if (!previewUrl) return;
    const result = await window.pywebview.api.open_in_browser(previewUrl);
    if (!result.ok) toast(result.error);
  });
  $("#close-ai").addEventListener("click", toggleAI);
  $("#clear-chat").addEventListener("click", () => {
    $("#chat-messages").replaceChildren();
    $("#chat-empty").classList.remove("hidden");
  });
  $("#close-terminal").addEventListener("click", () => toggleTerminal(false));
  $("#clear-terminal").addEventListener("click", () => $("#terminal-output").replaceChildren());
  $("#terminal-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#terminal-input");
    const command = input.value;
    if (command.trim()) {
      terminalHistory.push(command);
      historyIndex = terminalHistory.length;
      submitCommand(command);
    }
    input.value = "";
  });
  $("#terminal-input").addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" && terminalHistory.length) {
      historyIndex = Math.max(0, historyIndex - 1);
      event.currentTarget.value = terminalHistory[historyIndex] || "";
      event.preventDefault();
    } else if (event.key === "ArrowDown" && terminalHistory.length) {
      historyIndex = Math.min(terminalHistory.length, historyIndex + 1);
      event.currentTarget.value = terminalHistory[historyIndex] || "";
      event.preventDefault();
    }
  });
  $("#prompt-form").addEventListener("submit", (event) => { event.preventDefault(); sendPrompt(); });
  $("#prompt-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendPrompt();
    }
  });
  $("#search-submit").addEventListener("click", findInProject);
  $("#search-input").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(findInProject, 250);
  });
  if (!cmEditor) {
    $("#source").addEventListener("input", updateDirtyState);
    $("#source").addEventListener("scroll", refreshLineNumbers);
    $("#source").addEventListener("keyup", refreshLineNumbers);
    $("#source").addEventListener("click", refreshLineNumbers);
    $("#source").addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        const editor = event.currentTarget;
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.setRangeText("    ", start, end, "end");
        updateDirtyState();
      }
    });
  }
  $("#agent-close").addEventListener("click", () => { pendingAgent = null; $("#agent-modal").classList.add("hidden"); });
  $("#agent-discard").addEventListener("click", () => { pendingAgent = null; $("#agent-modal").classList.add("hidden"); toast("Agent changes discarded"); });
  $("#agent-apply").addEventListener("click", applyAgentReview);
  document.querySelectorAll("[data-command]").forEach((button) => button.addEventListener("click", () => activateCommand(button.dataset.command)));

  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); saveActive(); }
    else if (mod && event.key.toLowerCase() === "o") { event.preventDefault(); openFileDialog(); }
    else if (mod && event.key.toLowerCase() === "n") { event.preventDefault(); createFile(); }
    else if (mod && event.key.toLowerCase() === "f") { event.preventDefault(); toggleExplorer("search"); }
    else if (event.key === "F6") { event.preventDefault(); previewActive(); }
    else if (event.key === "F5" && mod) { event.preventDefault(); if (activePath) window.pywebview.api.run_current_python(activePath, getEditorValue()).then((r) => { if (!r.ok) toast(r.error); else toggleTerminal(true); }); }
    else if (event.key === "Escape" && !$("#agent-modal").classList.contains("hidden")) { pendingAgent = null; $("#agent-modal").classList.add("hidden"); }
  });

  window.codex = {
    aiDone(payload) {
      const pending = document.getElementById(String(payload.id || ""));
      if (pending) pending.remove();
      $("#send-button").disabled = false;
      const text = payload.text || (payload.ok ? "Done." : "The AI response was empty.");
      addMessage("assistant", text);
      if (payload.mode === "Agent" && payload.agent) showAgentReview(payload.agent);
    },
    terminalOutput(text) { appendTerminal(text); },
    terminalDone(details) { setStatus(details.code === 0 ? "Command completed" : `Command exited with code ${details.code}`); },
  };

  initializeCodeMirror();
  let initialized = false;
  function initializeOnce() {
    if (initialized) return;
    initialized = true;
    initialize();
  }
  window.addEventListener("pywebviewready", initializeOnce, { once: true });
  if (window.pywebview?.api) initializeOnce();
})();
