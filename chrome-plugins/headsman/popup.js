document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('headerContainer');
  const addBtn = document.getElementById('addBtn');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

  let isDirty = false;

  function markUnsaved() {
    if (!isDirty) {
      isDirty = true;
      saveBtn.classList.add('unsaved');
      saveBtn.textContent = 'Save Changes *';
      statusDiv.textContent = 'Unsaved changes';
      statusDiv.style.color = '#e67e22';
    }
  }

  function markSaved() {
    isDirty = false;
    saveBtn.classList.remove('unsaved');
    saveBtn.textContent = 'Save Changes';
    statusDiv.textContent = 'Rules saved and applied!';
    statusDiv.style.color = '#28a745';
    setTimeout(() => { 
      if (!isDirty) statusDiv.textContent = ''; 
    }, 2500);
  }

  // Helper to create a new input row
  function createHeaderRow(name = '', value = '') {
    const row = document.createElement('div');
    row.className = 'header-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Header (e.g. X-Api-Key)';
    nameInput.value = name;
    nameInput.className = 'header-name';

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.placeholder = 'Value';
    valueInput.value = value;
    valueInput.className = 'header-value';

    // Track text modifications in inputs
    nameInput.addEventListener('input', markUnsaved);
    valueInput.addEventListener('input', markUnsaved);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-remove';
    removeBtn.textContent = '-';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      row.remove();
      markUnsaved();
    });

    row.appendChild(nameInput);
    row.appendChild(valueInput);
    row.appendChild(removeBtn);

    return row;
  }

  // Load saved headers from storage
  const { headers = [] } = await chrome.storage.local.get(['headers']);
  if (headers.length === 0) {
    container.appendChild(createHeaderRow());
  } else {
    headers.forEach(h => container.appendChild(createHeaderRow(h.name, h.value)));
  }

  // Add new blank row when (+) is clicked
  addBtn.addEventListener('click', () => {
    container.appendChild(createHeaderRow());
    markUnsaved();
  });

  // Save headers and apply rules
  saveBtn.addEventListener('click', async () => {
    const rows = container.querySelectorAll('.header-row');
    const updatedHeaders = [];
    const requestHeadersRules = [];

    rows.forEach(row => {
      const name = row.querySelector('.header-name').value.trim();
      const value = row.querySelector('.header-value').value.trim();

      if (name && value) {
        updatedHeaders.push({ name, value });
        requestHeadersRules.push({
          header: name,
          operation: 'set',
          value: value
        });
      }
    });

    const RULE_ID = 1;

    if (requestHeadersRules.length > 0) {
      const rule = {
        id: RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: requestHeadersRules
        },
        condition: {
          urlFilter: '*',
          resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'xmlhttprequest']
        }
      };

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_ID],
        addRules: [rule]
      });
    } else {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_ID]
      });
    }

    await chrome.storage.local.set({ headers: updatedHeaders });
    markSaved();
  });
});