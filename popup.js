// popup.js - Wiki Wanderer Popup script

document.addEventListener('DOMContentLoaded', () => {
  const toggleInput = document.getElementById('tracking-toggle');
  const modeToggle = document.getElementById('mode-toggle');
  const resetBtn = document.getElementById('reset-path-btn');
  const openWikiBtn = document.getElementById('open-wiki-btn');

  // 現在のアクティブなタブ ID を取得して初期化
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) return;
    const tabId = tabs[0].id;
    
    // トラッキングのアクティブ状態と更新モードを初期表示
    chrome.storage.local.get(['trackingActive', `updateMode_${tabId}`], (data) => {
      toggleInput.checked = !!data.trackingActive;
      
      const isAlways = (data[`updateMode_${tabId}`] !== 'on_cycle'); // デフォルトは always
      modeToggle.checked = isAlways;
      
      // トラッキングがアクティブならモードスイッチは無効化
      modeToggle.disabled = !!data.trackingActive;
    });

    // トグル変更の監視
    toggleInput.addEventListener('change', () => {
      const active = toggleInput.checked;
      modeToggle.disabled = active; // 記録中はモード切り替えをロック
      chrome.storage.local.set({ trackingActive: active });
    });

    // モードスイッチ変更の監視
    modeToggle.addEventListener('change', () => {
      const mode = modeToggle.checked ? 'always' : 'on_cycle';
      const update = {};
      update[`updateMode_${tabId}`] = mode;
      chrome.storage.local.set(update);
    });

    // 現在のタブの経路とショートカットデータをリセットする
    resetBtn.addEventListener('click', () => {
      if (confirm('現在のタブの閲覧経路履歴をクリアしますか？')) {
        const update = {};
        update[`path_${tabId}`] = [];
        update[`shortcuts_${tabId}`] = [];
        chrome.storage.local.set(update, () => {
          alert('経路をリセットしました。');
          window.close(); // ポップアップを閉じる
        });
      }
    });
  });

  // Wikipediaを開くリンク処理 (別タブで新規に開く)
  openWikiBtn.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://ja.wikipedia.org/' });
  });
});
