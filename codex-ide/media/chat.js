/**
 * Codex IDE 聊天面板前端 — 零框架原生 JS（性能预算：webView 禁框架）
 */
(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const inputEl = $('input');
  const sendBtn = $('send-btn');
  const cancelBtn = $('cancel-btn');
  const usageEl = $('usage');
  const modelSelect = $('model-select');
  const dirtyBar = $('dirty-bar');
  const dirtyList = $('dirty-list');
  const dirtyTitle = $('dirty-title');

  let currentAssistant = null; // 当前流式消息节点
  let currentText = '';
  let renderPending = false;
  let running = false;
  let presets = [];
  let keyStatus = {};
  let hasMessages = false;

  // ---- 欢迎页（空状态引导） ----

  const QUICK_ACTIONS = [
    { icon: '📖', label: '解释当前文件', prompt: '请解释我当前打开的文件：整体结构、关键逻辑与设计意图。' },
    { icon: '🧪', label: '编写单元测试', prompt: '请为我当前选中的代码（若无选中则为当前文件）编写高质量的单元测试，使用项目已有的测试框架。' },
    { icon: '🔍', label: '代码审查', prompt: '请审查我当前打开的文件：指出潜在 bug、可读性问题与改进建议，按严重程度排序。' },
  ];

  function renderWelcome() {
    if (hasMessages) return;
    const div = document.createElement('div');
    div.id = 'welcome';
    div.innerHTML = `
      <div class="welcome-brand">⚡ Codex IDE</div>
      <div class="welcome-sub">免费/低价模型 · 旗舰级体验 · 隐私物理隔离</div>
      <div class="welcome-actions"></div>
      <div class="welcome-hint">选中代码后可用 <b>Ctrl+I</b> 内联编辑 · 输入 <b>@文件路径</b> 可引用文件 · 右键有解释/修复/重构</div>`;
    const actions = div.querySelector('.welcome-actions');
    for (const a of QUICK_ACTIONS) {
      const btn = document.createElement('button');
      btn.className = 'quick-action';
      btn.innerHTML = `${a.icon} ${a.label}`;
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'send', text: a.prompt });
        addUserMessage(a.prompt);
      });
      actions.appendChild(btn);
    }
    messagesEl.appendChild(div);
  }

  function hideWelcome() {
    hasMessages = true;
    const w = document.getElementById('welcome');
    if (w) w.remove();
  }

  function addInfoMessage(text) {
    const div = document.createElement('div');
    div.className = 'msg info';
    div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  // ---- 消息渲染 ----

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 轻量 Markdown：代码块 / 行内代码 / 粗体 / 标题 / 列表 / 链接 */
  function renderMarkdown(text) {
    const blocks = [];
    // 先抽出代码块，避免内部被行内规则处理；占位符用罕见 ASCII 组合，避免与正文冲突
    let html = escapeHtml(text).replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push(`<pre class="code-block"><div class="code-head"><span>${lang || 'code'}</span><button class="copy-btn" data-code="${encodeURIComponent(code)}">复制</button></div><code>${code}</code></pre>`);
      return `%%CB${blocks.length - 1}%%`;
    });
    html = html
      .replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^######\s(.+)$/gm, '<h6>$1</h6>')
      .replace(/^#####\s(.+)$/gm, '<h5>$1</h5>')
      .replace(/^####\s(.+)$/gm, '<h4>$1</h4>')
      .replace(/^###\s(.+)$/gm, '<h3>$1</h3>')
      .replace(/^##\s(.+)$/gm, '<h2>$1</h2>')
      .replace(/^#\s(.+)$/gm, '<h1>$1</h1>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/^\s*[-*]\s(.+)$/gm, '<li>$1</li>')
      .replace(/^\s*\d+\.\s(.+)$/gm, '<li>$1</li>');
    // 连续 li 包 ul
    html = html.replace(/(<li>[\s\S]*?<\/li>)(\n<li>[\s\S]*?<\/li>)*/g, (m) => `<ul>${m.replace(/\n/g, '')}</ul>`);
    // 段落换行
    html = html.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
    // 还原代码块
    html = html.replace(/%%CB(\d+)%%/g, (_, i) => blocks[Number(i)]);
    return html;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addUserMessage(text) {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'msg user';
    div.innerHTML = `<div class="bubble">${renderMarkdown(text)}</div>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function addErrorMessage(text) {
    const div = document.createElement('div');
    div.className = 'msg error';
    div.innerHTML = `<div class="bubble">⚠ ${escapeHtml(text)}</div>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function beginAssistant(modelLabel) {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'msg assistant';
    div.innerHTML = `<div class="meta">${escapeHtml(modelLabel)}</div><div class="bubble"><span class="cursor">▍</span></div><div class="tools"></div>`;
    messagesEl.appendChild(div);
    currentAssistant = div;
    currentText = '';
    scrollToBottom();
  }

  function flushDelta() {
    if (!currentAssistant || renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      if (!currentAssistant) return;
      const bubble = currentAssistant.querySelector('.bubble');
      bubble.innerHTML = renderMarkdown(currentText) + '<span class="cursor">▍</span>';
      scrollToBottom();
    });
  }

  function endAssistant(costCny) {
    if (!currentAssistant) return;
    const bubble = currentAssistant.querySelector('.bubble');
    bubble.innerHTML = renderMarkdown(currentText);
    if (costCny > 0) {
      const meta = currentAssistant.querySelector('.meta');
      meta.textContent += ` · 本次约 ¥${costCny.toFixed(4)}`;
    }
    currentAssistant = null;
    scrollToBottom();
  }

  function addToolEvent(msg) {
    // 没有进行中的助手消息时，补一个容器
    if (!currentAssistant) beginAssistant('');
    const tools = currentAssistant.querySelector('.tools');
    const div = document.createElement('div');
    div.className = 'tool ' + (msg.phase === 'call' ? 'call' : msg.success ? 'ok' : 'fail');
    if (msg.phase === 'call') {
      const brief = summarizeInput(msg.name, msg.input);
      div.innerHTML = `<span class="tool-icon">⚙</span> <strong>${escapeHtml(msg.name)}</strong> <span class="tool-brief">${escapeHtml(brief)}</span>`;
    } else {
      const icon = msg.success ? '✓' : '✗';
      const output = (msg.output || '').slice(0, 2000);
      div.innerHTML = `<details><summary>${icon} ${escapeHtml(msg.name)} 结果</summary><pre>${escapeHtml(output)}</pre></details>`;
    }
    tools.appendChild(div);
    scrollToBottom();
  }

  function summarizeInput(name, input) {
    if (!input) return '';
    if (input.path) return String(input.path);
    if (input.command) return String(input.command).slice(0, 80);
    if (input.pattern) return `/${String(input.pattern).slice(0, 40)}/`;
    const s = JSON.stringify(input);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  }

  // ---- 待应用变更 ----

  function updateDirty(files) {
    if (!files || files.length === 0) {
      dirtyBar.classList.add('hidden');
      return;
    }
    dirtyBar.classList.remove('hidden');
    dirtyTitle.textContent = `${files.length} 个文件待应用`;
    dirtyList.innerHTML = '';
    for (const f of files) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="${f.deleted ? 'deleted' : ''}">${f.deleted ? '🗑 ' : ''}${escapeHtml(f.relativePath)}</span><button data-path="${escapeHtml(f.path)}">Diff</button>`;
      li.querySelector('button').addEventListener('click', (e) => {
        vscode.postMessage({ type: 'showDiff', path: e.target.dataset.path });
      });
      dirtyList.appendChild(li);
    }
  }

  // ---- 模型选择 ----

  function refreshModelSelect(activePreset) {
    modelSelect.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = '⚡ 自动路由';
    modelSelect.appendChild(auto);
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      const hasKey = keyStatus[p.id];
      opt.textContent = `${hasKey ? '' : '🔒 '}${p.label}${p.pricing.inputPer1M === 0 ? '（免费）' : ''}`;
      modelSelect.appendChild(opt);
    }
    modelSelect.value = activePreset || 'auto';
  }

  // ---- 事件 ----

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'state':
        presets = msg.presets || [];
        keyStatus = msg.keyStatus || {};
        refreshModelSelect(msg.activePreset);
        break;
      case 'history':
        // 会话回放（重启恢复）
        for (const m of msg.messages || []) {
          if (m.role === 'user') addUserMessage(m.content);
          else if (m.role === 'assistant') {
            beginAssistant('');
            currentText = m.content;
            endAssistant(0);
          }
        }
        if (!hasMessages) renderWelcome();
        break;
      case 'queued':
        addInfoMessage(`⏳ 已排队：「${msg.text.slice(0, 50)}${msg.text.length > 50 ? '…' : ''}」将在当前任务完成后自动执行`);
        break;
      case 'userEcho':
        addUserMessage(msg.text);
        break;
      case 'streamStart':
        setRunning(true);
        beginAssistant(msg.presetLabel);
        break;
      case 'delta':
        currentText += msg.text;
        flushDelta();
        break;
      case 'streamEnd':
        setRunning(false);
        endAssistant(msg.costCny);
        break;
      case 'tool':
        addToolEvent(msg);
        break;
      case 'error':
        setRunning(false);
        if (currentAssistant) endAssistant(0);
        addErrorMessage(msg.message);
        break;
      case 'dirtyChanged':
        updateDirty(msg.files);
        break;
      case 'usage':
        usageEl.textContent = `会话 ${formatTokens(msg.usage.totalTokens)} · 约 ¥${msg.sessionCostCny.toFixed(4)}`;
        break;
    }
  });

  function formatTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M tok';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k tok';
    return n + ' tok';
  }

  function setRunning(v) {
    running = v;
    sendBtn.classList.toggle('hidden', v);
    cancelBtn.classList.toggle('hidden', !v);
    inputEl.disabled = false; // 输入始终可用，发送时再排队
  }

  function doSend() {
    const text = inputEl.value.trim();
    if (!text || running) return;
    addUserMessage(text);
    vscode.postMessage({ type: 'send', text });
    inputEl.value = '';
  }

  sendBtn.addEventListener('click', doSend);
  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
    setRunning(false);
    if (currentAssistant) endAssistant(0);
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  });

  modelSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setModel', presetId: modelSelect.value });
  });

  $('key-btn').addEventListener('click', () => {
    const target = modelSelect.value === 'auto' ? 'glm-flash' : modelSelect.value;
    vscode.postMessage({ type: 'setApiKey', presetId: target });
  });

  $('new-session-btn').addEventListener('click', () => {
    messagesEl.innerHTML = '';
    hasMessages = false;
    renderWelcome();
    vscode.postMessage({ type: 'newSession' });
  });

  $('apply-all').addEventListener('click', () => vscode.postMessage({ type: 'applyAll' }));
  $('reject-all').addEventListener('click', () => vscode.postMessage({ type: 'rejectAll' }));

  // 代码复制
  messagesEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('copy-btn')) {
      const code = decodeURIComponent(e.target.dataset.code || '');
      navigator.clipboard.writeText(code);
      e.target.textContent = '已复制';
      setTimeout(() => (e.target.textContent = '复制'), 1200);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
