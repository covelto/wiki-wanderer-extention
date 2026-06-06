// background.js

// content_scriptからのメッセージを監視し、送信元のtabIdを返す
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "INIT_TAB") {
    if (sender.tab && sender.tab.id) {
      sendResponse({ tabId: sender.tab.id });
    } else {
      sendResponse({ tabId: null });
    }
  }
  return true; // 応答を非同期で行うためにtrueを返す
});

// 新しいタブが作成されたとき、親タブ（リンク元）のパスを引き継ぐ
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId) {
    const openerPathKey = `path_${tab.openerTabId}`;
    const newPathKey = `path_${tab.id}`;
    
    // ウィジェットの位置やドラッグ状態も引き継ぐと使いやすいため、ウィジェット位置も引き継ぐ
    const openerWidgetKey = `widget_${tab.openerTabId}`;
    const newWidgetKey = `widget_${tab.id}`;

    chrome.storage.local.get([openerPathKey, openerWidgetKey], (res) => {
      const updateData = {};
      if (res[openerPathKey]) {
        updateData[newPathKey] = res[openerPathKey];
      }
      if (res[openerWidgetKey]) {
        updateData[newWidgetKey] = res[openerWidgetKey];
      }
      
      if (Object.keys(updateData).length > 0) {
        chrome.storage.local.set(updateData, () => {
          console.log(`Copied state from parent tab ${tab.openerTabId} to new tab ${tab.id}`);
        });
      }
    });
  }
});

// タブが閉じられた際、そのタブに関連するパスデータをストレージから削除してクリーンアップする
chrome.tabs.onRemoved.addListener((tabId) => {
  const pathKey = `path_${tabId}`;
  const lastClickKey = `lastClick_${tabId}`;
  const widgetKey = `widget_${tabId}`;
  const posKey = `pos_${tabId}`;
  const teleportKey = `teleportTarget_${tabId}`;
  chrome.storage.local.remove([pathKey, lastClickKey, widgetKey, posKey, teleportKey], () => {
    console.log(`Cleaned up storage for tab: ${tabId}`);
  });
});
