document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('ruleContainer');
  const addBtn = document.getElementById('addBtn');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');
  const proxyStatusDiv = document.getElementById('proxyStatus');
  const portInput = document.getElementById('proxyPortInput');

  let isUnsaved = false;
  let portCheckTimeout = null;

  // Helper to dynamically get current port from input box
  function getSelectedPort() {
    if (portInput && portInput.value.trim() !== '') {
      const parsed = parseInt(portInput.value.trim(), 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
        return parsed;
      }
    }
    return 8080;
  }

  function markUnsaved() {
    if (!isUnsaved) {
      isUnsaved = true;
      if (saveBtn) saveBtn.classList.add('unsaved');
      if (statusDiv) {
        statusDiv.style.color = '#fd7e14';
        statusDiv.textContent = 'Unsaved changes';
      }
    }
  }

  function markSaved(message = 'Changes saved successfully!') {
    isUnsaved = false;
    if (saveBtn) saveBtn.classList.remove('unsaved');
    if (statusDiv) {
      statusDiv.style.color = '#198754';
      statusDiv.textContent = message;
      setTimeout(() => {
        if (!isUnsaved) {
          statusDiv.textContent = '';
        }
      }, 2500);
    }
  }

  // Health check endpoint probe reading directly from the text box
  async function checkProxyStatus() {
    const currentPort = getSelectedPort();

    if (proxyStatusDiv) {
      proxyStatusDiv.style.color = '#0d6efd';
      proxyStatusDiv.textContent = `Checking port ${currentPort}...`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`http://127.0.0.1:${currentPort}/__mmp_check__`, {
        method: 'GET',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data && data.status === 'online') {
          if (proxyStatusDiv) {
            proxyStatusDiv.style.color = '#198754';
            proxyStatusDiv.textContent = `Proxy Online - well done!`;
          }
          return;
        }
      }
      throw new Error('Invalid status response');
    } catch (err) {
      if (proxyStatusDiv) {
        proxyStatusDiv.style.color = '#dc3545';
        proxyStatusDiv.innerHTML = `Proxy not found! <a href="https://github.com/clockworkearl/middleman-proxy/" target="_blank">Download Middleman-Proxy</a> and run it locally on port ${currentPort}.`;
      }    }
  }

  function createRuleRow(host = '', targetIp = '', enabled = true) {
    const row = document.createElement('div');
    row.className = `rule-row ${enabled ? '' : 'disabled'}`.trim();

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = enabled;
    checkbox.className = 'rule-checkbox';

    const hostInput = document.createElement('input');
    hostInput.type = 'text';
    hostInput.placeholder = '<target hostname>';
    hostInput.value = host;

    const targetInput = document.createElement('input');
    targetInput.type = 'text';
    targetInput.placeholder = '<target ip>';
    targetInput.value = targetIp;

    checkbox.addEventListener('change', () => {
      row.classList.toggle('disabled', !checkbox.checked);
      markUnsaved();
    });

    hostInput.addEventListener('input', markUnsaved);
    targetInput.addEventListener('input', markUnsaved);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.textContent = '-';
    removeBtn.title = 'Remove Row';
    removeBtn.addEventListener('click', () => {
      row.remove();
      markUnsaved();
    });

    row.appendChild(checkbox);
    row.appendChild(hostInput);
    row.appendChild(targetInput);
    row.appendChild(removeBtn);

    return row;
  }

  // Listen for port input updates
  if (portInput) {
    portInput.addEventListener('input', () => {
      markUnsaved();
      clearTimeout(portCheckTimeout);
      portCheckTimeout = setTimeout(() => {
        checkProxyStatus();
      }, 600);
    });
  }

  // Load stored rules & proxy port BEFORE running status checks
  try {
    const { proxyRules = [], proxyPort = 8080 } = await chrome.storage.local.get(['proxyRules', 'proxyPort']);
    
    if (portInput) {
      portInput.value = proxyPort;
    }

    if (proxyRules.length === 0) {
      container.appendChild(createRuleRow('', '', true));
    } else {
      proxyRules.forEach(item => {
        container.appendChild(createRuleRow(item.host, item.targetIp, item.enabled ?? true));
      });
    }

    // Explicitly check proxy status using loaded port value
    await checkProxyStatus();
  } catch (err) {
    console.error("Storage error:", err);
  }

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      container.appendChild(createRuleRow('', '', true));
      markUnsaved();
    });
  }

  function buildPacScript(activeRules, port) {
    if (!activeRules || activeRules.length === 0) {
      return `function FindProxyForURL(url, host) { return "DIRECT"; }`;
    }

    const conditions = activeRules.map(rule => {
      const cleanHost = rule.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
      return `if (host === "${cleanHost}") { return "PROXY 127.0.0.1:${port}"; }`;
    }).join('\n      ');

    return `
      function FindProxyForURL(url, host) {
        if (isInNet(host, "127.0.0.1", "255.255.255.255") || host === "localhost") {
          return "DIRECT";
        }
        ${conditions}
        return "DIRECT";
      }
    `;
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const rows = container.querySelectorAll('.rule-row');
      const updatedRules = [];
      const activeRules = [];
      const selectedPort = getSelectedPort();

      rows.forEach(row => {
        const checkbox = row.querySelector('.rule-checkbox');
        const inputs = row.querySelectorAll('input[type="text"]');
        const hostInput = inputs[0];
        const targetInput = inputs[1];

        if (checkbox && hostInput && targetInput) {
          const isEnabled = checkbox.checked;
          const host = hostInput.value.trim();
          const targetIp = targetInput.value.trim();

          if (host) {
            updatedRules.push({ host, targetIp, enabled: isEnabled });

            if (isEnabled && targetIp) {
              activeRules.push({ host, targetIp });
            }
          }
        }
      });

      await chrome.storage.local.set({ proxyRules: updatedRules, proxyPort: selectedPort });

      if (activeRules.length > 0) {
        const pacScriptContent = buildPacScript(activeRules, selectedPort);
        const config = {
          mode: "pac_script",
          pacScript: { data: pacScriptContent }
        };

        chrome.proxy.settings.set({ value: config, scope: 'regular' }, () => {
          if (chrome.runtime.lastError) {
            if (statusDiv) {
              statusDiv.style.color = '#dc3545';
              statusDiv.textContent = `Error setting proxy`;
            }
          } else {
            markSaved('Changes saved successfully!');
            checkProxyStatus();
          }
        });
      } else {
        chrome.proxy.settings.clear({ scope: 'regular' }, () => {
          markSaved('Changes saved successfully!');
          checkProxyStatus();
        });
      }
    });
  }
});