let activeRulesMap = {};
let activePort = 8080;

async function refreshRules() {
  const { proxyRules = [], proxyPort = 8080 } = await chrome.storage.local.get(['proxyRules', 'proxyPort']);
  activeRulesMap = {};
  activePort = proxyPort;
  proxyRules.forEach(r => {
    if (r.enabled && r.host && r.targetIp) {
      const cleanHost = r.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase();
      activeRulesMap[cleanHost] = r.targetIp.trim();
    }
  });
}

chrome.storage.onChanged.addListener(refreshRules);
refreshRules();

function sendPreflight(host, targetIp) {
  fetch('http://127.0.0.1:' + activePort + '/__bind_next__', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, target_ip: targetIp })
  }).catch(() => {});
}

// 1. Send pre-flight on web requests
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const url = new URL(details.url);
      const host = url.hostname.toLowerCase();
      if (activeRulesMap[host]) {
        sendPreflight(host, activeRulesMap[host]);
      }
    } catch (e) {}
  },
  { 
    urls: ["<all_urls>"],
    types: ["main_frame"] // <--- THIS RESTRICTS IT TO MAIN PAGE NAVIGATIONS ONLY
  }
);

// 2. Send pre-flight immediately when a tab initiates navigation or reload
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) {
    try {
      const url = new URL(tab.url);
      const host = url.hostname.toLowerCase();
      if (activeRulesMap[host]) {
        sendPreflight(host, activeRulesMap[host]);
      }
    } catch (e) {}
  }
});

