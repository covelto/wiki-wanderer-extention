// content.js - Wikipedia Loop Tracker Content Script (Breadcrumbs Theme)

(function () {
  // すでにコンテンツスクリプトが読み込まれている場合は再実行を防ぐ
  if (window.wikiLoopTrackerLoaded) return;
  window.wikiLoopTrackerLoaded = true;

  // -------------------------------------------------------------
  // グローバル状態管理
  // -------------------------------------------------------------
  let tabId = null;
  let trackingActive = false;
  let redirectCache = {}; // { rawKey: canonicalKey }
  let currentPath = []; // [{ key, title, url }]

  // ウィジェットのUI状態
  let widgetState = {
    minimized: false
  };

  let currentHoveredKey = null; // 現在ホバーされている記事キー (イベントデリゲーション用)
  let updateMode = 'always'; // 'always' (随時更新) または 'on_cycle' (閉路完成時のみ更新)
  let savedShortcuts = []; // 保存されたショートカット線のリスト

  // -------------------------------------------------------------
  // ヘルパー関数: Wikipedia記事キーの抽出
  // -------------------------------------------------------------
  function getArticleKey(href) {
    if (!href) return null;
    try {
      // デコードして解析
      const decodedHref = decodeURIComponent(href);

      // /wiki/ 以降の部分を抽出
      const match = decodedHref.match(/\/wiki\/([^#?]+)/);
      if (!match) return null;
      let key = match[1];

      // 特殊な名前空間 (Category, Help, Talk, Special, ファイル, 等) は除外する
      const namespacePattern = /^(Category|Help|Special|Wikipedia|Talk|File|Portal|Template|MediaWiki|Draft|User|Book|Module|Gadget|TimedText|Media):/i;
      const jpNamespacePattern = /^(特別|カテゴリ|ヘルプ|Wikipedia|トーク|ファイル|ポータル|テンプレート|プロジェクト|ユーザー|画像|架空|Categoryトーク):/i;

      if (namespacePattern.test(key) || jpNamespacePattern.test(key)) {
        return null;
      }

      // アンダースコアをスペースに置換し、整形
      key = key.replace(/_/g, ' ').trim();

      // メインページは除外
      if (key.toLowerCase() === 'main page' || key === 'メインページ') {
        return null;
      }

      return key;
    } catch (e) {
      console.error('Error parsing article key:', e);
      return null;
    }
  }

  // ページ内のWikipediaリンクを抽出し、正規化（または生）キーのリストを返す
  function extractPageLinks() {
    const links = document.querySelectorAll('#bodyContent a:not(.new), #mw-content-text a:not(.new), #content a:not(.new)');
    const linkKeys = new Set();
    links.forEach(link => {
      const rawKey = getArticleKey(link.href);
      if (rawKey) {
        // リダイレクトキャッシュにあれば正規キー、なければ生キー
        const resolvedKey = redirectCache[rawKey] || rawKey;
        linkKeys.add(resolvedKey);
      }
    });
    return Array.from(linkKeys);
  }

  // -------------------------------------------------------------
  // 初期化処理: バックグラウンドスクリプトからtabIdを取得して開始
  // -------------------------------------------------------------
  // 本文内リンクのホバーハイライト用イベントデリゲーション
  function initHoverDelegation() {
    const container = document.body;

    container.addEventListener('mouseover', (e) => {
      if (!trackingActive) return;
      const link = e.target.closest('a');
      const key = link?.getAttribute('data-wiki-key');
      if (key) {
        if (currentHoveredKey !== key) {
          if (currentHoveredKey) {
            handleLinkHover(currentHoveredKey, false);
          }
          currentHoveredKey = key;
          handleLinkHover(key, true);
        }
      } else {
        if (currentHoveredKey) {
          handleLinkHover(currentHoveredKey, false);
          currentHoveredKey = null;
        }
      }
    });
  }

  function init() {
    initHoverDelegation();
    chrome.runtime.sendMessage({ type: "INIT_TAB" }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("Could not connect to background script. Extension might have reloaded.");
        return;
      }

      if (response && response.tabId !== null) {
        tabId = response.tabId;
        loadStateAndProcess();
      }
    });
  }

  // ストレージから状態を読み込み、ナビゲーション処理とUI表示を行う
  function loadStateAndProcess() {
    const keys = [
      "trackingActive",
      "redirectCache",
      `updateMode_${tabId}`,
      `shortcuts_${tabId}`,
      `path_${tabId}`,
      `lastClick_${tabId}`,
      `widget_${tabId}`,
      `teleportTarget_${tabId}`
    ];

    chrome.storage.local.get(keys, (data) => {
      trackingActive = !!data.trackingActive;
      redirectCache = data.redirectCache || {};
      updateMode = data[`updateMode_${tabId}`] || 'always';
      savedShortcuts = data[`shortcuts_${tabId}`] || [];
      currentPath = data[`path_${tabId}`] || [];

      if (data[`widget_${tabId}`]) {
        widgetState = data[`widget_${tabId}`];
      }

      // ナビゲーション検知とパスの更新
      if (trackingActive) {
        processNavigation(data[`lastClick_${tabId}`], data[`teleportTarget_${tabId}`]);
      } else {
        renderWidgetStructure();
      }
    });
  }

  // -------------------------------------------------------------
  // パストレーキング & ナビゲーション処理
  // -------------------------------------------------------------
  function processNavigation(lastClickData, teleportTarget) {
    // リダイレクト解決のため、canonicalリンクタグから正規のURLを取得
    const canonicalLink = document.querySelector('link[rel="canonical"]');
    const currentUrl = canonicalLink ? canonicalLink.href : window.location.href;
    const currentKey = getArticleKey(currentUrl);

    // 記事以外のページ（メインページなど）はパスを更新しない
    if (!currentKey) {
      renderWidgetStructure();
      return;
    }

    const currentTitle = document.getElementById('firstHeading')?.textContent.trim() || document.title.replace(' - Wikipedia', '').trim();
    const pageLinks = extractPageLinks();
    const currentNode = { key: currentKey, title: currentTitle, url: currentUrl, links: pageLinks };

    // 現在のアクセスURL（リダイレクト前）から正規キーへのマッピングをキャッシュに追加
    const rawUrlKey = getArticleKey(window.location.href);
    if (rawUrlKey && rawUrlKey !== currentKey && redirectCache[rawUrlKey] !== currentKey) {
      redirectCache[rawUrlKey] = currentKey;
      chrome.storage.local.set({ redirectCache });
    }

    // テレポート遷移（ウィジェットUIのクリック）だった場合
    if (teleportTarget) {
      if (currentKey === teleportTarget) {
        // すでにクリック時にパスは調節されているため、ここではパスを更新せずフラグだけ消す
        const update = {};
        update[`teleportTarget_${tabId}`] = null;
        chrome.storage.local.set(update, () => {
          renderWidgetStructure();
          scanAndInjectBadges();
        });
        return;
      } else {
        // 異なるキーへの移動の場合はテレポート失敗とみなしフラグを消す
        const update = {};
        update[`teleportTarget_${tabId}`] = null;
        chrome.storage.local.set(update);
      }
    }

    // ナビゲーション種別の取得
    let navType = 'navigate';
    try {
      const navEntries = performance.getEntriesByType('navigation');
      if (navEntries.length > 0) {
        navType = navEntries[0].type;
      }
    } catch (e) {
      console.warn('Navigation API not fully supported:', e);
    }

    if (currentPath.length === 0) {
      // パスが空の場合は現在地から開始
      currentPath = [currentNode];
    } else if (currentPath.length >= 2 && currentPath[currentPath.length - 2].key === currentKey) {
      // 相互リンクによる1往復の戻り（A -> B -> A）を検出した場合、閉路とせず、B の記録を消去して A に巻き戻す
      currentPath.pop();
    } else {
      if (navType === 'back_forward') {
        // ブラウザバック/フォワードの場合
        // 過去の経路に含まれるページに戻ったか判定
        const matchIdx = currentPath.findIndex(node => node.key === currentKey);
        if (matchIdx !== -1) {
          // 該当ページまで経路を巻き戻す（ブラウザバック挙動）
          currentPath = currentPath.slice(0, matchIdx + 1);
        } else {
          // 経路にない場合は新しく追加
          currentPath.push(currentNode);
        }
      } else {
        // 通常のリンククリック、またはその他の遷移
        const lastNode = currentPath[currentPath.length - 1];

        // 直前のリンククリックのURLと一致するか
        const isClickMatch = lastClickData && lastClickData.key === currentKey;

        // リファラがパスの中に存在するか検索する（巻き戻しやデトアからの遷移を検知）
        let referrerIdx = -1;
        if (document.referrer) {
          const referrerKey = getArticleKey(document.referrer);
          if (referrerKey) {
            referrerIdx = currentPath.map(n => n.key).lastIndexOf(referrerKey);
          }
        }

        if (isClickMatch) {
          // クリックに一致する場合はそのまま追加
          currentPath.push(currentNode);
        } else if (referrerIdx !== -1) {
          // リファラがパス上に見つかった場合、そこまで巻き戻した上で新規遷移を追加する
          currentPath = currentPath.slice(0, referrerIdx + 1);
          currentPath.push(currentNode);
        } else {
          // リファラがない、またはパス上にない新規直接遷移
          currentPath.push(currentNode);
        }
      }
    }

    // ショートカットの更新
    savedShortcuts = filterShortcutsForPathLength(savedShortcuts, currentPath.length);

    if (updateMode === 'always') {
      // 随時更新モード：全体を再計算
      savedShortcuts = getShortcutLinksForRange(0, currentPath.length - 1);
    } else {
      // 閉路完成時更新モード：閉路が生まれた場合のみ、閉路内のショートカットを追加
      const { startIdx: loopStartIdx } = getActiveCycle(currentPath);
      if (loopStartIdx !== -1) {
        // 新しい閉路範囲のショートカットを抽出
        const newShortcuts = getShortcutLinksForRange(loopStartIdx, currentPath.length - 1);

        // 既存のショートカットに追加 (重複排除)
        newShortcuts.forEach(ns => {
          const exists = savedShortcuts.some(os =>
            (os.fromIdx === ns.fromIdx && os.toIdx === ns.toIdx) ||
            (os.fromIdx === ns.toIdx && os.toIdx === ns.fromIdx)
          );
          if (!exists) {
            savedShortcuts.push(ns);
          }
        });
      }
    }

    // ストレージの更新
    const update = {};
    update[`path_${tabId}`] = currentPath;
    update[`shortcuts_${tabId}`] = savedShortcuts;
    update[`lastClick_${tabId}`] = null; // クリック状態の消費

    chrome.storage.local.set(update, () => {
      // 描画処理の実行
      renderWidgetStructure();
      scanAndInjectBadges();
    });
  }

  // -------------------------------------------------------------
  // リンクスキャン & ループサイズバッジの注入
  // -------------------------------------------------------------
  function scanAndInjectBadges() {
    // トラッキングが無効、または経路が空ならバッジを除去して終了
    if (!trackingActive || currentPath.length === 0) {
      removeBadges();
      return;
    }

    // 既存のバッジを一旦すべて削除
    removeBadges();

    // パスキーの配列とインデックス探索キャッシュを生成 (計算コスト O(N) 化)
    const pathKeys = currentPath.map(n => n.key);
    const keyLastIndexCache = {};

    // 記事本文のリンクをスキャン (絶対・相対URLやモバイル版に配慮し、幅広くa要素を取得)
    const links = document.querySelectorAll('#bodyContent a:not(.new), #mw-content-text a:not(.new), #content a:not(.new)');
    const missingKeys = new Set();
    const processedLinks = new Set(); // 重複したリンク要素の多重処理を防ぐ

    links.forEach(link => {
      // 同じリンク要素に対する二重処理を防ぐ
      if (processedLinks.has(link)) return;
      processedLinks.add(link);

      const hrefAttr = link.getAttribute('href');
      if (!hrefAttr) return;

      const rawLinkKey = getArticleKey(link.href); // link.hrefはブラウザが絶対URLに解決したもの
      if (!rawLinkKey) return;

      // リダイレクトキャッシュから正規のキーを取得
      const linkKey = redirectCache[rawLinkKey];

      if (linkKey === undefined) {
        // 未解決キーをプールし、フォールバックで元のキーのままチェック
        missingKeys.add(rawLinkKey);
        checkAndInjectBadge(link, rawLinkKey, pathKeys, keyLastIndexCache);
      } else {
        // 解決済みの正規キーでチェック
        checkAndInjectBadge(link, linkKey, pathKeys, keyLastIndexCache);
      }
    });

    // 未解決キーのAPI問い合わせを実行
    if (missingKeys.size > 0) {
      fetchRedirectsInBatches(Array.from(missingKeys));
    }
  }

  // バッジ判定・挿入ヘルパー (キャッシュと共通配列を渡して最適化)
  function checkAndInjectBadge(link, key, pathKeys, keyLastIndexCache) {
    // キャッシュを利用して過去に訪問したページかチェック
    let lastIdx = keyLastIndexCache[key];
    if (lastIdx === undefined) {
      lastIdx = pathKeys.lastIndexOf(key);
      keyLastIndexCache[key] = lastIdx;
    }

    // 訪問済み、かつ現在のページ自身ではない場合（自分自身へのリンクはバッジを表示しない）
    if (lastIdx !== -1 && lastIdx < pathKeys.length - 1) {
      // ループに含まれるユニークな記事の数 = pathKeys.length - lastIdx
      const cycleSize = pathKeys.length - lastIdx;

      // すでにバッジが注入されていないか確認
      if (link.querySelector('.wiki-loop-badge')) return;

      // バッジの作成
      const badge = document.createElement('span');
      badge.className = 'wiki-loop-badge';

      if (cycleSize === 2) {
        badge.innerText = '⇄';
        badge.title = `このリンクを踏むと、直前の記事に戻ります（履歴は巻き戻されます）。`;
      } else {
        badge.innerText = cycleSize;
        badge.title = `このリンクを踏むと、${cycleSize}記事分の閉路（ループ）が形成されます。`;
      }

      badge.setAttribute('data-size', Math.min(5, cycleSize));
      badge.setAttribute('data-size-group', cycleSize >= 10 ? 'large' : 'normal');
      badge.setAttribute('data-target-key', key);

      // リンク内にバッジを追加
      link.appendChild(badge);

      // 個別のイベントリスナー登録は廃止し、data-wiki-key 属性を付与してイベントデリゲーションで対応
      link.setAttribute('data-wiki-key', key);
    }
  }

  // Wikipedia APIを使用してリダイレクトをバッチ解決
  function fetchRedirectsInBatches(keys) {
    const batchSize = 50;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      resolveRedirects(batch);
    }
  }

  async function resolveRedirects(keys) {
    if (keys.length === 0) return;

    const lang = window.location.hostname.split('.')[0] || 'ja';
    const titlesParam = keys.map(encodeURIComponent).join('|');
    const apiUrL = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${titlesParam}&redirects=1&format=json&origin=*`;

    try {
      const res = await fetch(apiUrL);
      const data = await res.json();

      let cacheUpdated = false;

      // 1. リダイレクト解決情報の収集
      if (data.query && data.query.redirects) {
        data.query.redirects.forEach(redir => {
          const fromKey = redir.from.replace(/_/g, ' ').trim();
          const toKey = redir.to.replace(/_/g, ' ').trim();
          if (fromKey && toKey) {
            redirectCache[fromKey] = toKey;
            cacheUpdated = true;
          }
        });
      }

      // 2. リダイレクトがなかったものも含め、自己宛てキャッシュを設定（重複問い合わせ防止）
      keys.forEach(key => {
        if (redirectCache[key] === undefined) {
          redirectCache[key] = key;
          cacheUpdated = true;
        }
      });

      if (cacheUpdated) {
        chrome.storage.local.set({ redirectCache }, () => {
          // キャッシュ更新後に再スキャン
          scanAndInjectBadges();
          renderBreadcrumbs();
        });
      }
    } catch (e) {
      console.error('Failed to resolve redirects from API:', e);
    }
  }

  function removeBadges() {
    const badges = document.querySelectorAll('.wiki-loop-badge');
    badges.forEach(badge => badge.remove());

    const highlightedLinks = document.querySelectorAll('.wiki-loop-link-highlight');
    highlightedLinks.forEach(link => link.classList.remove('wiki-loop-link-highlight'));

    const wikiKeys = document.querySelectorAll('a[data-wiki-key]');
    wikiKeys.forEach(link => link.removeAttribute('data-wiki-key'));

    currentHoveredKey = null;
  }

  // リンクホバー時にパンくずリストと本文を相互ハイライト
  function handleLinkHover(key, isHover) {
    // 1. パンくずリスト内の該当要素をハイライト
    highlightBreadcrumbs(key, isHover);

    // 2. 本文中の同じ宛先のリンクすべてをハイライト
    const targetLinks = document.querySelectorAll(`#bodyContent a[href*="/wiki/"]`);
    targetLinks.forEach(link => {
      if (getArticleKey(link.href) === key) {
        if (isHover) {
          link.classList.add('wiki-loop-link-highlight');
        } else {
          link.classList.remove('wiki-loop-link-highlight');
        }
      }
    });
  }

  // -------------------------------------------------------------
  // ドラッグ & ドロップ可能なウィジェットの生成
  // -------------------------------------------------------------
  function renderWidgetStructure() {
    let container = document.getElementById('wiki-loop-tracker-container');

    if (!container) {
      container = document.createElement('div');
      container.id = 'wiki-loop-tracker-container';
      document.body.appendChild(container);
    }

    // トラッキングがアクティブかどうかでクラスを付与
    container.className = '';
    if (!trackingActive) {
      container.classList.add('inactive');
    }

    // 描画対象のショートカットが1つでもあるか？
    const shortcuts = getShortcutLinks();
    const hasShortcut = shortcuts.length > 0;

    if (hasShortcut && trackingActive) {
      container.classList.add('has-loop-path');
    }

    if (widgetState.minimized) {
      container.classList.add('minimized');
      container.style.height = '';
      container.style.maxHeight = '';
    }

    // ドラッグ用のインラインスタイル指定をクリアし、CSS側の設定を優先する
    container.style.bottom = '';
    container.style.right = '';
    container.style.left = '';
    container.style.top = '';

    // ボディ余白の自動確保（Wikipediaのオリジナル要素と重なるのを防ぐ）
    if (widgetState.minimized) {
      document.body.style.paddingBottom = '0px';
    } else {
      document.body.style.paddingBottom = (hasShortcut && trackingActive) ? '72px' : '64px';
    }

    // 最小化状態の表示
    if (widgetState.minimized) {
      renderMinimizedWidget(container);
    } else {
      renderMaximizedWidget(container);
    }
  }

  // 最小化されたタブの描画
  function renderMinimizedWidget(container) {
    const totalArticles = currentPath.length;
    container.innerHTML = `
      <div class="wiki-tracker-minimized-tab" id="wiki-tracker-toggle-expand" title="Wiki Loop Trackerを展開">
        <svg viewBox="0 0 24 24">
          <polyline points="15 3 21 3 21 9"></polyline>
          <polyline points="9 21 3 21 3 15"></polyline>
          <line x1="21" y1="3" x2="14" y2="10"></line>
          <line x1="3" y1="21" x2="10" y2="14"></line>
        </svg>
        <span>Wiki Wanderer ${trackingActive && totalArticles > 0 ? `(${totalArticles})` : ''}</span>
      </div>
    `;

    // 展開ボタンのイベント
    document.getElementById('wiki-tracker-toggle-expand').addEventListener('click', () => {
      widgetState.minimized = false;
      saveWidgetState();
      renderWidgetStructure();
    });

    // ドラッグ対応は廃止
  }

  // 通常パネルの描画
  function renderMaximizedWidget(container) {
    // 閉路（ループ）が現在形成されているか判定
    const { nodes: loopNodes } = getActiveCycle(currentPath);

    // パスの統計
    const totalSteps = currentPath.length;
    const uniqueCount = new Set(currentPath.map(n => n.key)).size;

    container.innerHTML = `
      <div class="wiki-tracker-bg-overlay"></div>
      <svg id="wiki-tracker-svg-overlay">
        <defs>
          <marker id="wiki-arrow-marker" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 2 2.5 L 7 5 L 2 7.5 z" fill="currentColor"></path>
          </marker>
        </defs>
        <g id="wiki-tracker-svg-group"></g>
      </svg>
      <div class="wiki-tracker-glass-panel">
        <!-- 中央パネル: 横スクロールパンくずリスト表示領域 -->
        <div class="wiki-tracker-canvas-container" id="wiki-tracker-breadcrumbs-area">
        </div>
        
        <!-- 右パネル: タイトル、操作ボタン、統計情報を集約 -->
        <div class="wiki-tracker-right-panel">
          <!-- 上段: タイトル ＆ コントロールボタン群 -->
          <div class="wiki-tracker-right-top">
            <div class="wiki-tracker-title">
              <svg viewBox="0 0 24 24">
                <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="#3366cc" stroke-width="2" fill="none"/>
                <path d="M12 6V12L16 14" stroke="#3366cc" stroke-width="2" stroke-linecap="round" fill="none"/>
              </svg>
              Wiki Wanderer
            </div>
            
            <div class="wiki-tracker-controls">
              <!-- 開始 / 停止ボタン -->
              <button class="wiki-tracker-btn ${trackingActive ? 'active' : ''}" id="wiki-tracker-toggle-active" title="${trackingActive ? '記録を一時停止' : '記録を開始'}">
                <svg viewBox="0 0 24 24">
                  ${trackingActive ? 
                    `<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>` : 
                    `<polygon points="5 3 19 12 5 21 5 3"></polygon>`
                  }
                </svg>
              </button>
              <!-- リセットボタン -->
              <button class="wiki-tracker-btn" id="wiki-tracker-reset" title="経路をリセット">
                <svg viewBox="0 0 24 24">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
              <!-- 最小化ボタン -->
              <button class="wiki-tracker-btn" id="wiki-tracker-toggle-minimize" title="最小化">
                <svg viewBox="0 0 24 24">
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
            </div>
          </div>

          <!-- 下段: 統計情報 ＆ 更新モードスイッチ -->
          <div class="wiki-tracker-right-bottom">
            <div class="wiki-tracker-stats">
              <span>訪問: <strong>${totalSteps}</strong></span>
              <span>ユニーク: <strong>${uniqueCount}</strong></span>
            </div>
            <!-- 更新モードスイッチ -->
            <div class="wiki-tracker-switch-container" title="未辿路リンクの更新モード（記録停止中のみ変更可能）">
              <label class="wiki-tracker-switch">
                <input type="checkbox" id="wiki-tracker-mode-switch" ${updateMode === 'always' ? 'checked' : ''} ${trackingActive ? 'disabled' : ''}>
                <span class="wiki-tracker-switch-slider"></span>
              </label>
              <span class="wiki-tracker-switch-label">${updateMode === 'always' ? '随時更新' : '閉路更新'}</span>
            </div>
          </div>
        </div>
      </div>
      </div>
    `;

    // パンくずのスクロールを SVG グループに同期
    const area = document.getElementById('wiki-tracker-breadcrumbs-area');
    if (area) {
      area.addEventListener('scroll', () => {
        const group = document.getElementById('wiki-tracker-svg-group');
        if (group) {
          group.setAttribute('transform', `translate(-${area.scrollLeft}, 0)`);
        }
      });
    }

    // イベントリスナーの登録
    document.getElementById('wiki-tracker-toggle-active').addEventListener('click', toggleTracking);
    document.getElementById('wiki-tracker-reset').addEventListener('click', resetTracking);

    // スイッチのイベントリスナー
    const modeSwitch = document.getElementById('wiki-tracker-mode-switch');
    if (modeSwitch) {
      modeSwitch.addEventListener('change', (e) => {
        const mode = e.target.checked ? 'always' : 'on_cycle';
        updateMode = mode;

        const update = {};
        update[`updateMode_${tabId}`] = mode;
        chrome.storage.local.set(update, () => {
          const label = container.querySelector('.wiki-tracker-switch-label');
          if (label) {
            label.textContent = mode === 'always' ? '随時更新' : '閉路更新';
          }
        });
      });
    }


    document.getElementById('wiki-tracker-toggle-minimize').addEventListener('click', () => {
      widgetState.minimized = true;
      saveWidgetState();
      renderWidgetStructure();
    });

    // ドラッグ対応は廃止



    // パンくずリスト表示の実行
    if (trackingActive && currentPath.length > 0) {
      renderBreadcrumbs();
    } else {
      showEmptyMessageInBreadcrumbs();
    }

    // 動的な高さとグラデーションマスクの適用
    const shortcuts = getShortcutLinks();
    const hasShortcut = shortcuts.length > 0;

    if (hasShortcut && trackingActive) {
      const maxSpan = Math.max(...shortcuts.map(s => s.span), 0);
      const baseLineH = 6 + maxSpan * 8;
      const paddingForLine = 12; // 線の上面とフッター上端の隙間
      const requiredHeight = Math.max(96, 64 + baseLineH + paddingForLine);
      const maxHeightLimit = Math.floor(window.innerHeight * 0.6); // 画面の6割を上限とする
      const finalHeight = Math.min(maxHeightLimit, requiredHeight);

      container.style.height = `${finalHeight}px`;
      container.style.maxHeight = `${finalHeight}px`;

      const bgOverlay = container.querySelector('.wiki-tracker-bg-overlay');
      if (bgOverlay) {
        const startPercent = ((finalHeight - 64) / finalHeight) * 100;
        const maskVal = `linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.97) ${startPercent}%, black 100%)`;
        bgOverlay.style.webkitMaskImage = maskVal;
        bgOverlay.style.maskImage = maskVal;
      }
    } else {
      container.style.height = '';
      container.style.maxHeight = '';
      const bgOverlay = container.querySelector('.wiki-tracker-bg-overlay');
      if (bgOverlay) {
        bgOverlay.style.webkitMaskImage = '';
        bgOverlay.style.maskImage = '';
      }
    }
  }

  // パンくずリストの動的生成
  function renderBreadcrumbs() {
    const area = document.getElementById('wiki-tracker-breadcrumbs-area');
    if (!area) return;

    area.innerHTML = '';

    const breadcrumbsContainer = document.createElement('div');
    breadcrumbsContainer.className = 'wiki-tracker-breadcrumbs-container';

    // 閉路（ループ）に所属するノードキーの取得
    const { nodes: loopNodes, startIdx: loopStartIdx } = getActiveCycle(currentPath);

    // 現在地の判定
    const canonicalLink = document.querySelector('link[rel="canonical"]');
    const currentUrl = canonicalLink ? canonicalLink.href : window.location.href;
    const currentKey = getArticleKey(currentUrl);

    // detour判定のため、currentKeyがcurrentPathの中に存在するか最後のインデックスを検索
    const currIdx = currentPath.map(n => n.key).lastIndexOf(currentKey);
    const lastPathNode = currentPath[currentPath.length - 1];
    const isDetour = currentKey && lastPathNode && lastPathNode.key !== currentKey;

    // デトア中の場合、現在の表示インデックスはcurrIdx。そうでなければ末尾。
    const activeIndex = isDetour ? currIdx : currentPath.length - 1;



    const tagElements = []; // 各タグ要素の参照を格納する配列

    currentPath.forEach((node, i) => {
      // アイテムタグの作成
      const item = document.createElement('span');
      let className = 'wiki-breadcrumb-item';

      if (i === activeIndex) {
        className += ' current';
      } else if (i > activeIndex) {
        className += ' future';
      }

      if (loopStartIdx !== -1 && i >= loopStartIdx) {
        className += ' in-loop';
      }

      item.className = className;
      item.setAttribute('data-key', node.key);

      // タイトルが長い場合は短縮
      let dispTitle = node.title;
      if (dispTitle.length > 15) {
        dispTitle = dispTitle.substring(0, 13) + '...';
      }
      item.textContent = dispTitle;
      item.title = node.title;

      // クリックイベントの登録 (Teleport機能)
      if (i !== activeIndex) {
        item.addEventListener('click', () => {
          const update = {};
          update[`teleportTarget_${tabId}`] = node.key;
          update[`lastClick_${tabId}`] = null;
          chrome.storage.local.set(update, () => {
            window.location.href = node.url;
          });
        });
      }

      // ホバー連携
      item.addEventListener('mouseenter', () => handleBreadcrumbHover(node.key, true));
      item.addEventListener('mouseleave', () => handleBreadcrumbHover(node.key, false));

      breadcrumbsContainer.appendChild(item);
      tagElements.push(item); // 座標取得用に保存

      // セパレーター矢印の追加 (最後の要素以外)
      if (i < currentPath.length - 1) {
        const separator = document.createElement('span');
        separator.className = 'wiki-breadcrumb-separator';
        separator.textContent = '→';
        breadcrumbsContainer.appendChild(separator);
      }
    });

    area.appendChild(breadcrumbsContainer);

    // ショートカットパスの検出とSVG描画
    const shortcuts = getShortcutLinks();
    const svgGroup = document.getElementById('wiki-tracker-svg-group');
    if (shortcuts.length > 0 && trackingActive && svgGroup) {
      // 少し待ってからDOM座標を取得して描画（レイアウト確定後）
      requestAnimationFrame(() => {
        drawShortcutArches(svgGroup, tagElements, shortcuts);
      });
    } else if (svgGroup) {
      svgGroup.innerHTML = '';
    }

    // パンくずが長い場合に自動で右端（最新の訪問ページ）にスクロール
    requestAnimationFrame(() => {
      area.scrollLeft = area.scrollWidth;
    });
  }

  // 空の状態時の案内メッセージ
  function showEmptyMessageInBreadcrumbs() {
    const area = document.getElementById('wiki-tracker-breadcrumbs-area');
    if (!area) return;

    area.innerHTML = `
      <div style="color: #72777d; font-size: 11.5px; padding: 24px; text-align: center; width: 100%; line-height: 1.6;">
        ${trackingActive ?
        '記事を読み込んで探索経路を表示します<br><span style="font-size: 10.5px; color:#a2a9b1;">リンクを辿って探索を開始してください</span>' :
        'トラッキングは停止中です<br><span style="font-size: 10.5px; color:#a2a9b1;">開始ボタンを押して記録を始めてください</span>'
      }
      </div>
    `;
  }

  function saveWidgetState() {
    const update = {};
    update[`widget_${tabId}`] = widgetState;
    chrome.storage.local.set(update);
  }


  // トラッキングのアクティブ/非アクティブ切り替え
  function toggleTracking() {
    trackingActive = !trackingActive;
    if (trackingActive) {
      const update = { trackingActive };
      update[`shortcuts_${tabId}`] = [];

      chrome.storage.local.set(update, () => {
        // 現在のページからパスを新規作成
        const currentUrl = window.location.href;
        const currentKey = getArticleKey(currentUrl);
        if (currentKey) {
          const currentTitle = document.getElementById('firstHeading')?.textContent.trim() || document.title.replace(' - Wikipedia', '').trim();
          const pageLinks = extractPageLinks();
          currentPath = [{ key: currentKey, title: currentTitle, url: currentUrl, links: pageLinks }];

          const updatePath = {};
          updatePath[`path_${tabId}`] = currentPath;
          chrome.storage.local.set(updatePath, () => {
            // 変数をローカル同期
            savedShortcuts = [];
            renderWidgetStructure();
            scanAndInjectBadges();
          });
        } else {
          savedShortcuts = [];
          renderWidgetStructure();
        }
      });
    } else {
      chrome.storage.local.set({ trackingActive }, () => {
        // 非アクティブ化時はバッジを消す
        removeBadges();
        renderWidgetStructure();
      });
    }
  }

  // パスのリセット
  function resetTracking() {
    if (confirm("記録された探索経路をリセットしますか？")) {
      currentPath = [];
      savedShortcuts = [];

      const update = {};
      update[`path_${tabId}`] = [];
      update[`shortcuts_${tabId}`] = [];

      chrome.storage.local.set(update, () => {
        removeBadges();
        // 現在ページを初期ノードとして再設定
        const currentUrl = window.location.href;
        const currentKey = getArticleKey(currentUrl);
        if (currentKey && trackingActive) {
          const currentTitle = document.getElementById('firstHeading')?.textContent.trim() || document.title.replace(' - Wikipedia', '').trim();
          const pageLinks = extractPageLinks();
          currentPath = [{ key: currentKey, title: currentTitle, url: currentUrl, links: pageLinks }];

          const update2 = {};
          update2[`path_${tabId}`] = currentPath;
          chrome.storage.local.set(update2, () => {
            renderWidgetStructure();
            scanAndInjectBadges();
          });
        } else {
          renderWidgetStructure();
        }
      });
    }
  }

  // -------------------------------------------------------------
  // ホバーハイライト制御
  // -------------------------------------------------------------

  // パンくずホバー時に本文のリンクとパンくず自体をハイライト
  function handleBreadcrumbHover(key, isHover) {
    // 1. 本文内のリンクをハイライト
    const articleLinks = document.querySelectorAll(`#bodyContent a[href*="/wiki/"]`);
    articleLinks.forEach(link => {
      if (getArticleKey(link.href) === key) {
        if (isHover) {
          link.classList.add('wiki-loop-link-highlight');
        } else {
          link.classList.remove('wiki-loop-link-highlight');
        }
      }
    });

    // 2. パンくず自体のハイライト
    highlightBreadcrumbs(key, isHover);
  }

  // パンくずの特定ノードタグをハイライトする
  function highlightBreadcrumbs(key, isHover) {
    const items = document.querySelectorAll(`.wiki-breadcrumb-item[data-key="${key}"]`);
    items.forEach(item => {
      if (isHover) {
        item.classList.add('highlighted');
      } else {
        item.classList.remove('highlighted');
      }
    });
  }

  // -------------------------------------------------------------
  // 閉路（ループ）解析ユーティリティ
  // -------------------------------------------------------------
  function getActiveCycle(path) {
    if (path.length < 2) return { nodes: new Set(), edges: new Set(), startIdx: -1 };

    const lastNode = path[path.length - 1];
    const lastKey = lastNode.key;

    // 現在のページの過去の出現位置を検索（末尾以外）
    const prevIdx = path.findIndex((n, idx) => n.key === lastKey && idx < path.length - 1);
    if (prevIdx === -1) {
      return { nodes: new Set(), edges: new Set(), startIdx: -1 };
    }

    const cycleNodes = new Set();
    const cycleEdges = new Set();

    // 閉路を構成するノードの格納
    for (let i = prevIdx; i < path.length; i++) {
      cycleNodes.add(path[i].key);
    }

    // 閉路を構成するエッジの格納 (key1->key2 の文字列形式)
    for (let i = prevIdx; i < path.length - 1; i++) {
      const src = path[i].key;
      const tgt = path[i + 1].key;
      cycleEdges.add(`${src}->${tgt}`);
    }

    return { nodes: cycleNodes, edges: cycleEdges, startIdx: prevIdx };
  }

  // 履歴全体のショートカット経路を検出する (保存されたショートカットを返すラッパー)
  function getShortcutLinks() {
    return savedShortcuts || [];
  }

  // パス長に応じて、パス範囲外に外れたショートカットをフィルタリングする
  function filterShortcutsForPathLength(shortcuts, pathLength) {
    if (!shortcuts) return [];
    return shortcuts.filter(s => s.fromIdx < pathLength && s.toIdx < pathLength);
  }

  // 指定されたインデックス範囲内にある記事間のショートカット（未辿路リンク）を抽出する
  function getShortcutLinksForRange(startIdx, endIdx) {
    const shortcuts = [];
    const len = currentPath.length;
    if (len < 3 || startIdx < 0 || endIdx >= len || startIdx >= endIdx) return shortcuts;

    // 1. 指定された範囲内におけるすべての記事キーのペアとそのインデックスの組み合わせについてスパン候補を集める
    // pairCandidates: { "keyA:keyB": [{ i, j, span }] }
    const pairCandidates = {};

    for (let i = startIdx; i <= endIdx; i++) {
      const keyI = currentPath[i].key;
      for (let j = i + 1; j <= endIdx; j++) {
        const keyJ = currentPath[j].key;
        if (keyI === keyJ) continue; // 同一記事同士のペアは除外

        const pairKey = [keyI, keyJ].sort().join(':');
        const span = j - i - 1;

        if (!pairCandidates[pairKey]) {
          pairCandidates[pairKey] = [];
        }
        pairCandidates[pairKey].push({ i, j, span });
      }
    }

    // 2. 各ペアについて、最小スパンを持つ組み合わせのみを代表として選定
    for (const pairKey in pairCandidates) {
      const candidates = pairCandidates[pairKey];

      // スパンの昇順でソート
      candidates.sort((a, b) => a.span - b.span);

      const best = candidates[0]; // 最小スパンの組み合わせ

      // 最小スパンが 0 の場合、そのペアのショートカットは表示しない
      if (best.span === 0) continue;

      // 3. リンクの存在チェックと方向の判定
      const nodeI = currentPath[best.i];
      const nodeJ = currentPath[best.j];

      // nodeIからnodeJへのリンクがあるか
      const hasLinkIToJ = nodeI.links && nodeI.links.some(link => {
        const resolved = redirectCache[link] || link;
        return resolved === nodeJ.key;
      });

      // nodeJからnodeIへのリンクがあるか
      const hasLinkJToI = nodeJ.links && nodeJ.links.some(link => {
        const resolved = redirectCache[link] || link;
        return resolved === nodeI.key;
      });

      // いずれの方向にもリンクがない場合はショートカットではない
      if (!hasLinkIToJ && !hasLinkJToI) continue;

      const isBidirectional = hasLinkIToJ && hasLinkJToI;

      // パスの向き（fromIdx -> toIdx）を設定する。
      let fromIdx = best.i;
      let toIdx = best.j;

      if (!isBidirectional) {
        if (hasLinkJToI) {
          fromIdx = best.j;
          toIdx = best.i;
        }
      }

      shortcuts.push({
        fromIdx,
        toIdx,
        span: best.span,
        isBidirectional
      });
    }

    return shortcuts;
  }

  // ショートカットリンクを検出し、コの字型の直角折れ線をSVGで描画する（重なり防止のX/Y座標オフセット付き、かつ方向を示す矢印付き）
  function drawShortcutArches(svgGroup, tags, shortcuts) {
    svgGroup.innerHTML = '';
    const svg = document.getElementById('wiki-tracker-svg-overlay');
    const area = document.getElementById('wiki-tracker-breadcrumbs-area');
    if (!svg || !area) return;

    const svgRect = svg.getBoundingClientRect();
    const len = currentPath.length;
    if (len === 0 || tags.length !== len) return;

    // 各ノード（タグ）ごとに、接続されているショートカット情報を集める
    const nodeConnections = Array.from({ length: len }, () => []);

    shortcuts.forEach((s, sIdx) => {
      const { fromIdx, toIdx, span } = s;

      // fromIdxノードにとっての接続情報（toIdx方向）
      nodeConnections[fromIdx].push({
        shortcutIdx: sIdx,
        direction: toIdx > fromIdx ? 1 : -1,
        span: span
      });

      // toIdxノードにとっての接続情報（fromIdx方向）
      nodeConnections[toIdx].push({
        shortcutIdx: sIdx,
        direction: fromIdx > toIdx ? 1 : -1,
        span: span
      });
    });

    const offsetMap = {};
    const totalMap = {};

    for (let i = 0; i < len; i++) {
      const conns = nodeConnections[i];
      const total = conns.length;
      totalMap[i] = total;

      conns.sort((a, b) => {
        const scoreA = a.direction * (1000 - a.span);
        const scoreB = b.direction * (1000 - b.span);
        return scoreA - scoreB;
      });

      conns.forEach((conn, k) => {
        offsetMap[`${conn.shortcutIdx}-${i}`] = k;
      });
    }

    // 描画処理へ進む
    shortcuts.forEach((s, sIdx) => {
      const { fromIdx, toIdx, span } = s;
      const fromEl = tags[fromIdx];
      const toEl = tags[toIdx];
      if (!fromEl || !toEl) return;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();

      // 垂直線のずれ幅（ピクセル）
      const stepWidth = 4;

      // 始点のX/Y座標計算（現在のスクロール位置とズレを補正した絶対座標）
      const tot1 = totalMap[fromIdx];
      const cur1 = offsetMap[`${sIdx}-${fromIdx}`];
      const offset1 = (cur1 - (tot1 - 1) / 2) * stepWidth;
      const x1 = (fromRect.left - svgRect.left) + fromEl.offsetWidth / 2 + offset1 + area.scrollLeft;
      const y1 = (fromRect.top - svgRect.top) - 2;

      // 終点のX/Y座標計算
      const tot2 = totalMap[toIdx];
      const cur2 = offsetMap[`${sIdx}-${toIdx}`];
      const offset2 = (cur2 - (tot2 - 1) / 2) * stepWidth;
      const x2 = (toRect.left - svgRect.left) + toEl.offsetWidth / 2 + offset2 + area.scrollLeft;
      const y2 = (toRect.top - svgRect.top) - 2;

      // またぐ記事の数 span のみに応じて高さを決める（制限なし）
      const baseH = 6 + span * 8;
      const h = baseH;
      const cy = Math.min(y1, y2) - h;

      // コの字型（直角折れ線）のパスを生成
      const d = `M ${x1} ${y1} L ${x1} ${cy} L ${x2} ${cy} L ${x2} ${y2}`;

      // 1. 透明なホバー検知用の太い線（非表示/透明）
      const hoverPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hoverPath.setAttribute('d', d);
      hoverPath.setAttribute('fill', 'none');
      hoverPath.setAttribute('stroke', 'transparent');
      hoverPath.setAttribute('stroke-width', '8'); // 8px幅のホバー判定エリア
      hoverPath.setAttribute('stroke-linejoin', 'round');
      hoverPath.setAttribute('stroke-linecap', 'round');
      hoverPath.style.cursor = 'pointer';
      hoverPath.style.pointerEvents = 'stroke'; // ストローク部分のみマウスイベントを検知

      // 2. 本物の描画用の細い線
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute('d', d);
      path.setAttribute('class', 'wiki-loop-shortcut-line');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('marker-end', 'url(#wiki-arrow-marker)'); // 矢印マーカーを付与
      if (s.isBidirectional) {
        path.setAttribute('marker-start', 'url(#wiki-arrow-marker)'); // 相互リンクなら始点にも矢印を付与
      }

      const fromTitle = currentPath[fromIdx].title;
      const toTitle = currentPath[toIdx].title;
      path.innerHTML = `<title>未辿路リンク: ${fromTitle} ➔ ${toTitle} (またぐ記事数: ${span})</title>`;
      hoverPath.innerHTML = `<title>未辿路リンク: ${fromTitle} ➔ ${toTitle} (またぐ記事数: ${span})</title>`;

      // ホバー検知用太線（hoverPath）にホバーイベントを登録する
      const fromKey = currentPath[fromIdx].key;
      const toKey = currentPath[toIdx].key;

      hoverPath.addEventListener('mouseenter', () => {
        path.classList.add('hovered');
        handleBreadcrumbHover(fromKey, true);
        handleBreadcrumbHover(toKey, true);
      });

      hoverPath.addEventListener('mouseleave', () => {
        path.classList.remove('hovered');
        handleBreadcrumbHover(fromKey, false);
        handleBreadcrumbHover(toKey, false);
      });

      // svgGroupへ追加
      svgGroup.appendChild(path);
      svgGroup.appendChild(hoverPath);
    });

    // 初期スクロール位置の同期
    svgGroup.setAttribute('transform', `translate(-${area.scrollLeft}, 0)`);
  }

  // -------------------------------------------------------------
  // 本文内リンクのクリックインターセプト
  // -------------------------------------------------------------
  document.addEventListener('click', (e) => {
    if (!trackingActive) return;

    // クリックされたのがaタグ、またはaタグの中の要素か
    const link = e.target.closest('a');
    if (link && link.href) {
      const rawKey = getArticleKey(link.href);
      if (rawKey) {
        // リダイレクトキャッシュから正規のキーを取得（なければそのまま）
        const key = redirectCache[rawKey] || rawKey;

        // 有効な記事リンククリックを検知
        const title = link.textContent.trim().replace(/\s*\d+\s*$/, '') || key; // 末尾のバッジの数値を削る
        const url = link.href;

        // 次ページで遷移判定するために一時保存
        const clickData = {
          key,
          title,
          url,
          sourceUrl: window.location.href,
          timestamp: Date.now()
        };

        // デトア（本筋から外れた状態）からの新規リンククリックの場合、事前にパスをその位置まで巻き戻す
        const currentUrl = window.location.href;
        const currentKey = getArticleKey(currentUrl);
        const lastPathNode = currentPath[currentPath.length - 1];
        const isDetour = currentKey && lastPathNode && lastPathNode.key !== currentKey;

        const update = {};
        if (isDetour) {
          const currIdx = currentPath.map(n => n.key).lastIndexOf(currentKey);
          if (currIdx !== -1) {
            const truncatedPath = currentPath.slice(0, currIdx + 1);
            update[`path_${tabId}`] = truncatedPath;
            currentPath = truncatedPath; // メモリ内も同期
          }
        }

        update[`lastClick_${tabId}`] = clickData;
        chrome.storage.local.set(update);
      }
    }
  });

  // -------------------------------------------------------------
  // ストレージ変更のリアルタイム監視 (Popupなど別スクリプトからのトグルに対応)
  // -------------------------------------------------------------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    let stateChanged = false;
    let becameActive = false;

    // グローバルのトラッキング状態変更
    if (changes.trackingActive) {
      trackingActive = changes.trackingActive.newValue;
      stateChanged = true;
      if (trackingActive) {
        becameActive = true;
      }
    }

    // 表示モードの変更
    const modeKey = `updateMode_${tabId}`;
    if (changes[modeKey]) {
      updateMode = changes[modeKey].newValue || 'always';
      stateChanged = true;
    }

    // ショートカットリストの変更
    const shortcutsKey = `shortcuts_${tabId}`;
    if (changes[shortcutsKey]) {
      savedShortcuts = changes[shortcutsKey].newValue || [];
      stateChanged = true;
    }

    // このタブに関連するパス変更
    const pathKey = `path_${tabId}`;
    if (changes[pathKey]) {
      currentPath = changes[pathKey].newValue || [];
      stateChanged = true;
    }

    // リダイレクトキャッシュの更新
    if (changes.redirectCache) {
      redirectCache = changes.redirectCache.newValue || {};
      stateChanged = true;
    }

    if (stateChanged) {
      // ポップアップなどでトラッキングが有効化され、現在のパスが空の場合は初期化する
      if (becameActive) {
        // もし updateMode がまだ指定されていない場合はダイアログで確認
        chrome.storage.local.get([modeKey], (res) => {
          if (!res[modeKey]) {
            const useAlways = confirm("遷移毎に未辿路リンクを随時更新しますか？\n\n[OK]：随時更新モード (常に最新のショートカットを探索)\n[キャンセル]：閉路完成時更新モード (ループ発生時のみ追加)");
            const mode = useAlways ? 'always' : 'on_cycle';

            const initUpdate = {};
            initUpdate[modeKey] = mode;
            initUpdate[shortcutsKey] = [];

            if (currentPath.length === 0) {
              const canonicalLink = document.querySelector('link[rel="canonical"]');
              const currentUrl = canonicalLink ? canonicalLink.href : window.location.href;
              const currentKey = getArticleKey(currentUrl);
              if (currentKey) {
                const currentTitle = document.getElementById('firstHeading')?.textContent.trim() || document.title.replace(' - Wikipedia', '').trim();
                const pageLinks = extractPageLinks();
                currentPath = [{ key: currentKey, title: currentTitle, url: currentUrl, links: pageLinks }];
                initUpdate[pathKey] = currentPath;
              }
            }

            chrome.storage.local.set(initUpdate);
          } else {
            // すでに mode が設定されていてパスが空の場合
            if (currentPath.length === 0) {
              const canonicalLink = document.querySelector('link[rel="canonical"]');
              const currentUrl = canonicalLink ? canonicalLink.href : window.location.href;
              const currentKey = getArticleKey(currentUrl);
              if (currentKey) {
                const currentTitle = document.getElementById('firstHeading')?.textContent.trim() || document.title.replace(' - Wikipedia', '').trim();
                const pageLinks = extractPageLinks();
                currentPath = [{ key: currentKey, title: currentTitle, url: currentUrl, links: pageLinks }];

                const initUpdate = {};
                initUpdate[pathKey] = currentPath;
                chrome.storage.local.set(initUpdate);
              }
            }
          }
        });
      }

      renderWidgetStructure();
      if (trackingActive) {
        scanAndInjectBadges();
      } else {
        removeBadges();
      }
    }
  });

  // 実行開始
  init();
})();
