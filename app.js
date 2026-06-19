// Controller logic for AERO Requirement Wrangler
// Exposed globally via window.ReqApp to allow running via file:// without CORS issues.

(function() {
  // App state loaded from localStorage
  let state = window.ReqData.loadState();
  let currentView = 'dashboard';
  let reqViewMode = localStorage.getItem('req_view_mode') || 'list'; // 'grid' or 'list'
  let selectedProgramId = state.programs.length > 0 ? state.programs[0].id : null;
  let selectedProgramTab = 'overview';

  // Traceability page states
  let traceabilityData = { caps: [], reqs: [], tests: [] };
  let currentHoveredTraceNode = null;

  // Shared database sync states
  let sharedFileHandle = null;
  let isSyncing = false;
  let lastSharedFileModifiedTime = 0;
  let autoPollInterval = null;
  let offlineRetryTimeout = null;
  let isOffline = false;
  let pushPending = false;

  // --- IndexedDB Database Config ---
  const DB_NAME = 'ReqWranglerSyncDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'file_handles';
  const KEY_NAME = 'shared_handle';

  function getIndexedDBStore() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = (e) => reject(e);
      request.onsuccess = (e) => resolve(e.target.result);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
    });
  }

  function getStoredFileHandle() {
    return getIndexedDBStore().then(db => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(KEY_NAME);
        request.onsuccess = (e) => resolve(e.target.result || null);
        request.onerror = (e) => reject(e);
      });
    });
  }

  function storeFileHandle(handle) {
    return getIndexedDBStore().then(db => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(handle, KEY_NAME);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e);
      });
    });
  }

  function removeStoredFileHandle() {
    return getIndexedDBStore().then(db => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(KEY_NAME);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e);
      });
    });
  }

  // --- Deletion Tracking & Pruning ---
  function trackDeletion(id) {
    if (!state.deletedIds) {
      state.deletedIds = [];
    }
    const existing = state.deletedIds.find(x => typeof x === 'object' && x.id === id);
    if (existing) {
      existing.deletedAt = Date.now();
    } else {
      state.deletedIds.push({ id, deletedAt: Date.now() });
    }
  }

  function untrackDeletion(id) {
    if (state.deletedIds) {
      state.deletedIds = state.deletedIds.filter(x => {
        const itemId = typeof x === 'object' ? x.id : x;
        return itemId !== id;
      });
    }
  }

  function pruneTombstones() {
    if (!state.deletedIds) return;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    state.deletedIds = state.deletedIds.filter(x => {
      if (typeof x === 'object' && x.deletedAt) {
        return x.deletedAt > thirtyDaysAgo;
      }
      return true; // Keep legacy strings
    });
  }

  // --- Activity Logging ---
  function logActivity(actionText) {
    if (!state.activityLog) {
      state.activityLog = [];
    }
    state.activityLog.unshift({
      timestamp: new Date().toISOString(),
      action: actionText
    });
    state.activityLog = state.activityLog.slice(0, 100);
  }

  function formatRelativeTime(isoString) {
    const date = new Date(isoString);
    const diffMs = Date.now() - date.getTime();
    if (diffMs < 60000) return 'Just now';
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderActivityLog() {
    const list = document.getElementById('dashboard-activity-log-list');
    if (!list) return;

    if (!state.activityLog || state.activityLog.length === 0) {
      list.innerHTML = `<div style="color:var(--text-secondary); text-align:center; padding: 20px 0;">No recent activity</div>`;
      return;
    }

    list.innerHTML = state.activityLog.map(log => {
      const timeStr = formatRelativeTime(log.timestamp);
      return `
        <div class="activity-item">
          <div class="activity-header">
            <span class="activity-time">${timeStr}</span>
          </div>
          <div class="activity-action">${escapeHTML(log.action)}</div>
        </div>
      `;
    }).join('');
  }

  // --- Merge Logic ---
  function mergeStates(local, remote) {
    if (!remote) return local;

    // Normalize and merge deletedIds tombstones
    const localDeleted = (local.deletedIds || []).map(x => typeof x === 'string' ? { id: x, deletedAt: Date.now() } : x);
    const remoteDeleted = (remote.deletedIds || []).map(x => typeof x === 'string' ? { id: x, deletedAt: Date.now() } : x);

    const mergedTombstonesMap = new Map();
    for (const x of [...localDeleted, ...remoteDeleted]) {
      const existing = mergedTombstonesMap.get(x.id);
      if (!existing || x.deletedAt > existing.deletedAt) {
        mergedTombstonesMap.set(x.id, x);
      }
    }
    const mergedDeletedTombstones = Array.from(mergedTombstonesMap.values());
    const activeDeletedIds = mergedDeletedTombstones.map(x => x.id);

    function mergeObjectLists(localList, remoteList) {
      const cleanLocal = (localList || []).filter(item => !activeDeletedIds.includes(item.id));
      const cleanRemote = (remoteList || []).filter(item => !activeDeletedIds.includes(item.id));

      const remoteMap = new Map(cleanRemote.map(item => [item.id, item]));
      const localMap = new Map(cleanLocal.map(item => [item.id, item]));
      const mergedList = [];

      for (const localItem of cleanLocal) {
        const remoteItem = remoteMap.get(localItem.id);
        if (remoteItem) {
          mergedList.push(Object.assign({}, remoteItem, localItem));
        } else {
          mergedList.push(localItem);
        }
      }

      for (const remoteItem of cleanRemote) {
        if (!localMap.has(remoteItem.id)) {
          mergedList.push(remoteItem);
        }
      }

      return mergedList;
    }

    function mergeStringArrays(localArr, remoteArr) {
      const cleanLocal = (localArr || []).filter(item => !activeDeletedIds.includes(item));
      const cleanRemote = (remoteArr || []).filter(item => !activeDeletedIds.includes(item));
      const set = new Set([...cleanRemote, ...cleanLocal]);
      return Array.from(set);
    }

    // Merge activityLog (deduplicate by timestamp + action text, sort by timestamp desc, limit to 100)
    const combinedLog = [...(local.activityLog || []), ...(remote.activityLog || [])];
    const logMap = new Map();
    for (const log of combinedLog) {
      const key = `${log.timestamp}_${log.action}`;
      logMap.set(key, log);
    }
    const mergedActivityLog = Array.from(logMap.values())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 100);

    const merged = {};
    merged.programs = mergeObjectLists(local.programs, remote.programs);
    merged.requirements = mergeObjectLists(local.requirements, remote.requirements);
    merged.capabilities = mergeObjectLists(local.capabilities, remote.capabilities);
    merged.tests = mergeObjectLists(local.tests, remote.tests);
    merged.teamMembers = mergeObjectLists(local.teamMembers, remote.teamMembers);
    merged.testTypes = mergeStringArrays(local.testTypes, remote.testTypes);
    merged.componentCodes = mergeStringArrays(local.componentCodes, remote.componentCodes);
    merged.deletedIds = mergedDeletedTombstones;
    merged.activityLog = mergedActivityLog;

    return merged;
  }

  // --- Shared Database Sync Functions ---
  function startAutoPolling() {
    stopAutoPolling();
    autoPollInterval = setInterval(async () => {
      if (!sharedFileHandle || isSyncing || isOffline) return;
      try {
        const file = await sharedFileHandle.getFile();
        if (file.lastModified !== lastSharedFileModifiedTime) {
          console.log("Shared file modified remotely, pulling updates...");
          await pullSharedDatabase();
        }
      } catch (err) {
        console.warn("Auto-polling file check failed:", err);
      }
    }, 15000);
  }

  function stopAutoPolling() {
    if (autoPollInterval) {
      clearInterval(autoPollInterval);
      autoPollInterval = null;
    }
  }

  function handleOfflineState() {
    isOffline = true;
    updateSyncStatus('error', 'Sync Error (Offline - Changes queued)');
    
    if (offlineRetryTimeout) clearTimeout(offlineRetryTimeout);
    offlineRetryTimeout = setTimeout(async () => {
      console.log("Retrying database push...");
      try {
        const success = await pushSharedDatabase();
        if (success) {
          console.log("Database push succeeded, offline state cleared.");
          isOffline = false;
          if (offlineRetryTimeout) {
            clearTimeout(offlineRetryTimeout);
            offlineRetryTimeout = null;
          }
        } else {
          console.log("Database push queued or skipped, waiting for queued push to run.");
        }
      } catch (e) {
        console.warn("Retry failed, still offline:", e);
        handleOfflineState();
      }
    }, 10000);
  }

  async function initSharedDatabase() {
    try {
      const handle = await getStoredFileHandle();
      if (handle) {
        sharedFileHandle = handle;
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          updateSyncStatus('connected', `Connected: ${handle.name}`);
          const file = await handle.getFile();
          lastSharedFileModifiedTime = file.lastModified;
          await pullSharedDatabase();
          startAutoPolling();
        } else {
          updateSyncStatus('disconnected', 'Authorization Required');
          openModal('reconnect-modal');
        }
      } else {
        if (localStorage.getItem('db_setup_prompt_shown') !== 'true') {
          openModal('db-setup-prompt-modal');
        }
      }
    } catch (err) {
      console.error("Failed to initialize shared database sync:", err);
      updateSyncStatus('error', 'Sync Init Error');
    }
  }

  async function connectSharedDatabaseFromPrompt() {
    closeModal('db-setup-prompt-modal');
    localStorage.setItem('db_setup_prompt_shown', 'true');
    await connectSharedDatabase();
  }

  function skipDbSetupPrompt() {
    closeModal('db-setup-prompt-modal');
    localStorage.setItem('db_setup_prompt_shown', 'true');
  }

  async function connectSharedDatabase() {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'JSON Database File',
          accept: { 'application/json': ['.json'] }
        }],
        excludeAcceptAllOption: true,
        multiple: false
      });

      if (!handle) return;

      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        alert("Read/Write permission is required to synchronize with the shared database.");
        return;
      }

      sharedFileHandle = handle;
      await storeFileHandle(handle);
      
      const file = await handle.getFile();
      lastSharedFileModifiedTime = file.lastModified;

      updateSyncStatus('syncing', 'Connecting...');
      await pullSharedDatabase();
      startAutoPolling();

      closeModal('settings-modal');
      alert(`Successfully connected to shared database: ${handle.name}`);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error("Error connecting to shared database:", err);
        alert(`Failed to connect to shared database: ${err.message}`);
        updateSyncStatus('error', 'Connection Failed');
      }
    }
  }

  async function reconnectSharedDatabase() {
    if (!sharedFileHandle) {
      try {
        sharedFileHandle = await getStoredFileHandle();
      } catch (e) {
        console.error(e);
      }
    }

    if (!sharedFileHandle) {
      alert("No shared database file handle found. Please connect via settings.");
      closeModal('reconnect-modal');
      return;
    }

    try {
      const perm = await sharedFileHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        updateSyncStatus('connected', `Connected: ${sharedFileHandle.name}`);
        closeModal('reconnect-modal');
        const file = await sharedFileHandle.getFile();
        lastSharedFileModifiedTime = file.lastModified;
        await pullSharedDatabase();
        startAutoPolling();
      } else {
        alert("Permission denied. Could not reconnect.");
      }
    } catch (err) {
      console.error("Error reconnecting to shared database:", err);
      alert(`Failed to reconnect: ${err.message}`);
      updateSyncStatus('error', 'Reconnection Failed');
    }
  }

  async function disconnectSharedDatabase() {
    if (confirm("Disconnect from the shared database? You will revert to using browser local storage.")) {
      try {
        sharedFileHandle = null;
        stopAutoPolling();
        if (offlineRetryTimeout) {
          clearTimeout(offlineRetryTimeout);
          offlineRetryTimeout = null;
        }
        isOffline = false;
        await removeStoredFileHandle();
        closeModal('reconnect-modal');
        updateSyncStatus('disconnected', 'Disconnected');
      } catch (err) {
        console.error("Error disconnecting shared database:", err);
      }
    }
  }

  async function syncWithSharedFile(isSavingMode) {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        // 1. Get the file handle and read the metadata (lastModified)
        const file = await sharedFileHandle.getFile();
        const readModifiedTime = file.lastModified;

        // 2. Read file text
        const text = await file.text();
        let remoteState = null;
        if (text.trim()) {
          try {
            remoteState = JSON.parse(text);
          } catch (e) {
            console.warn("Shared file is not valid JSON:", e);
          }
        }

        // 3. Keep a copy of the state before merge to see if it changed
        const stateBeforeMergeString = JSON.stringify(state);

        // 4. Merge remote state into local state
        pruneTombstones();
        if (remoteState) {
          state = mergeStates(state, remoteState);
        }
        // Save the merged state to local storage
        state = window.ReqData.saveState(state);

        const stateAfterMergeString = JSON.stringify(state);
        const stateModified = (stateBeforeMergeString !== stateAfterMergeString);

        // 5. Optimistic Concurrency Check (Double-Check before writing)
        const freshFile = await sharedFileHandle.getFile();
        if (freshFile.lastModified !== readModifiedTime) {
          console.log(`OCC conflict detected (file modified since read: ${freshFile.lastModified} !== ${readModifiedTime}). Retrying...`);
          if (attempts < maxAttempts) {
            const delay = Math.random() * 1500 + 500; // 500ms to 2000ms delay
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          } else {
            throw new Error("Concurrency conflict: file modified by another user during sync and max retries reached.");
          }
        }

        // 6. Write the merged state (this locks the file)
        const writable = await sharedFileHandle.createWritable();
        await writable.write(JSON.stringify(state, null, 2));
        await writable.close();

        // 7. Success! Save the final modified time
        const finalFile = await sharedFileHandle.getFile();
        lastSharedFileModifiedTime = finalFile.lastModified;
        isOffline = false;
        updateSyncStatus('connected', `Connected: ${sharedFileHandle.name}`);

        // On pull (isSavingMode = false), always render.
        // On push (isSavingMode = true), only render if state actually changed during merge.
        if (!isSavingMode || stateModified) {
          render();
        }

        return; // Success, exit retry loop
      } catch (err) {
        console.warn(`Sync attempt ${attempts} failed:`, err);

        // Check for permission errors - propagate immediately
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
          updateSyncStatus('disconnected', 'Authorization Required');
          stopAutoPolling();
          openModal('reconnect-modal');
          throw err;
        }

        if (attempts >= maxAttempts) {
          handleOfflineState();
          throw err;
        }

        const delay = Math.random() * 1500 + 500;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async function pullSharedDatabase() {
    if (!sharedFileHandle) return false;
    if (isSyncing) {
      throw new Error("Sync already in progress");
    }

    isSyncing = true;
    updateSyncStatus('syncing', 'Syncing...');

    try {
      await syncWithSharedFile(false);
      return true;
    } catch (err) {
      console.error("Error pulling from shared database:", err);
      throw err;
    } finally {
      isSyncing = false;
      if (pushPending) {
        pushPending = false;
        setTimeout(() => {
          pushSharedDatabase().catch(err => {
            console.error("Queued push failed:", err);
          });
        }, 100);
      }
    }
  }

  async function pushSharedDatabase() {
    if (!sharedFileHandle) return false;
    if (isSyncing) {
      pushPending = true;
      console.log("Sync in progress, queueing next push.");
      return false;
    }

    isSyncing = true;
    updateSyncStatus('syncing', 'Saving...');

    try {
      await syncWithSharedFile(true);
      return true;
    } catch (err) {
      console.error("Error pushing to shared database:", err);
      throw err;
    } finally {
      isSyncing = false;
      if (pushPending) {
        pushPending = false;
        setTimeout(() => {
          pushSharedDatabase().catch(err => {
            console.error("Queued push failed:", err);
          });
        }, 100);
      }
    }
  }

  function updateSyncStatus(status, text) {
    const dot = document.getElementById('sync-status-dot');
    const textEl = document.getElementById('sync-status-text');
    if (textEl) textEl.textContent = text;
    if (dot) {
      dot.style.backgroundColor = 'var(--text-secondary)';
      if (status === 'connected') {
        dot.style.backgroundColor = 'var(--status-passed)';
      } else if (status === 'syncing') {
        dot.style.backgroundColor = 'var(--status-pending)';
      } else if (status === 'error') {
        dot.style.backgroundColor = 'var(--status-failed)';
      }
    }
    renderSettingsModalSharedSection();
  }

  function renderSettingsModalSharedSection() {
    const section = document.getElementById('settings-shared-db-section');
    if (!section) return;

    if (sharedFileHandle) {
      section.innerHTML = `
        <div style="background: var(--bg-canvas); border: 1px solid var(--border-color); padding: 12px; border-radius: 6px; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span style="font-size: 13px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px;" title="${sharedFileHandle.name}">
              📄 ${sharedFileHandle.name}
            </span>
            <span style="font-size: 11px; color: var(--status-passed); font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">
              <span style="width: 6px; height: 6px; border-radius: 50%; background-color: var(--status-passed); display: inline-block;"></span>
              Connected
            </span>
          </div>
          <div style="display: flex; gap: 8px; margin-top: 4px;">
            <button class="btn btn-secondary btn-sm" id="btn-pull-shared-db" style="display: inline-flex; align-items: center; gap: 4px; padding: 6px 10px; font-size: 11px; height: 28px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
              Sync / Pull Updates
            </button>
            <button class="btn btn-danger btn-sm" id="btn-disconnect-shared-db" style="display: inline-flex; align-items: center; gap: 4px; padding: 6px 10px; font-size: 11px; height: 28px; background: transparent; border-color: var(--status-failed); color: var(--status-failed);">
              Disconnect
            </button>
          </div>
        </div>
      `;
      // Bind inline click handlers securely to bypass onclick global issues
      const pullBtn = section.querySelector('#btn-pull-shared-db');
      if (pullBtn) {
        pullBtn.addEventListener('click', () => {
          pullSharedDatabase()
            .then(() => alert('Successfully pulled and merged latest updates.'))
            .catch(err => {
              console.error(err);
              alert('Failed to pull updates: ' + err.message);
            });
        });
      }
      const disconnectBtn = section.querySelector('#btn-disconnect-shared-db');
      if (disconnectBtn) {
        disconnectBtn.addEventListener('click', () => {
          disconnectSharedDatabase();
        });
      }
    } else {
      section.innerHTML = `
        <button class="btn btn-primary btn-sm" id="btn-connect-shared-db" style="display: inline-flex; align-items: center; gap: 6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2 2V7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1"></path><path d="M18 8h6v8h-6z"></path><circle cx="12" cy="12" r="3"></circle></svg>
          <span>Connect Shared Database...</span>
        </button>
      `;
      const connectBtn = section.querySelector('#btn-connect-shared-db');
      if (connectBtn) {
        connectBtn.addEventListener('click', () => {
          connectSharedDatabase();
        });
      }
    }
  }

  // View headings mapping
  const viewTitles = {
    dashboard: 'Dashboard Overview',
    programs: 'Programs',
    requirements: 'Requirements Compliance',
    capabilities: 'Shared Capability Matrix',
    tests: 'Verification Test Log',
    traceability: 'Interactive Traceability Graph'
  };


  // Switch view tabs
  function switchView(viewId) {
    currentView = viewId;
    
    // Update active class on nav buttons
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.remove('active');
    });
    const activeNav = document.getElementById(`nav-${viewId}`);
    if (activeNav) activeNav.classList.add('active');

    // Update visibility of panes
    document.querySelectorAll('.view-pane').forEach(pane => {
      pane.classList.remove('active');
    });
    const activePane = document.getElementById(`view-${viewId}`);
    if (activePane) activePane.classList.add('active');

    // Update heading text
    document.getElementById('page-heading').innerText = viewTitles[viewId];

    // Update primary action button in header
    const actionBtn = document.getElementById('header-action-btn');
    if (viewId === 'dashboard' || viewId === 'traceability') {
      actionBtn.style.display = 'none';
    } else {
      actionBtn.style.display = 'inline-flex';
      const label = actionBtn.querySelector('span');
      if (viewId === 'programs') {
        label.innerText = 'Add Program';
        actionBtn.setAttribute('onclick', "ReqApp.openModal('program-modal')");
      } else if (viewId === 'requirements') {
        label.innerText = 'Add Requirement';
        actionBtn.setAttribute('onclick', "ReqApp.openModal('requirement-modal')");
      } else if (viewId === 'capabilities') {
        label.innerText = 'Add Capability';
        actionBtn.setAttribute('onclick', "ReqApp.openModal('capability-modal')");
      } else if (viewId === 'tests') {
        label.innerText = 'Add Test';
        actionBtn.setAttribute('onclick', "ReqApp.openModal('test-modal')");
      }
    }

    render();
  }

  // Deep link drill routing utility
  function drillTo(viewId, query) {
    if (viewId === 'planning') {
      selectedProgramTab = 'planning';
      switchView('programs');
      selectProgram(query);
      return;
    }

    switchView(viewId);
    
    if (viewId === 'requirements') {
      const searchBox = document.getElementById('search-requirements');
      if (searchBox) searchBox.value = query;
      
      const progFilter = document.getElementById('filter-req-program');
      const statusFilter = document.getElementById('filter-req-status');
      if (progFilter) progFilter.value = 'ALL';
      if (statusFilter) statusFilter.value = 'ALL';
      renderRequirements();
    } else if (viewId === 'capabilities') {
      const searchBox = document.getElementById('search-capabilities');
      if (searchBox) searchBox.value = query;
      renderCapabilities();
    } else if (viewId === 'tests') {
      const searchBox = document.getElementById('search-tests');
      if (searchBox) searchBox.value = query;
      
      const statusFilter = document.getElementById('filter-test-status');
      if (statusFilter) statusFilter.value = 'ALL';
      const programFilter = document.getElementById('filter-test-program');
      if (programFilter) programFilter.value = 'ALL';
      const assigneeFilter = document.getElementById('filter-test-assignee');
      if (assigneeFilter) assigneeFilter.value = 'ALL';
      renderTests();
    } else if (viewId === 'programs') {
      selectProgram(query);
    }
  }

  // Set selected program in split-pane
  function selectProgram(id) {
    selectedProgramId = id;
    renderPrograms();
  }

  // Toggle grid/list requirement view mode
  function setRequirementsViewMode(mode) {
    reqViewMode = mode;
    localStorage.setItem('req_view_mode', mode);
    
    // Toggle active class on toggle buttons
    const gridBtn = document.getElementById('toggle-req-grid');
    const listBtn = document.getElementById('toggle-req-list');
    if (gridBtn && listBtn) {
      if (mode === 'grid') {
        gridBtn.classList.add('active');
        listBtn.classList.remove('active');
      } else {
        gridBtn.classList.remove('active');
        listBtn.classList.add('active');
      }
    }
    renderRequirements();
  }

  // Modals management
  function openModal(modalId, editId = null) {
    const backdrop = document.getElementById(modalId);
    if (!backdrop) return;
    
    backdrop.style.display = 'flex';
    
    // Setup select dropdowns depending on modal context
    if (modalId === 'requirement-modal') {
      populateRequirementSelects(editId);
    } else if (modalId === 'test-modal') {
      populateTestSelects(editId);
      switchModalTab('setup');
    } else if (modalId === 'test-types-modal') {
      renderTestTypesList();
    } else if (modalId === 'component-codes-modal') {
      renderComponentCodesList();
    } else if (modalId === 'team-modal') {
      renderTeamList();
    } else if (modalId === 'import-capabilities-modal') {
      resetImportCapabilitiesForm();
    } else if (modalId === 'settings-modal') {
      renderSettingsModalSharedSection();
    }

    // Configure delete button if present in modal footer
    const prefix = modalId.split('-')[0];
    const deleteBtn = document.getElementById(`${prefix}-delete-btn`);
    if (deleteBtn) {
      if (editId) {
        deleteBtn.style.display = 'inline-flex';
        deleteBtn.onclick = () => {
          if (modalId === 'requirement-modal') {
            deleteRequirement(editId);
          } else if (modalId === 'capability-modal') {
            deleteCapability(editId);
          } else if (modalId === 'test-modal') {
            deleteTest(editId);
          }
          closeModal(modalId);
        };
      } else {
        deleteBtn.style.display = 'none';
        deleteBtn.onclick = null;
      }
    }

    // Populate the forms if editId is provided
    if (editId) {
      document.getElementById(`${modalId}-title`).innerText = `Edit ${modalId.split('-')[0].toUpperCase()}`;
      populateEditForm(modalId, editId);
    } else {
      if (document.getElementById(`${modalId}-title`)) {
        document.getElementById(`${modalId}-title`).innerText = `Add ${modalId.split('-')[0].toUpperCase()}`;
      }
      resetEditForm(modalId);
    }
  }

  function closeModal(modalId) {
    const backdrop = document.getElementById(modalId);
    if (backdrop) backdrop.style.display = 'none';
  }

  function switchProgramTab(tabId) {
    selectedProgramTab = tabId;
    renderPrograms();
  }

  function toggleProgramsSidebar() {
    const container = document.querySelector('.program-split-container');
    if (container) {
      container.classList.toggle('collapsed-sidebar');
    }
  }

  function switchModalTab(tabId) {
    const panes = document.querySelectorAll('#test-modal .modal-tab-pane');
    panes.forEach(pane => {
      pane.style.display = 'none';
    });

    const btns = document.querySelectorAll('#test-modal .modal-tab-btn');
    btns.forEach(btn => {
      btn.classList.remove('active');
    });

    const targetPane = document.getElementById(`tab-content-${tabId}`);
    if (targetPane) {
      targetPane.style.display = 'block';
    }

    const targetBtn = document.getElementById(`tab-btn-${tabId}`);
    if (targetBtn) {
      targetBtn.classList.add('active');
    }
  }

  // Populate drop-downs inside Requirement modal
  function populateRequirementSelects(editId = null) {
    const progSelect = document.getElementById('requirement-program-select');
    const capSelect = document.getElementById('requirement-capability-select');
    const compSelect = document.getElementById('requirement-component-select');
    
    progSelect.innerHTML = state.programs.map(p => 
      `<option value="${p.id}">${escapeHTML(p.name)}</option>`
    ).join('');

    capSelect.innerHTML = '<option value="">None (Standalone)</option>' + 
      state.capabilities.map(c => 
        `<option value="${c.id}">${escapeHTML(c.id)}: ${escapeHTML(c.description.substring(0, 50))}${c.description.length > 50 ? '...' : ''}</option>`
      ).join('');

    if (compSelect) {
      compSelect.innerHTML = state.componentCodes.map(c =>
        `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`
      ).join('');
    }
  }

  // Populate requirements checkboxes for the selected program
  function populateTestRequirements() {
    const programSelect = document.getElementById('test-program-select');
    const container = document.getElementById('test-requirements-checkbox-list');
    if (!programSelect || !container) return;

    // Reset search filter
    const searchInput = document.getElementById('test-requirements-search');
    if (searchInput) {
      searchInput.value = '';
    }
    const statsEl = document.getElementById('test-requirements-search-stats');
    if (statsEl) {
      statsEl.style.display = 'none';
      statsEl.innerText = '';
    }

    const programId = programSelect.value;
    if (!programId) {
      container.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:4px;">Select a program first</div>';
      return;
    }

    const programReqs = state.requirements.filter(r => r.programId === programId);
    if (programReqs.length === 0) {
      container.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:4px;">No requirements exist for this program</div>';
      return;
    }

    const editId = document.getElementById('test-edit-id').value;
    const editingTest = editId ? state.tests.find(t => t.id === editId) : null;
    const checkedIds = editingTest ? (editingTest.requirementIds || []) : [];

    container.innerHTML = programReqs.map(r => {
      const isChecked = checkedIds.includes(r.id) ? 'checked' : '';
      const compCode = r.component || 'SE';
      return `
        <label style="display:flex; align-items:flex-start; gap:8px; font-size:12px; cursor:pointer; color:var(--text-primary); margin: 2px 0;">
          <input type="checkbox" name="test-requirement-checkbox" value="${escapeHTML(r.id)}" ${isChecked} style="margin-top:2px;">
          <span><strong>${escapeHTML(r.id)}</strong> <span class="badge" style="background-color: var(--border-color); color: var(--text-secondary); font-size: 8px; padding: 1px 4px; font-weight: 700; border-radius: 3px; margin-right: 4px; vertical-align: middle;">${escapeHTML(compCode)}</span>: ${escapeHTML(r.description)}</span>
        </label>
      `;
    }).join('');
  }

  // Filter requirements checkboxes by search term
  function filterTestRequirements() {
    const searchInput = document.getElementById('test-requirements-search');
    if (!searchInput) return;
    const query = searchInput.value.toLowerCase().trim();

    const container = document.getElementById('test-requirements-checkbox-list');
    if (!container) return;

    const statsEl = document.getElementById('test-requirements-search-stats');

    const labels = container.querySelectorAll('label');
    let visibleCount = 0;
    const totalCount = labels.length;

    labels.forEach(label => {
      const text = label.textContent.toLowerCase();
      if (text.includes(query)) {
        label.style.display = 'flex';
        visibleCount++;
      } else {
        label.style.display = 'none';
      }
    });

    if (statsEl) {
      if (query === '') {
        statsEl.style.display = 'none';
        statsEl.innerText = '';
      } else {
        statsEl.style.display = 'block';
        statsEl.innerText = `Showing ${visibleCount} of ${totalCount} requirements`;
      }
    }
  }

  // Render subtask drop-downs inside Test modal if type is SIL, HIL, or Monte Carlo
  function renderSubtaskFields(type, subtaskValues = null) {
    const container = document.getElementById('test-subtasks-container');
    const list = document.getElementById('test-subtasks-list');
    const statusSelect = document.getElementById('test-status-select');
    const rollupInfo = document.getElementById('test-status-rollup-info');
    if (!container || !list || !statusSelect || !rollupInfo) return;

    let subtasks = [];
    let options = [];
    if (type === 'SIL' || type === 'HIL') {
      subtasks = ['Simulink Test', `${type} Test`];
      options = ['Not Started', 'In Progress', 'Passing', 'N/A'];
    } else if (type === 'Monte Carlo') {
      subtasks = ['MC Test'];
      options = ['Not Started', 'In Progress', 'Passing'];
    }

    if (subtasks.length > 0) {
      container.style.display = 'block';
      statusSelect.disabled = true;
      rollupInfo.style.display = 'block';

      list.innerHTML = subtasks.map(name => {
        const val = (subtaskValues && subtaskValues[name]) ? subtaskValues[name] : 'Not Started';
        const optsHtml = options.map(opt => 
          `<option value="${opt}" ${val === opt ? 'selected' : ''}>${opt}</option>`
        ).join('');

        return `
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:12px; font-weight:600; color:var(--text-primary);">${escapeHTML(name)}</span>
            <select class="form-select subtask-select" data-subtask="${escapeHTML(name)}" style="width: 140px; font-size:11px; padding:4px 8px; height:auto;" onchange="ReqApp.updateTestRollupPreview()">
              ${optsHtml}
            </select>
          </div>
        `;
      }).join('');
      
      updateTestRollupPreview();
    } else {
      container.style.display = 'none';
      list.innerHTML = '';
      statusSelect.disabled = false;
      rollupInfo.style.display = 'none';
    }
  }

  // Preview test rollup status in modal
  function updateTestRollupPreview() {
    const type = document.getElementById('test-type-select').value;
    const statusSelect = document.getElementById('test-status-select');
    if (!statusSelect) return;

    if (type === 'SIL' || type === 'HIL' || type === 'Monte Carlo') {
      const selects = document.querySelectorAll('.subtask-select');
      const statuses = Array.from(selects).map(sel => sel.value);
      const rolledUp = window.ReqData.rollupStatus(statuses);
      statusSelect.value = rolledUp;
    }
    updateModalPassedDateDisplay();
  }

  // Update dynamic display of passed date in the test modal
  function updateModalPassedDateDisplay() {
    const editId = document.getElementById('test-edit-id').value;
    const statusSelect = document.getElementById('test-status-select');
    const dateContainer = document.getElementById('test-passed-date-container');
    const dateSpan = document.getElementById('test-passed-date-span');
    if (!statusSelect || !dateContainer || !dateSpan) return;

    if (statusSelect.value === 'Passed') {
      if (editId) {
        const item = state.tests.find(t => t.id === editId);
        if (item && item.passedDate) {
          dateContainer.style.display = 'block';
          dateSpan.innerText = formatPassDate(item.passedDate);
          return;
        }
      }
      dateContainer.style.display = 'block';
      dateSpan.innerText = '(Will be recorded on save)';
    } else {
      dateContainer.style.display = 'none';
      dateSpan.innerText = '';
    }
  }

  // Populate drop-downs inside Test modal
  function populateTestSelects(editId = null) {
    const typeSelect = document.getElementById('test-type-select');
    const programSelect = document.getElementById('test-program-select');
    const assigneeSelect = document.getElementById('test-assignee-select');
    const componentSelect = document.getElementById('test-component-select');

    // Populate test types dropdown dynamically
    typeSelect.innerHTML = state.testTypes.map(t =>
      `<option value="${escapeHTML(t)}">${escapeHTML(t)}</option>`
    ).join('');

    // Populate program dropdown
    programSelect.innerHTML = state.programs.map(p =>
      `<option value="${p.id}">${escapeHTML(p.name)}</option>`
    ).join('');

    // Populate component dropdown
    if (componentSelect) {
      componentSelect.innerHTML = state.componentCodes.map(c =>
        `<option value="${c}">${escapeHTML(c)}</option>`
      ).join('');
    }

    // Populate assignee dropdown
    if (assigneeSelect) {
      assigneeSelect.innerHTML = `<option value="">Unassigned</option>` +
        state.teamMembers.map(tm =>
          `<option value="${tm.id}">${escapeHTML(tm.name)}</option>`
        ).join('');
    }

    // Set editing test program
    if (editId) {
      const editingTest = state.tests.find(t => t.id === editId);
      if (editingTest) {
        programSelect.value = editingTest.programId || '';
        if (componentSelect) {
          componentSelect.value = editingTest.component || 'SE';
        }
      }
    } else if (state.programs.length > 0) {
      programSelect.value = state.programs[0].id;
      if (componentSelect) {
        componentSelect.value = 'SE';
      }
    }

    // Add dynamic subtasks rendering trigger on test type change
    if (typeSelect) {
      typeSelect.onchange = (e) => {
        renderSubtaskFields(e.target.value);
      };
    }

    // Load the requirements for the selected program
    populateTestRequirements();

    // Render subtasks for the initial selected type (if not editing)
    if (!editId && typeSelect) {
      renderSubtaskFields(typeSelect.value);
    }
  }

  // Render tag list inside Manage Test Types modal
  function renderTestTypesList() {
    const list = document.getElementById('modal-test-types-list');
    if (list) {
      list.innerHTML = state.testTypes.map(t => `
        <div class="test-type-tag">
          <span>${escapeHTML(t)}</span>
          <button class="test-type-tag-remove" type="button" data-type="${escapeHTML(t)}" onclick="ReqApp.deleteTestType(this.dataset.type)">&times;</button>
        </div>
      `).join('');
    }
  }

  // Add Test Type dynamically
  function addTestType(event) {
    event.preventDefault();
    const input = document.getElementById('new-test-type-input');
    const type = input.value.trim();
    if (type && !state.testTypes.includes(type)) {
      state.testTypes.push(type);
      untrackDeletion(type);
      logActivity(`Added test type "${type}"`);
      input.value = '';
      syncAndRefresh();
      renderTestTypesList();
    }
  }

  // Delete Test Type dynamically
  function deleteTestType(type) {
    if (confirm(`Are you sure you want to remove test type "${type}"? tests using this type will remain but dropdowns will not include it.`)) {
      state.testTypes = state.testTypes.filter(t => t !== type);
      trackDeletion(type);
      logActivity(`Deleted test type "${type}"`);
      syncAndRefresh();
      renderTestTypesList();
    }
  }

  // Render tag list inside Manage Component Codes modal
  function renderComponentCodesList() {
    const list = document.getElementById('modal-component-codes-list');
    if (list) {
      list.innerHTML = state.componentCodes.map(c => `
        <div class="test-type-tag">
          <span>${escapeHTML(c)}</span>
          <button class="test-type-tag-remove" type="button" data-code="${escapeHTML(c)}" onclick="ReqApp.deleteComponentCode(this.dataset.code)">&times;</button>
        </div>
      `).join('');
    }
  }

  // Add Component Code dynamically
  function addComponentCode(event) {
    event.preventDefault();
    const input = document.getElementById('new-component-code-input');
    const code = input.value.trim().toUpperCase();
    if (code && !state.componentCodes.includes(code)) {
      state.componentCodes.push(code);
      untrackDeletion(code);
      logActivity(`Added component code "${code}"`);
      input.value = '';
      syncAndRefresh();
      renderComponentCodesList();
    }
  }

  // Delete Component Code dynamically
  function deleteComponentCode(code) {
    if (confirm(`Are you sure you want to remove component code "${code}"? Requirements using this component code will keep it, but it will not appear in select dropdowns.`)) {
      state.componentCodes = state.componentCodes.filter(c => c !== code);
      trackDeletion(code);
      logActivity(`Deleted component code "${code}"`);
      syncAndRefresh();
      renderComponentCodesList();
    }
  }

  // Get initials from a name
  function getInitials(name) {
    if (!name) return '??';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Render tag list inside Manage Team Members modal
  function renderTeamList() {
    const list = document.getElementById('modal-team-list');
    if (list) {
      list.innerHTML = state.teamMembers.map(tm => `
        <div class="team-member-tag" style="display:inline-flex; align-items:center; gap:8px; padding:6px 12px; background:var(--bg-canvas); border:1px solid var(--border-color); border-radius:20px; font-size:13px; font-weight:500;">
          <span class="assignee-avatar-badge" style="background-color: ${tm.color}; margin-right: 0;" title="${escapeHTML(tm.name)}">${escapeHTML(tm.initials)}</span>
          <span style="font-weight: 500;">${escapeHTML(tm.name)}</span>
          <button class="test-type-tag-remove" type="button" data-member-id="${escapeHTML(tm.id)}" onclick="ReqApp.deleteTeamMember(this.dataset.memberId)" style="background: none; border: none; font-size: 14px; font-weight: 700; cursor: pointer; line-height: 1; margin-left: 4px;">&times;</button>
        </div>
      `).join('');
    }
  }

  // Add Team Member dynamically
  function addTeamMember(event) {
    event.preventDefault();
    const nameInput = document.getElementById('new-team-member-name');
    const colorInput = document.getElementById('new-team-member-color');
    const name = nameInput.value.trim();
    const color = colorInput.value;

    if (name) {
      const initials = getInitials(name);
      const newId = `TM-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      state.teamMembers.push({ id: newId, name, initials, color });
      untrackDeletion(newId);
      logActivity(`Added team member "${name}"`);
      nameInput.value = '';
      colorInput.value = '#4F46E5';
      syncAndRefresh();
      renderTeamList();
    }
  }

  // Delete Team Member dynamically
  function deleteTeamMember(id) {
    const tm = state.teamMembers.find(t => t.id === id);
    if (!tm) return;
    if (confirm(`Are you sure you want to remove team member "${tm.name}"? They will be unassigned from any tests.`)) {
      state.teamMembers = state.teamMembers.filter(t => t.id !== id);
      state.tests.forEach(t => {
        if (t.assigneeId === id) {
          t.assigneeId = null;
        }
      });
      trackDeletion(id);
      logActivity(`Deleted team member "${tm.name}"`);
      syncAndRefresh();
      renderTeamList();
    }
  }

  // Open modal to link a requirement to an existing test
  function openLinkTestModal(reqId) {
    const req = state.requirements.find(r => r.id === reqId);
    if (!req) return;

    document.getElementById('link-test-req-id').value = reqId;
    document.getElementById('link-test-req-display').innerText = reqId;

    const testSelect = document.getElementById('link-test-select');
    // Find all tests in the same program
    const programTests = state.tests.filter(t => t.programId === req.programId);

    if (programTests.length === 0) {
      alert(`No tests exist for program "${req.programId}". Create a new test first.`);
      return;
    }

    testSelect.innerHTML = programTests.map(t => {
      const isAlreadyLinked = t.requirementIds && t.requirementIds.includes(reqId);
      const suffix = isAlreadyLinked ? ' (Already Linked)' : '';
      return `<option value="${t.id}" ${isAlreadyLinked ? 'disabled' : ''}>${escapeHTML(t.name)}${suffix}</option>`;
    }).join('');

    openModal('link-test-modal');
  }

  // Save the requirement to test association
  function saveLinkTest(event) {
    event.preventDefault();
    const reqId = document.getElementById('link-test-req-id').value;
    const testId = document.getElementById('link-test-select').value;

    const test = state.tests.find(t => t.id === testId);
    if (test) {
      if (!test.requirementIds) test.requirementIds = [];
      if (!test.requirementIds.includes(reqId)) {
        test.requirementIds.push(reqId);
      }
      syncAndRefresh();
      closeModal('link-test-modal');
    }
  }

  // Populate edit forms
  function populateEditForm(modalId, editId) {
    if (modalId === 'program-modal') {
      const item = state.programs.find(p => p.id === editId);
      if (item) {
        document.getElementById('program-edit-id').value = item.id;
        document.getElementById('program-id-input').value = item.id;
        document.getElementById('program-id-input').disabled = true;
        document.getElementById('program-name-input').value = item.name;
        document.getElementById('program-desc-input').value = item.description || '';
      }
    } else if (modalId === 'requirement-modal') {
      const item = state.requirements.find(r => r.id === editId);
      if (item) {
        document.getElementById('requirement-edit-db-id').value = item.id;
        document.getElementById('requirement-id-input').value = item.id;
        document.getElementById('requirement-id-input').disabled = true;
        document.getElementById('requirement-program-select').value = item.programId;
        document.getElementById('requirement-capability-select').value = item.capabilityId || '';
        document.getElementById('requirement-inherit-checkbox').checked = !!item.inheritPassFromCapability;
        document.getElementById('requirement-component-select').value = item.component || '';
        document.getElementById('requirement-desc-input').value = item.description;
        document.getElementById('requirement-notes-input').value = item.notes || '';
      }
    } else if (modalId === 'capability-modal') {
      const item = state.capabilities.find(c => c.id === editId);
      if (item) {
        document.getElementById('capability-edit-id').value = item.id;
        document.getElementById('capability-id-input').value = item.id;
        document.getElementById('capability-id-input').disabled = true;
        document.getElementById('capability-desc-input').value = item.description || '';
      }
    } else if (modalId === 'test-modal') {
      const item = state.tests.find(t => t.id === editId);
      if (item) {
        document.getElementById('test-edit-id').value = item.id;
        document.getElementById('test-name-input').value = item.name;
        document.getElementById('test-type-select').value = item.type;
        document.getElementById('test-location-input').value = item.location;
        document.getElementById('test-program-desc-input').value = item.programDescription;
        document.getElementById('test-program-select').value = item.programId || '';
        
        // Populate and pre-select requirements checkboxes
        populateTestRequirements();
        
        if (document.getElementById('test-assignee-select')) {
          document.getElementById('test-assignee-select').value = item.assigneeId || '';
        }

        if (document.getElementById('test-component-select')) {
          document.getElementById('test-component-select').value = item.component || 'SE';
        }

        // Render and populate subtask values
        renderSubtaskFields(item.type, item.subtasks);
        
        document.getElementById('test-status-select').value = item.status;
        document.getElementById('test-notes-input').value = item.notes || '';
        document.getElementById('test-estimate-input').value = item.estimate !== undefined ? item.estimate : 0;
        updateModalPassedDateDisplay();
      }
    }
  }

  // Reset form inputs for addition mode
  function resetEditForm(modalId) {
    if (modalId === 'program-modal') {
      document.getElementById('program-edit-id').value = '';
      document.getElementById('program-id-input').disabled = false;
      document.getElementById('program-form').reset();
    } else if (modalId === 'requirement-modal') {
      document.getElementById('requirement-edit-db-id').value = '';
      document.getElementById('requirement-id-input').disabled = false;
      document.getElementById('requirement-form').reset();
      document.getElementById('requirement-notes-input').value = '';
      if (selectedProgramId) {
        document.getElementById('requirement-program-select').value = selectedProgramId;
      }
    } else if (modalId === 'capability-modal') {
      document.getElementById('capability-edit-id').value = '';
      document.getElementById('capability-id-input').disabled = false;
      document.getElementById('capability-form').reset();
    } else if (modalId === 'test-modal') {
      document.getElementById('test-edit-id').value = '';
      document.getElementById('test-form').reset();
      if (document.getElementById('test-component-select')) {
        document.getElementById('test-component-select').value = 'SE';
      }
      document.getElementById('test-notes-input').value = '';
      document.getElementById('test-estimate-input').value = '0';
      renderSubtaskFields('');
      const dateContainer = document.getElementById('test-passed-date-container');
      const dateSpan = document.getElementById('test-passed-date-span');
      if (dateContainer && dateSpan) {
        dateContainer.style.display = 'none';
        dateSpan.innerText = '';
      }
    }
  }

  // CRUD Actions
  function saveProgram(event) {
    event.preventDefault();
    const editId = document.getElementById('program-edit-id').value;
    const newId = document.getElementById('program-id-input').value.trim();
    const name = document.getElementById('program-name-input').value.trim();
    const description = document.getElementById('program-desc-input').value.trim();

    if (!editId) {
      if (!isValidId(newId)) {
        alert("Program ID cannot contain quotes (', \"), backslashes, or control characters.");
        return;
      }
      if (state.programs.some(p => p.id === newId)) {
        alert("Program ID already exists!");
        return;
      }
      state.programs.push({ id: newId, name, description });
      untrackDeletion(newId);
      logActivity(`Created program "${newId}"`);
      selectedProgramId = newId; // select newly created program
    } else {
      const idx = state.programs.findIndex(p => p.id === editId);
      if (idx !== -1) {
        state.programs[idx] = { id: editId, name, description };
        untrackDeletion(editId);
        logActivity(`Updated program "${editId}"`);
      }
    }

    syncAndRefresh();
    closeModal('program-modal');
  }

  function deleteProgram(id) {
    if (confirm(`Are you sure you want to delete program "${id}"? This unlinks but does not delete its requirements.`)) {
      state.programs = state.programs.filter(p => p.id !== id);
      if (selectedProgramId === id) {
        selectedProgramId = state.programs.length > 0 ? state.programs[0].id : null;
      }
      trackDeletion(id);
      logActivity(`Deleted program "${id}"`);
      syncAndRefresh();
    }
  }

  function saveRequirement(event) {
    event.preventDefault();
    const editId = document.getElementById('requirement-edit-db-id').value;
    const newId = document.getElementById('requirement-id-input').value.trim();
    const programId = document.getElementById('requirement-program-select').value;
    const capabilityId = document.getElementById('requirement-capability-select').value || null;
    const inheritPassFromCapability = document.getElementById('requirement-inherit-checkbox').checked;
    const component = document.getElementById('requirement-component-select').value;
    const description = document.getElementById('requirement-desc-input').value.trim();
    const notes = document.getElementById('requirement-notes-input').value.trim();

    if (!editId) {
      if (!isValidId(newId)) {
        alert("Requirement ID cannot contain quotes (', \"), backslashes, or control characters.");
        return;
      }
      if (state.requirements.some(r => r.id === newId)) {
        alert("Requirement ID already exists!");
        return;
      }
      state.requirements.push({
        id: newId,
        programId,
        capabilityId,
        inheritPassFromCapability,
        component,
        description,
        status: 'Not Started',
        notes
      });
      untrackDeletion(newId);
      logActivity(`Created requirement "${newId}"`);
    } else {
      const idx = state.requirements.findIndex(r => r.id === editId);
      if (idx !== -1) {
        state.requirements[idx].programId = programId;
        state.requirements[idx].capabilityId = capabilityId;
        state.requirements[idx].inheritPassFromCapability = inheritPassFromCapability;
        state.requirements[idx].component = component;
        state.requirements[idx].description = description;
        state.requirements[idx].notes = notes;
        untrackDeletion(editId);
        logActivity(`Updated requirement "${editId}"`);
      }
    }

    syncAndRefresh();
    closeModal('requirement-modal');
  }

  function deleteRequirement(id) {
    if (confirm(`Are you sure you want to delete requirement "${id}"? This unlinks it from any tests.`)) {
      state.tests.forEach(t => {
        if (t.requirementIds) {
          t.requirementIds = t.requirementIds.filter(reqId => reqId !== id);
        }
      });
      state.requirements = state.requirements.filter(r => r.id !== id);
      trackDeletion(id);
      logActivity(`Deleted requirement "${id}"`);
      syncAndRefresh();
    }
  }

  // Handlers for Header actions context-dependent
  function handleHeaderAction() {
    // Defined dynamically
  }

  function saveCapability(event) {
    event.preventDefault();
    const editId = document.getElementById('capability-edit-id').value;
    const newId = document.getElementById('capability-id-input').value.trim();
    const description = document.getElementById('capability-desc-input').value.trim();

    if (!editId) {
      if (!isValidId(newId)) {
        alert("Capability ID cannot contain quotes (', \"), backslashes, or control characters.");
        return;
      }
      if (state.capabilities.some(c => c.id === newId)) {
        alert("Capability ID already exists!");
        return;
      }
      state.capabilities.push({ id: newId, description, status: 'Not Started' });
      untrackDeletion(newId);
      logActivity(`Created capability "${newId}"`);
    } else {
      const idx = state.capabilities.findIndex(c => c.id === editId);
      if (idx !== -1) {
        state.capabilities[idx] = { id: editId, description, status: state.capabilities[idx].status };
        untrackDeletion(editId);
        logActivity(`Updated capability "${editId}"`);
      }
    }

    syncAndRefresh();
    closeModal('capability-modal');
  }

  function deleteCapability(id) {
    if (confirm(`Are you sure you want to delete capability "${id}"? This unlinks but does not delete its requirements.`)) {
      state.requirements.forEach(r => {
        if (r.capabilityId === id) {
          r.capabilityId = null;
          r.inheritPassFromCapability = false;
        }
      });
      state.capabilities = state.capabilities.filter(c => c.id !== id);
      trackDeletion(id);
      logActivity(`Deleted capability "${id}"`);
      syncAndRefresh();
    }
  }

  function saveTest(event) {
    event.preventDefault();
    const editId = document.getElementById('test-edit-id').value;
    const name = document.getElementById('test-name-input').value.trim();
    const type = document.getElementById('test-type-select').value;
    const programId = document.getElementById('test-program-select').value;
    const location = document.getElementById('test-location-input').value.trim();
    const programDescription = document.getElementById('test-program-desc-input').value.trim();
    const status = document.getElementById('test-status-select').value;

    const assigneeSelectVal = document.getElementById('test-assignee-select') ? document.getElementById('test-assignee-select').value : '';
    const assigneeId = assigneeSelectVal || null;
    const componentSelectVal = document.getElementById('test-component-select') ? document.getElementById('test-component-select').value : 'SE';
    const component = componentSelectVal || 'SE';
    const notes = document.getElementById('test-notes-input').value.trim();
    const estimateInputVal = document.getElementById('test-estimate-input') ? document.getElementById('test-estimate-input').value : '0';
    const estimate = parseFloat(estimateInputVal) || 0;

    let subtasks = null;
    if (type === 'SIL' || type === 'HIL' || type === 'Monte Carlo') {
      subtasks = {};
      const subSelects = document.querySelectorAll('.subtask-select');
      subSelects.forEach(sel => {
        subtasks[sel.dataset.subtask] = sel.value;
      });
    }

    // Retrieve checked requirement IDs
    const checkedCheckboxes = document.querySelectorAll('#test-requirements-checkbox-list input[type="checkbox"]:checked');
    const requirementIds = Array.from(checkedCheckboxes).map(cb => cb.value);

    if (!editId) {
      const newId = `TEST-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      state.tests.push({
        id: newId,
        name,
        type,
        component,
        location,
        programDescription,
        programId,
        requirementIds,
        status,
        assigneeId,
        notes,
        subtasks,
        estimate,
        passedDate: null
      });
      untrackDeletion(newId);
      logActivity(`Created test "${name || newId}"`);
    } else {
      const idx = state.tests.findIndex(t => t.id === editId);
      if (idx !== -1) {
        const existingTest = state.tests[idx];
        state.tests[idx] = {
          id: editId,
          name,
          type,
          component,
          location,
          programDescription,
          programId,
          requirementIds,
          status,
          assigneeId,
          notes,
          subtasks,
          estimate,
          passedDate: existingTest.passedDate
        };
        untrackDeletion(editId);
        logActivity(`Updated test "${name || editId}"`);
      }
    }

    syncAndRefresh();
    closeModal('test-modal');
  }

  function deleteTest(id) {
    const test = state.tests.find(t => t.id === id);
    if (confirm(`Are you sure you want to delete test "${id}"?`)) {
      state.tests = state.tests.filter(t => t.id !== id);
      trackDeletion(id);
      logActivity(`Deleted test "${(test && test.name) || id}"`);
      syncAndRefresh();
    }
  }

  // Toggle test status from UI grids
  function toggleTestOutcome(testId, nextStatus) {
    const idx = state.tests.findIndex(t => t.id === testId);
    if (idx !== -1) {
      const test = state.tests[idx];
      test.status = nextStatus;
      logActivity(`Updated test "${test.name}" status to "${nextStatus}"`);
      syncAndRefresh();
    }
  }

  // Sync state back to local storage and redraw current view
  function syncAndRefresh() {
    pruneTombstones();
    state = window.ReqData.saveState(state);
    if (sharedFileHandle) {
      pushSharedDatabase().catch(err => {
        console.error("Shared database background push failed:", err);
      });
    }
    render();
  }

  // Reset to initial mock data state
  function resetData() {
    if (confirm("Reset application back to default mock database? This replaces current changes.")) {
      state = window.ReqData.resetState();
      selectedProgramId = state.programs.length > 0 ? state.programs[0].id : null;
      syncAndRefresh();
    }
  }

  // Export JSON file
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `req-wrangler-export-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // Export Program Verification Matrix to Markdown (.md)
  function exportProgramMarkdown(programId) {
    const prog = state.programs.find(p => p.id === programId);
    if (!prog) return;

    const progReqs = state.requirements.filter(r => r.programId === programId);
    const passedReqs = progReqs.filter(r => r.status === 'Passed').length;
    const totalReqs = progReqs.length;
    const compliancePct = totalReqs > 0 ? Math.round((passedReqs / totalReqs) * 100) : 0;

    let md = `# Program Status Report: ${prog.name}\n\n`;
    md += `**Program ID:** ${prog.id}  \n`;
    md += `**Compliance Status:** ${compliancePct}% (${passedReqs} / ${totalReqs} Requirements Passed)  \n`;
    md += `**Export Date:** ${new Date().toLocaleDateString()}  \n\n`;
    md += `## Description\n${prog.description || 'No description provided.'}\n\n`;

    md += `## Requirements Verification Matrix\n\n`;
    md += `| Requirement ID | Component | Description | Linked Capability | Status | Linked Test(s) / Inherited Source |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

    progReqs.forEach(r => {
      const capId = r.capabilityId || 'None';
      const linkedTests = state.tests.filter(t => 
        t.programId === r.programId && 
        t.requirementIds && 
        t.requirementIds.includes(r.id)
      );

      let testCol = 'Unlinked';
      if (linkedTests.length > 0) {
        testCol = linkedTests.map(t => `${t.name} (${t.status})`).join(', ');
      } else {
        const sources = getInheritedPassSource(r);
        if (sources && sources.length > 0) {
          testCol = 'Inherited Pass from: ' + sources.map(src => {
            return src.testName ? `${src.testName} (${src.programName})` : `Req ${src.requirementId} (${src.programName})`;
          }).join(', ');
        }
      }

      md += `| ${r.id} | ${r.component || 'SE'} | ${r.description.replace(/\|/g, '\\|')} | ${capId} | ${r.status} | ${testCol.replace(/\|/g, '\\|')} |\n`;
    });

    md += `\n## Verification Tests Backlog\n\n`;
    const progTests = state.tests.filter(t => t.programId === programId);
    if (progTests.length === 0) {
      md += `*No tests associated with this program.*\n`;
    } else {
      md += `| Test ID | Test Name | Type | Assignee | Estimate | Status | Passed Date | Notes |\n`;
      md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

      progTests.forEach(t => {
        const assignee = t.assigneeId ? state.teamMembers.find(tm => tm.id === t.assigneeId) : null;
        const assigneeName = assignee ? assignee.name : 'Unassigned';
        const dateStr = t.passedDate ? formatPassDate(t.passedDate) : 'N/A';
        const notesStr = t.notes ? t.notes.replace(/\r?\n/g, ' ') : '';
        md += `| ${t.id} | ${t.name} | ${t.type} | ${assigneeName} | ${t.estimate || 0}d | ${t.status} | ${dateStr} | ${notesStr.replace(/\|/g, '\\|')} |\n`;
      });
    }

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${prog.id}-verification-matrix.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // Export Program Requirements to CSV (.csv)
  function exportProgramCSV(programId) {
    const prog = state.programs.find(p => p.id === programId);
    if (!prog) return;

    const progReqs = state.requirements.filter(r => r.programId === programId);
    
    // Header Row
    const headers = ['Requirement ID', 'Component', 'Description', 'Linked Capability ID', 'Status', 'Linked Tests', 'Notes'];
    
    const escapeCSVVal = (val) => {
      const str = String(val || '');
      if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const csvRows = [headers.map(escapeCSVVal).join(',')];

    progReqs.forEach(r => {
      const linkedTests = state.tests.filter(t => 
        t.programId === r.programId && 
        t.requirementIds && 
        t.requirementIds.includes(r.id)
      );

      let testCol = 'Unlinked';
      if (linkedTests.length > 0) {
        testCol = linkedTests.map(t => `${t.id}: ${t.name} (${t.status})`).join('; ');
      } else {
        const sources = getInheritedPassSource(r);
        if (sources && sources.length > 0) {
          testCol = 'Inherited Pass from: ' + sources.map(src => {
            return src.testId ? `${src.testId} (${src.programName})` : `Req ${src.requirementId} (${src.programName})`;
          }).join('; ');
        }
      }

      const row = [
        r.id,
        r.component || 'SE',
        r.description,
        r.capabilityId || 'None',
        r.status,
        testCol,
        r.notes || ''
      ];

      csvRows.push(row.map(escapeCSVVal).join(','));
    });

    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${prog.id}-requirements-matrix.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // Import JSON file
  function importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const imported = JSON.parse(e.target.result);
        if (imported.programs && imported.requirements && imported.capabilities && imported.tests) {
          state = imported;
          selectedProgramId = state.programs.length > 0 ? state.programs[0].id : null;
          syncAndRefresh();
          alert("Database imported successfully!");
        } else {
          alert("Invalid import format. Check JSON structure.");
        }
      } catch (err) {
        alert("Failed to parse JSON file.");
      }
    };
    reader.readAsText(file);
    event.target.value = ''; // Reset file input
  }

  // Theme Toggler
  function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('req_wrangler_theme', nextTheme);
    
    const moon = document.getElementById('theme-icon-moon');
    const sun = document.getElementById('theme-icon-sun');
    if (nextTheme === 'dark') {
      moon.style.display = 'none';
      sun.style.display = 'block';
    } else {
      moon.style.display = 'block';
      sun.style.display = 'none';
    }
  }

  // Init theme
  function initTheme() {
    const savedTheme = localStorage.getItem('req_wrangler_theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const moon = document.getElementById('theme-icon-moon');
    const sun = document.getElementById('theme-icon-sun');
    if (savedTheme === 'dark') {
      if (moon) moon.style.display = 'none';
      if (sun) sun.style.display = 'block';
    } else {
      if (moon) moon.style.display = 'block';
      if (sun) sun.style.display = 'none';
    }
  }

  // ID validation and sanitization helpers
  function isValidId(id) {
    if (!id || typeof id !== 'string') return false;
    return !/[\'"\\\x00-\x1F]/.test(id);
  }

  function sanitizeId(id) {
    if (!id || typeof id !== 'string') return '';
    return id.replace(/[\'"\\\x00-\x1F]/g, '');
  }

  // HTML escaping helper
  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
  }

  // Format pass date to YYYY-MM-DD
  function formatPassDate(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return '';
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    } catch (e) {
      return '';
    }
  }

  // Get details about where an inherited pass comes from
  function getInheritedPassSource(req) {
    if (!req.inheritPassFromCapability || !req.capabilityId || req.status !== 'Passed') {
      return null;
    }
    
    const cap = state.capabilities.find(c => c.id === req.capabilityId);
    if (!cap || cap.status !== 'Passed' || !cap.passingRequirementIds || cap.passingRequirementIds.length === 0) {
      return null;
    }

    const sources = [];
    cap.passingRequirementIds.forEach(otherReqId => {
      const otherReq = state.requirements.find(r => r.id === otherReqId);
      if (!otherReq) return;

      const prog = state.programs.find(p => p.id === otherReq.programId);
      const progName = prog ? prog.name : otherReq.programId;

      // Find passing tests that link to otherReq
      const passingTests = state.tests.filter(t => 
        t.programId === otherReq.programId && 
        t.requirementIds && 
        t.requirementIds.includes(otherReq.id) &&
        t.status === 'Passed'
      );

      if (passingTests.length > 0) {
        passingTests.forEach(t => {
          sources.push({
            programId: otherReq.programId,
            programName: progName,
            requirementId: otherReq.id,
            testId: t.id,
            testName: t.name
          });
        });
      } else {
        sources.push({
          programId: otherReq.programId,
          programName: progName,
          requirementId: otherReq.id,
          testId: null,
          testName: null
        });
      }
    });

    return sources;
  }

  // RENDER CONTROLLERS
  function render() {
    populateProgramFilters();
    populateComponentFilters();

    if (currentView === 'dashboard') {
      renderDashboard();
    } else if (currentView === 'programs') {
      renderPrograms();
    } else if (currentView === 'requirements') {
      renderRequirements();
    } else if (currentView === 'capabilities') {
      renderCapabilities();
    } else if (currentView === 'tests') {
      renderTests();
    } else if (currentView === 'traceability') {
      renderTraceability();
    }
  }

  // Populate program filters in lists and modals
  function populateProgramFilters() {
    const filterReqProgram = document.getElementById('filter-req-program');
    if (filterReqProgram) {
      const currentSelected = filterReqProgram.value;
      filterReqProgram.innerHTML = '<option value="ALL">All Programs</option>' +
        state.programs.map(p => 
          `<option value="${p.id}">${escapeHTML(p.name)}</option>`
        ).join('');
      filterReqProgram.value = currentSelected;
    }

    const filterTestProgram = document.getElementById('filter-test-program');
    if (filterTestProgram) {
      const currentSelected = filterTestProgram.value;
      filterTestProgram.innerHTML = '<option value="ALL">All Programs</option>' +
        state.programs.map(p => 
          `<option value="${p.id}">${escapeHTML(p.name)}</option>`
        ).join('');
      filterTestProgram.value = currentSelected;
    }

    const filterTestAssignee = document.getElementById('filter-test-assignee');
    if (filterTestAssignee) {
      const currentSelected = filterTestAssignee.value || 'ALL';
      filterTestAssignee.innerHTML = '<option value="ALL">All Assignees</option>' +
        '<option value="UNASSIGNED">Unassigned Only</option>' +
        state.teamMembers.map(tm => 
          `<option value="${tm.id}">${escapeHTML(tm.name)}</option>`
        ).join('');
      if (currentSelected === 'ALL' || currentSelected === 'UNASSIGNED' || state.teamMembers.some(tm => tm.id === currentSelected)) {
        filterTestAssignee.value = currentSelected;
      } else {
        filterTestAssignee.value = 'ALL';
      }
    }

    const planningProgramSelect = document.getElementById('planning-program-select');
    if (planningProgramSelect) {
      const currentSelected = planningProgramSelect.value || selectedProgramId;
      planningProgramSelect.innerHTML = state.programs.map(p => 
        `<option value="${p.id}">${escapeHTML(p.name)}</option>`
      ).join('');
      
      if (currentSelected && state.programs.some(p => p.id === currentSelected)) {
        planningProgramSelect.value = currentSelected;
      } else if (state.programs.length > 0) {
        planningProgramSelect.value = state.programs[0].id;
      }
    }
    populateComponentFilters();
  }

  // Populate component dropdown filters dynamically across all views
  function populateComponentFilters() {
    const planningComponentFilter = document.getElementById('planning-component-filter');
    if (planningComponentFilter) {
      const currentSelected = planningComponentFilter.value || 'ALL';
      let optionsHtml = '<option value="ALL">All Components</option>';
      state.componentCodes.forEach(code => {
        optionsHtml += `<option value="${escapeHTML(code)}">${escapeHTML(code)}</option>`;
      });
      planningComponentFilter.innerHTML = optionsHtml;
      if (currentSelected === 'ALL' || state.componentCodes.includes(currentSelected)) {
        planningComponentFilter.value = currentSelected;
      } else {
        planningComponentFilter.value = 'ALL';
      }
    }

    const filterReqComponent = document.getElementById('filter-req-component');
    if (filterReqComponent) {
      const currentSelected = filterReqComponent.value || 'ALL';
      let optionsHtml = '<option value="ALL">All Components</option>';
      state.componentCodes.forEach(code => {
        optionsHtml += `<option value="${escapeHTML(code)}">${escapeHTML(code)}</option>`;
      });
      filterReqComponent.innerHTML = optionsHtml;
      if (currentSelected === 'ALL' || state.componentCodes.includes(currentSelected)) {
        filterReqComponent.value = currentSelected;
      } else {
        filterReqComponent.value = 'ALL';
      }
    }

    const filterTestComponent = document.getElementById('filter-test-component');
    if (filterTestComponent) {
      const currentSelected = filterTestComponent.value || 'ALL';
      let optionsHtml = '<option value="ALL">All Components</option>';
      state.componentCodes.forEach(code => {
        optionsHtml += `<option value="${escapeHTML(code)}">${escapeHTML(code)}</option>`;
      });
      filterTestComponent.innerHTML = optionsHtml;
      if (currentSelected === 'ALL' || state.componentCodes.includes(currentSelected)) {
        filterTestComponent.value = currentSelected;
      } else {
        filterTestComponent.value = 'ALL';
      }
    }
  }

  // RENDER: DASHBOARD
  function renderDashboard() {
    const totalProgs = state.programs.length;
    const totalReqs = state.requirements.length;
    const passedReqs = state.requirements.filter(r => r.status === 'Passed').length;
    const totalCaps = state.capabilities.length;
    const passedCaps = state.capabilities.filter(c => c.status === 'Passed').length;
    const totalTests = state.tests.length;
    const passedTests = state.tests.filter(t => t.status === 'Passed').length;

    const remainingBacklogDays = state.tests.filter(t => t.status !== 'Passed').reduce((sum, t) => sum + (t.estimate || 0), 0);

    document.getElementById('stat-total-programs').innerText = totalProgs;
    document.getElementById('stat-passed-reqs').innerText = `${passedReqs}/${totalReqs}`;
    document.getElementById('stat-passed-caps').innerText = `${passedCaps}/${totalCaps}`;
    document.getElementById('stat-passed-tests').innerText = `${passedTests}/${totalTests}`;
    document.getElementById('stat-backlog-time').innerText = `${remainingBacklogDays.toFixed(1).replace(/\.0$/, '')} days remaining`;

    const setRing = (ringId, textId, value, total, isCount = false) => {
      const ring = document.getElementById(ringId);
      const text = document.getElementById(textId);
      if (!ring || !text) return;

      const pct = total > 0 ? (value / total) : 0;
      const offset = 157 - (pct * 157);
      ring.style.strokeDashoffset = offset;
      
      if (isCount) {
        text.innerText = value;
      } else {
        text.innerText = `${Math.round(pct * 100)}%`;
      }
    };

    setRing('ring-programs', 'ring-programs-txt', totalProgs, totalProgs, true);
    setRing('ring-reqs', 'ring-reqs-txt', passedReqs, totalReqs);
    setRing('ring-caps', 'ring-caps-txt', passedCaps, totalCaps);
    setRing('ring-tests', 'ring-tests-txt', passedTests, totalTests);

    // Render compliance list
    const complianceContainer = document.getElementById('dashboard-program-compliance-list');
    if (complianceContainer) {
      if (state.programs.length === 0) {
        complianceContainer.innerHTML = '<p style="color: var(--text-secondary); font-size:14px;">No programs created yet.</p>';
      } else {
        complianceContainer.innerHTML = state.programs.map(prog => {
          const progReqs = state.requirements.filter(r => r.programId === prog.id);
          const reqCount = progReqs.length;
          const reqPassed = progReqs.filter(r => r.status === 'Passed').length;
          const pct = reqCount > 0 ? Math.round((reqPassed / reqCount) * 100) : 0;
          
          const unlinkedCount = progReqs.filter(r => 
            !state.tests.some(t => t.programId === r.programId && t.requirementIds && t.requirementIds.includes(r.id))
          ).length;
          const unwrittenCount = state.tests.filter(t => t.programId === prog.id && t.status === 'Not Started').length;

          let alertsHtml = '';
          if (unlinkedCount > 0 || unwrittenCount > 0) {
            alertsHtml = `
              <div style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">
                ${unlinkedCount > 0 ? `
                  <span data-program-id="${escapeHTML(prog.id)}" onclick="event.stopPropagation(); ReqApp.drillTo('planning', this.dataset.programId)" style="background-color:rgba(239, 68, 68, 0.08); color:#EF4444; border:1px solid rgba(239, 68, 68, 0.15); font-size:9px; font-weight:700; padding:1px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px; cursor:pointer;" title="${unlinkedCount} requirements lack verification tests. Click to open Planning Desk.">
                    ⚠️ ${unlinkedCount} Untested
                  </span>` : ''}
                ${unwrittenCount > 0 ? `
                  <span data-program-id="${escapeHTML(prog.id)}" onclick="event.stopPropagation(); ReqApp.drillTo('planning', this.dataset.programId)" style="background-color:rgba(245, 158, 11, 0.08); color:#D97706; border:1px solid rgba(245, 158, 11, 0.15); font-size:9px; font-weight:700; padding:1px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px; cursor:pointer;" title="${unwrittenCount} planned tests need to be written. Click to open Planning Desk.">
                    📋 ${unwrittenCount} Planned
                  </span>` : ''}
              </div>
            `;
          }

          return `
            <div class="dash-prog-item drill-link" data-program-id="${escapeHTML(prog.id)}" onclick="ReqApp.drillTo('programs', this.dataset.programId)" style="cursor:pointer;" title="Click to drill down into program details">
              <div class="dash-prog-info">
                <h4>${escapeHTML(prog.name)}</h4>
                <p>${escapeHTML(prog.description || 'No description')}</p>
                ${alertsHtml}
              </div>
              <div class="dash-prog-stats">
                <span class="stat-pill" style="background-color: var(--border-color); color: var(--text-primary);">
                  ${reqPassed}/${reqCount} Reqs
                </span>
                <span class="stat-pill ${pct === 100 ? 'badge-passed' : pct > 0 ? 'badge-in-progress' : 'badge-not-started'}">
                  ${pct}% Passed
                </span>
              </div>
            </div>
          `;
        }).join('');
      }
    }
    renderActivityLog();
  }

  // RENDER: PLANNING DESK VIEW
  function renderPlanning() {
    if (!selectedProgramId) {
      const untestedContainer = document.getElementById('planning-untested-list');
      const pendingContainer = document.getElementById('planning-pending-list');
      if (untestedContainer) untestedContainer.innerHTML = '<div style="color:var(--text-secondary); font-size:13px; text-align:center; padding:24px;">No programs created yet.</div>';
      if (pendingContainer) pendingContainer.innerHTML = '<div style="color:var(--text-secondary); font-size:13px; text-align:center; padding:24px;">No programs created yet.</div>';
      return;
    }

    const componentFilterEl = document.getElementById('planning-component-filter');
    if (componentFilterEl && componentFilterEl.options.length <= 1) {
      populateComponentFilters();
    }
    const componentFilter = componentFilterEl ? componentFilterEl.value : 'ALL';

    const searchUntestedEl = document.getElementById('search-planning-untested');
    const searchPendingEl = document.getElementById('search-planning-pending');
    const qUntested = searchUntestedEl ? searchUntestedEl.value.toLowerCase() : '';
    const qPending = searchPendingEl ? searchPendingEl.value.toLowerCase() : '';

    // 1. Requirements for selected program
    const progReqs = state.requirements.filter(r => r.programId === selectedProgramId);
    
    // Helper to determine if a requirement has tests
    const hasTests = r => state.tests.some(t => 
      t.programId === r.programId && 
      t.requirementIds && 
      t.requirementIds.includes(r.id)
    );

    // Filter Untested Requirements (Gaps)
    const untestedReqs = progReqs.filter(r => !hasTests(r));
    
    // Filter by component
    let filteredUntested = untestedReqs.filter(r => {
      const compMatch = componentFilter === 'ALL' || r.component === componentFilter;
      const searchMatch = r.id.toLowerCase().includes(qUntested) || 
                          r.description.toLowerCase().includes(qUntested) ||
                          (r.component && r.component.toLowerCase().includes(qUntested));
      return compMatch && searchMatch;
    });

    // Filter Pending/In Progress Tests for selected program
    const progTests = state.tests.filter(t => t.programId === selectedProgramId);
    const pendingTests = progTests.filter(t => t.status !== 'Passed');

    // Filter pending tests by component and search query
    let filteredPending = pendingTests.filter(t => {
      // Filter by component
      const compMatch = componentFilter === 'ALL' || t.component === componentFilter;

      const searchMatch = t.name.toLowerCase().includes(qPending) || 
                          t.id.toLowerCase().includes(qPending) ||
                          t.type.toLowerCase().includes(qPending) ||
                          (t.programDescription && t.programDescription.toLowerCase().includes(qPending)) ||
                          (t.requirementIds || []).some(reqId => reqId.toLowerCase().includes(qPending));
      
      return compMatch && searchMatch;
    });

    // Update statistics
    const totalReqsCount = progReqs.length;
    const testedReqsCount = progReqs.filter(r => hasTests(r)).length;
    const coveragePct = totalReqsCount > 0 ? Math.round((testedReqsCount / totalReqsCount) * 100) : 0;
    
    const backlogDaysSum = pendingTests.reduce((sum, t) => sum + (t.estimate || 0), 0);
    const formattedBacklogDays = backlogDaysSum.toFixed(1).replace(/\.0$/, '');
    
    const totalTestsSum = progTests.reduce((sum, t) => sum + (t.estimate || 0), 0);
    const completedTestsSum = progTests.filter(t => t.status === 'Passed').reduce((sum, t) => sum + (t.estimate || 0), 0);

    const coverageEl = document.getElementById('planning-stat-coverage');
    const coverageSubEl = document.getElementById('planning-stat-coverage-sub');
    const gapsEl = document.getElementById('planning-stat-gaps');
    const backlogEl = document.getElementById('planning-stat-backlog');
    const backlogSubEl = document.getElementById('planning-stat-backlog-sub');
    const totalTimeEl = document.getElementById('planning-stat-total-time');
    const totalTimeSubEl = document.getElementById('planning-stat-total-time-sub');

    if (coverageEl) coverageEl.innerText = `${coveragePct}%`;
    if (coverageSubEl) coverageSubEl.innerText = `${testedReqsCount} / ${totalReqsCount} requirements covered`;
    if (gapsEl) gapsEl.innerText = untestedReqs.length;
    if (backlogEl) backlogEl.innerText = pendingTests.length;
    if (backlogSubEl) backlogSubEl.innerText = `${pendingTests.length} tests (${formattedBacklogDays}d remaining)`;
    
    if (totalTimeEl) totalTimeEl.innerText = `${totalTestsSum.toFixed(1).replace(/\.0$/, '')}d`;
    if (totalTimeSubEl) totalTimeSubEl.innerText = `${completedTestsSum.toFixed(1).replace(/\.0$/, '')}d completed / ${totalTestsSum.toFixed(1).replace(/\.0$/, '')}d total`;
    
    const untestedCountEl = document.getElementById('planning-untested-count');
    const pendingCountEl = document.getElementById('planning-pending-count');
    if (untestedCountEl) untestedCountEl.innerText = untestedReqs.length;
    if (pendingCountEl) pendingCountEl.innerText = pendingTests.length;

    // Render Untested Requirements Cards
    const untestedContainer = document.getElementById('planning-untested-list');
    if (untestedContainer) {
      if (filteredUntested.length === 0) {
        untestedContainer.innerHTML = '<div style="color:var(--text-secondary); font-size:13px; text-align:center; padding:32px; border:1px dashed var(--border-color); border-radius:8px; background-color:var(--bg-canvas);">No untested requirements match the filters.</div>';
      } else {
        untestedContainer.innerHTML = filteredUntested.map(r => `
          <div class="backlog-card">
            <div class="backlog-card-header">
              <span class="backlog-card-title">${escapeHTML(r.id)}</span>
              <span class="badge" style="background-color: var(--border-color); color: var(--text-secondary); font-size: 9px; padding: 2px 6px; font-weight: 700; border-radius: 4px;">${escapeHTML(r.component || 'SE')}</span>
            </div>
            <p class="backlog-card-desc">${escapeHTML(r.description)}</p>
            <div class="backlog-card-footer" style="justify-content: flex-end;">
              <button class="btn btn-primary btn-sm" data-program-id="${escapeHTML(r.programId)}" data-req-id="${escapeHTML(r.id)}" onclick="ReqApp.createTestForReq(this.dataset.programId, this.dataset.reqId)" style="font-size:11px; font-weight:700; padding: 4px 10px;">
                + Create Test
              </button>
            </div>
          </div>
        `).join('');
      }
    }

    // Render Pending Tests Cards
    const pendingContainer = document.getElementById('planning-pending-list');
    if (pendingContainer) {
      if (filteredPending.length === 0) {
        pendingContainer.innerHTML = '<div style="color:var(--text-secondary); font-size:13px; text-align:center; padding:32px; border:1px dashed var(--border-color); border-radius:8px; background-color:var(--bg-canvas);">No planned tests match the filters.</div>';
      } else {
        pendingContainer.innerHTML = filteredPending.map(t => {
          const reqsBadges = (t.requirementIds || []).map(reqId => {
            const req = state.requirements.find(r => r.id === reqId);
            const compText = req ? ` [${req.component}]` : '';
            return `
              <span class="badge badge-pending drill-link" data-req-id="${escapeHTML(reqId)}" onclick="ReqApp.drillTo('requirements', this.dataset.reqId)" style="font-size: 9px; margin-right:2px;" title="View requirement: ${escapeHTML(reqId)}">
                ${escapeHTML(reqId)}${compText}
              </span>
            `;
          }).join('') || '<em style="color:var(--status-failed); font-size:11px;">Unlinked</em>';

          return `
            <div class="backlog-card">
              <div class="backlog-card-header">
                <div class="backlog-card-title drill-link" data-test-id="${escapeHTML(t.id)}" onclick="ReqApp.drillTo('tests', this.dataset.testId)" title="View test detail">${escapeHTML(t.name)}</div>
                <div style="display: flex; gap: 4px; align-items: center;">
                  <span class="badge" style="background-color: var(--border-color); color: var(--text-primary); font-size: 9px; padding: 2px 6px; font-weight:700;">${escapeHTML(t.type)}</span>
                  <span class="badge" style="background-color: var(--border-color); color: var(--text-secondary); font-size: 9px; padding: 2px 6px; font-weight:700; border-radius: 4px;">${escapeHTML(t.component || 'SE')}</span>
                  <span class="badge" style="background-color: rgba(37, 99, 235, 0.08); color: var(--accent-color); border: 1px solid rgba(37, 99, 235, 0.15); font-size: 9px; padding: 2px 6px; font-weight:700; display: inline-flex; align-items: center; gap: 2px;">
                    ⏱️ ${(t.estimate !== undefined ? t.estimate : 0).toFixed(1).replace(/\.0$/, '')}d
                  </span>
                </div>
              </div>
              <p class="backlog-card-desc" style="margin-bottom:0;">${escapeHTML(t.programDescription || 'No description.')}</p>
              ${t.notes ? `<div style="font-size:11px; color:var(--text-secondary); font-style:italic; margin-top:6px; background:var(--bg-canvas); padding:4px 8px; border-radius:4px; border-left:2px solid var(--accent-color-light);">✍️ Note: ${escapeHTML(t.notes)}</div>` : ''}
              <div style="font-size:11px; margin-top:2px;">
                <span style="color:var(--text-secondary); font-weight:600;">Covers:</span>
                <div style="display:inline-flex; flex-wrap:wrap; gap:4px; margin-left:4px; vertical-align:middle;">
                  ${reqsBadges}
                </div>
              </div>
              <div class="backlog-card-footer">
                <div style="display:flex; align-items:center; gap:6px;">
                  <span style="font-size:11px; color:var(--text-secondary); font-weight:600;">Outcome:</span>
                  ${(() => {
                    const isSubtaskType = t.type === 'SIL' || t.type === 'HIL' || t.type === 'Monte Carlo';
                    if (isSubtaskType) {
                      const sub = t.subtasks || {};
                      const subList = Object.keys(sub).map(k => `${k} (${sub[k]})`).join(', ');
                      let badgeClass = 'badge-not-started';
                      if (t.status === 'Passed') badgeClass = 'badge-passed';
                      else if (t.status === 'In Progress') badgeClass = 'badge-in-progress';
                      return `<span class="badge ${badgeClass}" style="font-size: 11px; padding: 2px 6px; font-weight: 700; cursor: help;" title="Derived from subtasks: ${escapeHTML(subList)}. Click Edit to change.">${t.status}</span>`;
                    } else {
                      return `
                        <select class="select-filter btn-sm ${t.status === 'Passed' ? 'select-status-passed' : t.status === 'In Progress' ? 'select-status-inprogress' : 'select-status-notstarted'}" style="font-size:11px; padding:2px 8px;" data-test-id="${escapeHTML(t.id)}" onchange="ReqApp.toggleTestOutcome(this.dataset.testId, this.value)">
                          <option value="Not Started" ${t.status === 'Not Started' ? 'selected' : ''}>Not Started</option>
                          <option value="In Progress" ${t.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
                          <option value="Passed" ${t.status === 'Passed' ? 'selected' : ''}>Passed</option>
                        </select>
                      `;
                    }
                  })()}
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                  ${(() => {
                    const assignee = t.assigneeId ? state.teamMembers.find(tm => tm.id === t.assigneeId) : null;
                    return assignee
                      ? `<span class="assignee-avatar-badge" style="background-color: ${assignee.color};" data-test-id="${escapeHTML(t.id)}" onclick="ReqApp.openModal('test-modal', this.dataset.testId)" title="Assigned to ${escapeHTML(assignee.name)}. Click to change.">${escapeHTML(assignee.initials)}</span>`
                      : `<span class="assignee-avatar-badge unassigned" data-test-id="${escapeHTML(t.id)}" onclick="ReqApp.openModal('test-modal', this.dataset.testId)" title="Unassigned. Click to assign.">&#128100;</span>`;
                  })()}
                  <button class="btn btn-secondary btn-sm" data-test-id="${escapeHTML(t.id)}" onclick="ReqApp.openModal('test-modal', this.dataset.testId)" style="font-size:11px; font-weight:700; padding: 4px 10px;">
                    Edit
                  </button>
                </div>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  }

  // RENDER: PROGRAMS VIEW (MASTER-DETAIL SPLIT)
  function renderPrograms() {
    const sidebar = document.getElementById('programs-sidebar-list');
    const detailPanel = document.getElementById('program-detail-panel');
    if (!sidebar || !detailPanel) return;

    // 1. Sidebar List
    if (state.programs.length === 0) {
      sidebar.innerHTML = '<p style="color:var(--text-secondary); font-size:13px;">No programs created yet.</p>';
      detailPanel.innerHTML = `
        <div style="text-align: center; margin-top: 100px; color: var(--text-secondary);">
          <h3>No Programs Available</h3>
          <p>Create a program using the button on the top right to start tracking compliance.</p>
        </div>
      `;
      return;
    }

    // Default selection
    if (!selectedProgramId || !state.programs.some(p => p.id === selectedProgramId)) {
      selectedProgramId = state.programs[0].id;
    }

    sidebar.innerHTML = state.programs.map(p => {
      const progReqs = state.requirements.filter(r => r.programId === p.id);
      const passedCount = progReqs.filter(r => r.status === 'Passed').length;
      const totalCount = progReqs.length;
      const pct = totalCount > 0 ? Math.round((passedCount / totalCount) * 100) : 0;
      
      const unlinkedCount = progReqs.filter(r => 
        !state.tests.some(t => t.programId === r.programId && t.requirementIds && t.requirementIds.includes(r.id))
      ).length;
      const unwrittenCount = state.tests.filter(t => t.programId === p.id && t.status === 'Not Started').length;

      let alertsHtml = '';
      if (unlinkedCount > 0 || unwrittenCount > 0) {
        alertsHtml = `
          <div style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">
            ${unlinkedCount > 0 ? `
              <span data-program-id="${escapeHTML(p.id)}" onclick="event.stopPropagation(); ReqApp.drillTo('planning', this.dataset.programId)" style="background-color:rgba(239, 68, 68, 0.08); color:#EF4444; border:1px solid rgba(239, 68, 68, 0.15); font-size:9px; font-weight:700; padding:1px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px; cursor:pointer;" title="${unlinkedCount} requirements lack verification tests. Click to open Planning Desk.">
                ⚠️ ${unlinkedCount} Untested
              </span>` : ''}
            ${unwrittenCount > 0 ? `
              <span data-program-id="${escapeHTML(p.id)}" onclick="event.stopPropagation(); ReqApp.drillTo('planning', this.dataset.programId)" style="background-color:rgba(245, 158, 11, 0.08); color:#D97706; border:1px solid rgba(245, 158, 11, 0.15); font-size:9px; font-weight:700; padding:1px 6px; border-radius:4px; display:inline-flex; align-items:center; gap:2px; cursor:pointer;" title="${unwrittenCount} planned tests need to be written. Click to open Planning Desk.">
                📋 ${unwrittenCount} Planned
              </span>` : ''}
          </div>
        `;
      }

      const isActive = p.id === selectedProgramId ? 'active' : '';
      
      return `
        <button class="program-card-item ${isActive}" data-program-id="${escapeHTML(p.id)}" onclick="ReqApp.selectProgram(this.dataset.programId)">
          <div style="font-weight: 700; font-size: 14px; color: var(--text-primary);">${escapeHTML(p.name)}</div>
          <div style="font-size: 11px; color: var(--text-secondary);">${escapeHTML(p.id)}</div>
          <div class="mini-progress-bar-bg">
            <div class="mini-progress-bar-fill" style="width: ${pct}%;"></div>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--text-secondary); margin-top:4px;">
            <span>${passedCount}/${totalCount} Passed</span>
            <span>${pct}%</span>
          </div>
          ${alertsHtml}
        </button>
      `;
    }).join('');

    // 2. Details Panel
    const prog = state.programs.find(p => p.id === selectedProgramId);
    if (!prog) return;

    const progReqs = state.requirements.filter(r => r.programId === prog.id);
    const passedCount = progReqs.filter(r => r.status === 'Passed').length;
    const totalCount = progReqs.length;
    const pct = totalCount > 0 ? Math.round((passedCount / totalCount) * 100) : 0;

    const hasTests = r => state.tests.some(t => 
      t.programId === r.programId && 
      t.requirementIds && 
      t.requirementIds.includes(r.id)
    );
    const testedReqsCount = progReqs.filter(r => hasTests(r)).length;
    const coveragePct = totalCount > 0 ? Math.round((testedReqsCount / totalCount) * 100) : 0;

    const unlinkedReqs = progReqs.filter(r => !hasTests(r));
    const unwrittenTests = state.tests.filter(t => t.programId === prog.id && t.status === 'Not Started');

    const progTests = state.tests.filter(t => t.programId === prog.id);
    const pendingTests = progTests.filter(t => t.status !== 'Passed');
    const totalTestsSum = progTests.reduce((sum, t) => sum + (t.estimate || 0), 0);
    const completedTestsSum = progTests.filter(t => t.status === 'Passed').reduce((sum, t) => sum + (t.estimate || 0), 0);
    const backlogDaysSum = pendingTests.reduce((sum, t) => sum + (t.estimate || 0), 0);
    const formattedBacklogDays = backlogDaysSum.toFixed(1).replace(/\.0$/, '');

    // Group requirements by status
    const reqsTableRows = progReqs.length > 0 
      ? progReqs.map(r => {
          const cap = state.capabilities.find(c => c.id === r.capabilityId);
          
          // Find tests in the same program linking to this requirement
          const linkedTests = state.tests.filter(t => 
            t.programId === r.programId && 
            t.requirementIds && 
            t.requirementIds.includes(r.id)
          );
          
          let testsLinks = '<em style="color:var(--status-failed);">Unlinked</em>';
          if (linkedTests.length > 0) {
            testsLinks = linkedTests.map(t => `<span class="drill-link" data-test-id="${escapeHTML(t.id)}" onclick="ReqApp.drillTo('tests', this.dataset.testId)" title="View test: ${escapeHTML(t.name)}">${escapeHTML(t.name)}</span>`).join(', ');
          } else {
            const sources = getInheritedPassSource(r);
            if (sources && sources.length > 0) {
              testsLinks = `
                <div style="font-size: 11px; line-height: 1.3; background: var(--status-inherited-bg); border: 1px solid var(--status-inherited-border); border-radius: 6px; padding: 4px 8px; margin-top: 2px;">
                  <span style="color: var(--status-inherited); font-weight: 700; font-size: 9px; text-transform: uppercase; display: block; margin-bottom: 2px;">Inherited Pass</span>
                  <div style="color: var(--text-secondary); font-size: 10px;">
                    ${sources.map(src => {
                      const testText = src.testName 
                        ? `<span class="drill-link" data-test-id="${escapeHTML(src.testId)}" onclick="ReqApp.drillTo('tests', this.dataset.testId)" style="font-weight:600;">${escapeHTML(src.testName)}</span>`
                        : `Req ${escapeHTML(src.requirementId)}`;
                      const progText = `<span class="drill-link" data-program-id="${escapeHTML(src.programId)}" onclick="ReqApp.drillTo('programs', this.dataset.programId)" style="font-style: italic;">${escapeHTML(src.programName)}</span>`;
                      return `<div style="margin: 2px 0;">${testText}<br><span style="font-size:9px;">in ${progText}</span></div>`;
                    }).join('')}
                  </div>
                </div>
              `;
            }
          }
          
          let badgeClass = 'badge-not-started';
          if (r.status === 'Passed') {
            badgeClass = r.inheritPassFromCapability && r.baseStatus !== 'Passed' ? 'badge-inherited' : 'badge-passed';
          } else if (r.status === 'In Progress') {
            badgeClass = 'badge-in-progress';
          }

          return `
            <tr>
              <td>
                <span class="drill-link" data-req-id="${escapeHTML(r.id)}" onclick="ReqApp.drillTo('requirements', this.dataset.reqId)" title="Drill into requirement detail">${escapeHTML(r.id)}</span>
                <span class="badge" style="background-color: var(--border-color); color: var(--text-secondary); font-size: 9px; padding: 2px 4px; margin-left: 6px; font-weight: 700; border-radius: 4px;">${escapeHTML(r.component || 'SE')}</span>
              </td>
              <td>
                <div class="statement-cell" style="max-width: 320px;">
                  ${escapeHTML(r.description)}
                </div>
              </td>
              <td>
                ${cap ? `<span class="drill-link" data-cap-id="${escapeHTML(cap.id)}" onclick="ReqApp.drillTo('capabilities', this.dataset.capId)">${escapeHTML(cap.id)}</span>` : '<span style="color:var(--text-secondary); font-size:12px;">None</span>'}
              </td>
              <td>
                ${testsLinks}
              </td>
              <td><span class="badge ${badgeClass}">${escapeHTML(r.status)}</span></td>
            </tr>
          `;
        }).join('')
      : `<tr><td colspan="5" style="text-align:center; padding: 24px; color:var(--text-secondary);">No requirements linked to this program yet.</td></tr>`;

    // Render capability summaries linked to this program
    const uniqueCaps = [];
    progReqs.forEach(r => {
      if (r.capabilityId && !uniqueCaps.some(c => c.id === r.capabilityId)) {
        const c = state.capabilities.find(cap => cap.id === r.capabilityId);
        if (c) uniqueCaps.push(c);
      }
    });

    const capsSummaryHtml = uniqueCaps.length > 0
      ? uniqueCaps.map(c => {
          const badgeClass = c.status === 'Passed' ? 'badge-passed' : c.status === 'In Progress' ? 'badge-in-progress' : 'badge-not-started';
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background-color:var(--bg-canvas); border:1px solid var(--border-color); border-radius:8px; font-size:13px;">
              <span class="drill-link" data-cap-id="${escapeHTML(c.id)}" onclick="ReqApp.drillTo('capabilities', this.dataset.capId)">${escapeHTML(c.id)}</span>
              <span class="badge ${badgeClass}">${c.status}</span>
            </div>
          `;
        }).join('')
      : '<p style="color:var(--text-secondary); font-size:13px;">No shared capabilities linked to this program.</p>';

    // Set scrolling behavior based on active tab
    if (selectedProgramTab === 'planning') {
      detailPanel.style.overflowY = 'hidden';
    } else {
      detailPanel.style.overflowY = 'auto';
    }

    const headerHtml = `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--border-color); padding-bottom:16px; flex-shrink:0; gap:16px; flex-wrap:nowrap;">
        <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap; flex-grow:1; min-width:0;">
          <div style="display:flex; align-items:center; gap:12px; flex-shrink:0;">
            <!-- Toggle Sidebar Button -->
            <button class="btn btn-secondary btn-sm" onclick="ReqApp.toggleProgramsSidebar()" style="padding: 6px; display: inline-flex; align-items: center; justify-content: center; height: 32px; width: 32px; flex-shrink: 0;" title="Toggle Programs List Sidebar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="9" y1="3" x2="9" y2="21"></line>
              </svg>
            </button>
            <div style="min-width:0; max-width:220px;">
              <h2 style="font-family:'Outfit', sans-serif; font-size:22px; font-weight:800; margin:0; line-height:1.2; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;" title="${escapeHTML(prog.name)}">${escapeHTML(prog.name)}</h2>
              <span style="font-size:11px; color:var(--text-secondary); font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">ID: ${escapeHTML(prog.id)}</span>
            </div>
          </div>
          
          <!-- Compact Metric Cards -->
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <!-- 1. Requirements Coverage -->
            <div class="header-metric-card ${coveragePct === 100 ? 'coverage-full' : 'coverage-partial'}" title="${testedReqsCount} / ${totalCount} requirements covered by tests">
              <span class="card-label">Coverage:</span>
              <span class="card-value">${coveragePct}%</span>
              <span class="card-subtext">(${testedReqsCount}/${totalCount})</span>
            </div>

            <!-- 2. Verification Gaps -->
            <div onclick="ReqApp.switchProgramTab('planning')" class="header-metric-card clickable-header-card ${unlinkedReqs.length > 0 ? 'gaps-warning' : 'no-gaps'}" title="${unlinkedReqs.length > 0 ? `${unlinkedReqs.length} requirements lack verification tests. Click to open Planning Workbench.` : 'All requirements covered!'}">
              <span class="card-label">Gaps:</span>
              <span class="card-value">${unlinkedReqs.length}</span>
              <span class="card-subtext">${unlinkedReqs.length > 0 ? '(Triage)' : '(All covered)'}</span>
            </div>

            <!-- 3. Planned Backlog -->
            <div onclick="ReqApp.switchProgramTab('planning')" class="header-metric-card clickable-header-card ${unwrittenTests.length > 0 ? 'backlog-warning' : 'no-gaps'}" title="${unwrittenTests.length > 0 ? `${unwrittenTests.length} tests in backlog. Click to open Planning Workbench.` : 'No backlog!'}">
              <span class="card-label">Backlog:</span>
              <span class="card-value">${unwrittenTests.length}</span>
              <span class="card-subtext">${unwrittenTests.length > 0 ? '(Planned)' : '(All started)'}</span>
            </div>

            <!-- 4. Effort -->
            <div class="header-metric-card effort-neutral" title="${completedTestsSum.toFixed(1).replace(/\.0$/, '')}d completed / ${totalTestsSum.toFixed(1).replace(/\.0$/, '')}d total estimated effort">
              <span class="card-label">Effort:</span>
              <span class="card-value">${totalTestsSum.toFixed(1).replace(/\.0$/, '')}d</span>
              <span class="card-subtext">(${completedTestsSum.toFixed(1).replace(/\.0$/, '')}d done)</span>
            </div>
          </div>
        </div>
        
        <div style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
          <button class="btn btn-primary btn-sm" data-program-id="${escapeHTML(prog.id)}" onclick="ReqApp.printProgramReport(this.dataset.programId)" style="display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px;" title="Print Program Status Report to PDF">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 6 2 18 2 18 9"></polyline>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
              <rect x="6" y="14" width="12" height="8"></rect>
            </svg>
            <span>Print Report</span>
          </button>
          
          <div style="position:relative; display:inline-block;">
            <button class="btn btn-secondary btn-sm" id="program-actions-btn" onclick="ReqApp.toggleProgramDropdown(event)" style="padding:0; width:32px; height:32px; display:inline-flex; align-items:center; justify-content:center; font-size:16px; font-weight:bold;" title="More Actions">
              ⋯
            </button>
            <div id="program-actions-dropdown" class="dropdown-menu-floating" style="display:none; position:absolute; right:0; top:100%; margin-top:6px; z-index:1000; min-width:160px; border-radius:6px; padding:4px 0;">
              <button class="dropdown-item-btn" onclick="ReqApp.exportProgramCSV('${escapeHTML(prog.id)}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-right:8px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line></svg>
                Export CSV
              </button>
              <button class="dropdown-item-btn" onclick="ReqApp.openModal('program-modal', '${escapeHTML(prog.id)}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-right:8px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                Edit Program
              </button>
              <div style="border-top: 1px solid var(--border-color); margin:4px 0;"></div>
              <button class="dropdown-item-btn dropdown-item-danger" onclick="ReqApp.deleteProgram('${escapeHTML(prog.id)}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-right:8px; stroke:currentColor;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                Delete Program
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-tabs" style="margin-top: 15px; margin-bottom: 15px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; padding-bottom: 6px;">
        <div style="display: flex; gap: 8px;">
          <button id="tab-btn-program-overview" class="modal-tab-btn ${selectedProgramTab === 'overview' ? 'active' : ''}" onclick="ReqApp.switchProgramTab('overview')">
            Overview & Matrix
          </button>
          <button id="tab-btn-program-planning" class="modal-tab-btn ${selectedProgramTab === 'planning' ? 'active' : ''}" onclick="ReqApp.switchProgramTab('planning')">
            Planning Workbench
          </button>
        </div>
        ${selectedProgramTab === 'planning' ? `
          <div style="display: flex; align-items: center; gap: 6px;">
            <label class="form-label" for="planning-component-filter" style="margin-bottom: 0; white-space: nowrap; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-secondary); letter-spacing: 0.5px;">Filter Component:</label>
            <select class="select-filter" id="planning-component-filter" onchange="ReqApp.renderPlanning()" style="padding: 4px 8px; font-size: 11px; height: 26px; min-width: 130px;">
              <option value="ALL">All Components</option>
            </select>
          </div>
        ` : ''}
      </div>
    `;

    if (selectedProgramTab === 'overview') {
      detailPanel.innerHTML = headerHtml + `
        <div style="margin-top: 12px; margin-bottom: 16px;">
          <h3 style="font-size:13px; font-weight:600; text-transform:uppercase; color:var(--text-secondary); margin-bottom:6px;">Description</h3>
          <p style="font-size:14px; line-height:1.6; color:var(--text-primary); margin:0;">${escapeHTML(prog.description || 'No description provided.')}</p>
        </div>

        <div style="margin-top:10px;">
          <h3 style="font-size:13px; font-weight:700; text-transform:uppercase; color:var(--text-secondary); margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
            <span>Program Requirements</span>
            <div style="display:flex; gap:8px;">
              <button class="btn btn-secondary btn-sm" data-program-id="${escapeHTML(prog.id)}" onclick="ReqApp.openImportRequirementsModal(this.dataset.programId)" style="font-size:11px; padding:4px 8px;">📂 Import</button>
              <button class="btn btn-primary btn-sm" onclick="ReqApp.openModal('requirement-modal')" style="font-size:11px; padding:4px 8px;">+ Add Requirement</button>
            </div>
          </h3>
          <div class="table-wrapper">
            <table class="custom-table" style="font-size:13px;">
              <thead>
                <tr>
                  <th scope="col" style="width:100px;">Req ID</th>
                  <th scope="col">Statement</th>
                  <th scope="col">Shared Capability</th>
                  <th scope="col">Verification Test</th>
                  <th scope="col" style="width:110px;">Status</th>
                </tr>
              </thead>
              <tbody>
                ${reqsTableRows}
              </tbody>
            </table>
          </div>
        </div>

        <div style="margin-top:10px;">
          <h3 style="font-size:13px; font-weight:700; text-transform:uppercase; color:var(--text-secondary); margin-bottom:12px;">Associated Shared Capabilities</h3>
          <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:12px;">
            ${capsSummaryHtml}
          </div>
        </div>
      `;
    } else if (selectedProgramTab === 'planning') {
      detailPanel.innerHTML = headerHtml + `
        <!-- Dual-Column Cockpit Layout -->
        <div class="planning-split-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; flex-grow: 1; overflow: hidden; min-height: 0;">
          <!-- Untested Requirements Column -->
          <div class="backlog-column-wrapper" style="display: flex; flex-direction: column; gap: 12px; height: 100%; overflow: hidden;">
            <div class="backlog-column-header" style="background-color: rgba(239, 68, 68, 0.03); border: 1px dashed rgba(239, 68, 68, 0.25); border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;">
              <h3 style="font-size: 12px; font-weight: 700; color: #EF4444; display: flex; align-items: center; gap: 6px; margin: 0; text-transform: uppercase; letter-spacing: 0.5px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                <span>Untested Requirements (<span id="planning-untested-count">0</span>)</span>
              </h3>
            </div>
            <div class="search-input-wrapper" style="flex: none; max-width: 100%; margin-bottom: 2px;">
              <span class="search-icon" aria-hidden="true">&#128269;</span>
              <input type="search" class="search-input" id="search-planning-untested" placeholder="Search untested requirements..." oninput="ReqApp.renderPlanning()" style="font-size:12px; padding: 6px 12px 6px 36px;">
            </div>
            <div id="planning-untested-list" style="display: flex; flex-direction: column; gap: 10px; flex-grow: 1; overflow-y: auto; padding-right: 4px; padding-bottom: 20px;">
              <!-- Dynamically populated cards -->
            </div>
          </div>

          <!-- Test Execution Backlog Column -->
          <div class="backlog-column-wrapper" style="display: flex; flex-direction: column; gap: 12px; height: 100%; overflow: hidden;">
            <div class="backlog-column-header" style="background-color: rgba(217, 119, 6, 0.03); border: 1px dashed rgba(217, 119, 6, 0.25); border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;">
              <h3 style="font-size: 12px; font-weight: 700; color: #D97706; display: flex; align-items: center; gap: 6px; margin: 0; text-transform: uppercase; letter-spacing: 0.5px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                <span>Test Backlog (<span id="planning-pending-count">0</span>)</span>
              </h3>
            </div>
            <div class="search-input-wrapper" style="flex: none; max-width: 100%; margin-bottom: 2px;">
              <span class="search-icon" aria-hidden="true">&#128269;</span>
              <input type="search" class="search-input" id="search-planning-pending" placeholder="Search test backlog..." oninput="ReqApp.renderPlanning()" style="font-size:12px; padding: 6px 12px 6px 36px;">
            </div>
            <div id="planning-pending-list" style="display: flex; flex-direction: column; gap: 10px; flex-grow: 1; overflow-y: auto; padding-right: 4px; padding-bottom: 20px;">
              <!-- Dynamically populated cards -->
            </div>
          </div>
        </div>
      `;
      renderPlanning();
    }
  }

  // RENDER: REQUIREMENTS VIEW (GRID OR COMPACT Dense LIST)
  function renderRequirements() {
    const q = document.getElementById('search-requirements').value.toLowerCase();
    const filterProg = document.getElementById('filter-req-program').value;
    const filterStatus = document.getElementById('filter-req-status').value;
    const filterComponent = document.getElementById('filter-req-component') ? document.getElementById('filter-req-component').value : 'ALL';
    const contentArea = document.getElementById('requirements-view-content');
    if (!contentArea) return;

    let filtered = state.requirements.filter(r => {
      const textMatch = r.id.toLowerCase().includes(q) || 
                        r.description.toLowerCase().includes(q) ||
                        (r.component && r.component.toLowerCase().includes(q));
      const progMatch = filterProg === 'ALL' || r.programId === filterProg;
      const statusMatch = filterStatus === 'ALL' || r.status === filterStatus;
      const componentMatch = filterComponent === 'ALL' || r.component === filterComponent;
      return textMatch && progMatch && statusMatch && componentMatch;
    });

    // Handle empty views
    if (filtered.length === 0) {
      contentArea.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 48px; background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px;">No requirements found.</div>';
      return;
    }

    if (reqViewMode === 'grid') {
      // 1. Render Card Grid (Classic UI)
      contentArea.className = 'req-grid';
      contentArea.innerHTML = filtered.map(r => {
        const prog = state.programs.find(p => p.id === r.programId);
        const cap = state.capabilities.find(c => c.id === r.capabilityId);
        
        // Find tests in the same program linking to this requirement
        const linkedTests = state.tests.filter(t => 
          t.programId === r.programId && 
          t.requirementIds && 
          t.requirementIds.includes(r.id)
        );
        
        let testsLinks = '';
        if (linkedTests.length > 0) {
          testsLinks = linkedTests.map(t => `<span class="drill-link" data-test-id="${escapeHTML(t.id)}" onclick="ReqApp.drillTo('tests', this.dataset.testId); event.stopPropagation();" title="View test: ${escapeHTML(t.name)}">${escapeHTML(t.name)} (${t.status})</span>`).join(', ');
        } else {
          const sources = getInheritedPassSource(r);
          if (sources && sources.length > 0) {
            testsLinks = `
              <div style="font-size: 11px; line-height: 1.3; background: var(--status-inherited-bg); border: 1px solid var(--status-inherited-border); border-radius: 6px; padding: 6px 10px; margin-top: 4px;" onclick="event.stopPropagation();">
                <span style="color: var(--status-inherited); font-weight: 700; font-size: 9px; text-transform: uppercase; display: block; margin-bottom: 2px;">Inherited Pass</span>
                <div style="color: var(--text-secondary); font-size: 10px;">
                  ${sources.map(src => {
                    const testText = src.testName 
                      ? `<span class="drill-link" data-test-id="${escapeHTML(src.testId)}" onclick="ReqApp.drillTo('tests', this.dataset.testId); event.stopPropagation();" style="font-weight:600;">${escapeHTML(src.testName)}</span>`
                      : `Req ${escapeHTML(src.requirementId)}`;
                    const progText = `<span class="drill-link" data-program-id="${escapeHTML(src.programId)}" onclick="ReqApp.drillTo('programs', this.dataset.programId); event.stopPropagation();" style="font-style: italic;">${escapeHTML(src.programName)}</span>`;
                    return `<div style="margin: 2px 0;">${testText}<br><span style="font-size:9px;">in ${progText}</span></div>`;
                  }).join('')}
                </div>
              </div>
            `;
          } else {
            testsLinks = `
              <div style="display:inline-flex; align-items:center; gap:6px;" onclick="event.stopPropagation();">
                <em style="color:var(--status-failed); font-style:normal;">Unlinked</em>
                <button class="btn btn-primary btn-sm" data-program-id="${escapeHTML(r.programId)}" data-req-id="${escapeHTML(r.id)}" onclick="ReqApp.createTestForReq(this.dataset.programId, this.dataset.reqId); event.stopPropagation();" style="font-size: 9px; padding: 2px 6px; font-weight:700; line-height:1; height:auto; border-radius:4px;" title="Create new test">+ Test</button>
                <button class="btn btn-secondary btn-sm" data-req-id="${escapeHTML(r.id)}" onclick="ReqApp.openLinkTestModal(this.dataset.reqId); event.stopPropagation();" style="font-size: 9px; padding: 2px 6px; font-weight:700; line-height:1; height:auto; border-radius:4px;" title="Link existing test">&#128279; Link</button>
              </div>
            `;
          }
        }
        
        let badgeClass = 'badge-not-started';
        if (r.status === 'Passed') badgeClass = 'badge-passed';
        else if (r.status === 'In Progress') badgeClass = 'badge-in-progress';

        const isInherited = r.inheritPassFromCapability && r.status === 'Passed' && r.baseStatus !== 'Passed';
        const actualBadgeClass = isInherited ? 'badge-inherited' : badgeClass;
        const statusLabel = isInherited ? 'PASSED (INHERITED)' : r.status;

        const notesHtml = r.notes
          ? `<div class="req-notes-box" style="margin-top:8px; padding:6px 10px; background-color:var(--bg-canvas); border-left:3px solid var(--accent-color-light); border-radius:4px; font-size:11px; color:var(--text-secondary); font-style:italic;">
               ✍️ Notes: ${escapeHTML(r.notes)}
             </div>`
          : '';

        return `
          <div class="req-card" style="cursor: pointer;" data-req-id="${escapeHTML(r.id)}" onclick="ReqApp.openModal('requirement-modal', this.dataset.reqId)">
            ${isInherited ? `<div class="req-inheritance-indicator" title="Fulfill status inherited from a passed Capability"></div>` : ''}
            <div>
              <div class="req-card-header">
                <span class="req-id">
                  ${escapeHTML(r.id)}
                  <span class="badge" style="background-color: var(--border-color); color: var(--text-secondary); font-size: 9px; padding: 2px 4px; margin-left: 6px; font-weight: 700; border-radius: 4px;">${escapeHTML(r.component || 'SE')}</span>
                </span>
                <span class="req-program drill-link" data-program-id="${escapeHTML(r.programId)}" onclick="ReqApp.drillTo('programs', this.dataset.programId); event.stopPropagation();" style="cursor:pointer;" title="Go to Program">${escapeHTML(prog ? prog.name : r.programId)}</span>
              </div>
              <p class="req-desc" style="margin-bottom:0;">${escapeHTML(r.description)}</p>
              ${notesHtml}
            </div>
            
            <div class="req-footer">
              <div class="req-footer-line">
                <span class="req-label">Status</span>
                <span class="badge ${actualBadgeClass}" title="${escapeHTML(r.statusReason)}">${statusLabel}</span>
              </div>
              <div class="req-footer-line">
                <span class="req-label">Linked Test(s)</span>
                <span class="req-value">
                  ${testsLinks}
                </span>
              </div>
              <div class="req-footer-line">
                <span class="req-label">Capability Link</span>
                <span class="req-value" title="${cap ? escapeHTML(cap.id) : 'None'}">
                  ${cap ? `<span class="drill-link" data-cap-id="${escapeHTML(cap.id)}" onclick="ReqApp.drillTo('capabilities', this.dataset.capId); event.stopPropagation();">${escapeHTML(cap.id)}</span>` : 'None'}
                </span>
              </div>
              ${r.capabilityId ? `
              <div class="req-footer-line">
                <span class="req-label">Inherit Option</span>
                <span class="req-value" style="font-size:11px;">
                  ${r.inheritPassFromCapability ? '<span style="color:var(--status-inherited); font-weight:600;">ENABLED</span>' : 'DISABLED'}
                </span>
              </div>` : ''}
            </div>
          </div>
        `;
      }).join('');
    } else {
      // 2. Render Compact Dense List (High Density layout for scale)
      contentArea.className = 'table-wrapper';
      const rows = filtered.map(r => {
        const prog = state.programs.find(p => p.id === r.programId);
        const cap = state.capabilities.find(c => c.id === r.capabilityId);
        
        // Find tests in the same program linking to this requirement
        const linkedTests = state.tests.filter(t => 
          t.programId === r.programId && 
          t.requirementIds && 
          t.requirementIds.includes(r.id)
        );
        
        let testsLinks = '';
        if (linkedTests.length > 0) {
          testsLinks = linkedTests.map(t => `<span class="drill-link" data-test-id="${escapeHTML(t.id)}" onclick="ReqApp.drillTo('tests', this.dataset.testId); event.stopPropagation();" title="View test: ${escapeHTML(t.name)}">${escapeHTML(t.name)}</span>`).join(', ');
        } else {
          const sources = getInheritedPassSource(r);
          if (sources && sources.length > 0) {
            testsLinks = `
              <div style="font-size: 11px; line-height: 1.3; background: var(--status-inherited-bg); border: 1px solid var(--status-inherited-border); border-radius: 6px; padding: 4px 8px; display:inline-block;" onclick="event.stopPropagation();">
                <span style="color: var(--status-inherited); font-weight: 700; font-size: 9px; text-transform: uppercase;">Inherited Pass</span>
                <span style="color: var(--text-secondary); font-size: 10px; margin-left: 4px;">
                  ${sources.map(src => {
                    const testText = src.testName 
                      ? `<span class="drill-link" data-test-id="${escapeHTML(src.testId)}" onclick="ReqApp.drillTo('tests', this.dataset.testId); event.stopPropagation();" style="font-weight:600;">${escapeHTML(src.testName)}</span>`
                      : `Req ${escapeHTML(src.requirementId)}`;
                    const progText = `<span class="drill-link" data-program-id="${escapeHTML(src.programId)}" onclick="ReqApp.drillTo('programs', this.dataset.programId); event.stopPropagation();" style="font-style: italic;">${escapeHTML(src.programName)}</span>`;
                    return `${testText} in ${progText}`;
                  }).join(', ')}
                </span>
              </div>
            `;
          } else {
            testsLinks = `
              <div style="display:inline-flex; align-items:center; gap:6px;" onclick="event.stopPropagation();">
                <em style="color:var(--status-failed); font-style:normal; font-size:12px;">Unlinked</em>
                <button class="btn btn-primary btn-sm" data-program-id="${escapeHTML(r.programId)}" data-req-id="${escapeHTML(r.id)}" onclick="ReqApp.createTestForReq(this.dataset.programId, this.dataset.reqId); event.stopPropagation();" style="font-size: 9px; padding: 2px 6px; font-weight:700; line-height:1; height:auto; border-radius:4px;" title="Create new test">+ Test</button>
                <button class="btn btn-secondary btn-sm" data-req-id="${escapeHTML(r.id)}" onclick="ReqApp.openLinkTestModal(this.dataset.reqId); event.stopPropagation();" style="font-size: 9px; padding: 2px 6px; font-weight:700; line-height:1; height:auto; border-radius:4px;" title="Link existing test">&#128279; Link</button>
              </div>
            `;
          }
        }
        
        let badgeClass = 'badge-not-started';
        if (r.status === 'Passed') badgeClass = 'badge-passed';
        else if (r.status === 'In Progress') badgeClass = 'badge-in-progress';

        const isInherited = r.inheritPassFromCapability && r.status === 'Passed' && r.baseStatus !== 'Passed';
        const actualBadgeClass = isInherited ? 'badge-inherited' : badgeClass;
        const statusLabel = isInherited ? 'Passed (Inherited)' : r.status;

        return `
          <tr style="cursor: pointer;" data-req-id="${escapeHTML(r.id)}" onclick="ReqApp.openModal('requirement-modal', this.dataset.reqId)">
            <td>
              <strong style="font-family:'Outfit',sans-serif;">${escapeHTML(r.id)}</strong>
              <span class="badge" style="background-color: var(--border-color); color: var(--text-secondary); font-size: 9px; padding: 2px 4px; margin-left: 6px; font-weight: 700; border-radius: 4px;">${escapeHTML(r.component || 'SE')}</span>
            </td>
            <td>
              <span class="drill-link" data-program-id="${escapeHTML(r.programId)}" onclick="ReqApp.drillTo('programs', this.dataset.programId); event.stopPropagation();">${escapeHTML(prog ? prog.name : r.programId)}</span>
            </td>
            <td>
              <div class="statement-cell">
                <div>${escapeHTML(r.description)}</div>
                ${r.notes ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:4px; font-style:italic; font-weight:normal;">✍️ Notes: ${escapeHTML(r.notes)}</div>` : ''}
              </div>
            </td>
            <td>
              ${cap ? `<span class="drill-link" data-cap-id="${escapeHTML(cap.id)}" onclick="ReqApp.drillTo('capabilities', this.dataset.capId); event.stopPropagation();">${escapeHTML(cap.id)}</span>` : '<span style="color:var(--text-secondary);">None</span>'}
            </td>
            <td>
              ${testsLinks}
            </td>
            <td><span class="badge ${actualBadgeClass}" title="${escapeHTML(r.statusReason)}">${statusLabel}</span></td>
          </tr>
        `;
      }).join('');

      contentArea.innerHTML = `
        <table class="custom-table" style="font-size: 13px;">
          <thead>
            <tr>
              <th scope="col" style="width: 100px;">Req ID</th>
              <th scope="col" style="width: 150px;">Program</th>
              <th scope="col">Statement</th>
              <th scope="col">Capability Link</th>
              <th scope="col">Linked Test</th>
              <th scope="col" style="width: 140px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      `;
    }
  }

  // RENDER: CAPABILITIES VIEW
  function renderCapabilities() {
    const q = document.getElementById('search-capabilities').value.toLowerCase();
    const tbody = document.getElementById('capabilities-table-body');
    if (!tbody) return;

    const filtered = state.capabilities.filter(c => 
      c.id.toLowerCase().includes(q) || 
      (c.description && c.description.toLowerCase().includes(q))
    );

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-secondary); padding: 24px;">No capabilities found.</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(c => {
      // Find requirements linked to this capability
      const linkedReqs = state.requirements.filter(r => r.capabilityId === c.id);
      
      // Group requirements by programId
      const reqsByProg = {};
      linkedReqs.forEach(r => {
        if (!reqsByProg[r.programId]) {
          reqsByProg[r.programId] = [];
        }
        reqsByProg[r.programId].push(r);
      });

      const linksText = Object.keys(reqsByProg).length > 0
        ? Object.keys(reqsByProg).map(progId => {
            const prog = state.programs.find(p => p.id === progId);
            const progName = prog ? prog.name : progId;
            const reqsHtml = reqsByProg[progId].map(r => {
              const isPassed = r.status === 'Passed';
              const badgeClass = isPassed ? 'badge-passed' : 'badge-pending';
              const checkSymbol = isPassed ? '&#10003; ' : '&bull; ';
              return `
                <span class="badge ${badgeClass} drill-link" 
                      data-req-id="${escapeHTML(r.id)}"
                      onclick="ReqApp.drillTo('requirements', this.dataset.reqId); event.stopPropagation();"
                      style="cursor:pointer; display:inline-flex; align-items:center;" 
                      title="Click to view requirement ${r.id} details">
                  ${checkSymbol}${escapeHTML(r.id)}
                </span>
              `;
            }).join('');
            return `
              <div class="cap-matrix-prog-row" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px;">
                <span style="font-size:11px; font-weight:700; color:var(--text-secondary); min-width:110px; display:inline-block; border-right:2px solid var(--border-color); padding-right:6px; text-align:right;">
                  ${escapeHTML(progName)}
                </span>
                <div style="display:flex; flex-wrap:wrap; gap:4px; flex-grow:1;">
                  ${reqsHtml}
                </div>
              </div>
            `;
          }).join('')
        : `<div style="display:flex; align-items:center; gap:8px;">
            <em style="color:var(--text-secondary); font-size:12px;">Unlinked</em>
            <button class="btn btn-secondary" data-cap-id="${escapeHTML(c.id)}" onclick="ReqApp.createRequirementForCap(this.dataset.capId, event)" style="font-size:10px; padding: 2px 6px; font-weight:700; height:auto; line-height:1;">
              + Add Req
            </button>
           </div>`;

      const badgeClass = c.status === 'Passed' ? 'badge-passed' : c.status === 'In Progress' ? 'badge-in-progress' : 'badge-not-started';
      const statusReason = c.status === 'Passed' 
        ? `Passed by requirement(s): ${c.passingRequirementIds.join(', ')}` 
        : 'All linked requirements are in In Progress or Not Started state';

      return `
        <tr style="cursor: pointer;" data-cap-id="${escapeHTML(c.id)}" onclick="ReqApp.openModal('capability-modal', this.dataset.capId)">
          <td><strong style="font-family: 'Outfit', sans-serif;">${escapeHTML(c.id)}</strong></td>
          <td style="color: var(--text-secondary); font-size: 13px; max-width: 380px;">
            ${escapeHTML(c.description || 'No description.')}
          </td>
          <td>
            <div style="max-height: 120px; overflow-y: auto; display:flex; flex-direction:column; gap:4px;">
              ${linksText}
            </div>
          </td>
          <td>
            <span class="badge ${badgeClass}" title="${escapeHTML(statusReason)}">${c.status}</span>
          </td>
        </tr>
      `;
    }).join('');
  }

  // RENDER: TESTS VIEW
  function renderTests() {
    const q = document.getElementById('search-tests').value.toLowerCase();
    const filterProgram = document.getElementById('filter-test-program') ? document.getElementById('filter-test-program').value : 'ALL';
    const filterStatus = document.getElementById('filter-test-status').value;
    const filterAssignee = document.getElementById('filter-test-assignee') ? document.getElementById('filter-test-assignee').value : 'ALL';
    const filterComponent = document.getElementById('filter-test-component') ? document.getElementById('filter-test-component').value : 'ALL';
    const tbody = document.getElementById('tests-table-body');
    if (!tbody) return;

    const filtered = state.tests.filter(t => {
      const textMatch = t.name.toLowerCase().includes(q) || 
                        t.location.toLowerCase().includes(q) || 
                        (t.programDescription && t.programDescription.toLowerCase().includes(q)) ||
                        t.id.toLowerCase().includes(q);
      const statusMatch = filterStatus === 'ALL' || t.status === filterStatus;
      const programMatch = filterProgram === 'ALL' || t.programId === filterProgram;
      const assigneeMatch = filterAssignee === 'ALL' || 
                           (filterAssignee === 'UNASSIGNED' && !t.assigneeId) ||
                           t.assigneeId === filterAssignee;
      const componentMatch = filterComponent === 'ALL' || t.component === filterComponent;
      return textMatch && statusMatch && programMatch && assigneeMatch && componentMatch;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-secondary); padding: 24px;">No tests found.</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map((t, idx) => {
      const prog = state.programs.find(p => p.id === t.programId);
      const linkedReqs = (t.requirementIds || []).map(reqId => state.requirements.find(r => r.id === reqId)).filter(Boolean);
      const reqsHtml = linkedReqs.length > 0 
        ? linkedReqs.map(r => `
            <span class="badge badge-pending drill-link" 
                  data-req-id="${escapeHTML(r.id)}"
                  onclick="ReqApp.drillTo('requirements', this.dataset.reqId); event.stopPropagation();"
                  style="cursor:pointer; margin-right:4px; margin-bottom:4px; display:inline-flex; align-items:center;"
                  title="Click to view requirement detail">
              ${escapeHTML(r.id)}
            </span>
          `).join('')
        : '<em style="color:var(--status-failed);">Unlinked</em>';
      
      const assignee = t.assigneeId ? state.teamMembers.find(tm => tm.id === t.assigneeId) : null;
      const assigneeHtml = assignee
        ? `<span class="assignee-avatar-badge" style="background-color: ${assignee.color};" title="Assigned to ${escapeHTML(assignee.name)}. Click to change.">${escapeHTML(assignee.initials)}</span>`
        : `<span class="assignee-avatar-badge unassigned" title="Unassigned. Click to assign.">&#128100;</span>`;
      
      return `
        <tr id="test-row-${t.id}" 
            draggable="true" 
            data-test-id="${escapeHTML(t.id)}"
            ondragstart="ReqApp.handleTestDragStart(event, this.dataset.testId)"
            ondragover="ReqApp.handleTestDragOver(event, this.dataset.testId)"
            ondragleave="ReqApp.handleTestDragLeave(event, this.dataset.testId)"
            ondrop="ReqApp.handleTestDrop(event, this.dataset.testId)"
            ondragend="ReqApp.handleTestDragEnd(event)"
            style="cursor: pointer;" 
            onclick="ReqApp.openModal('test-modal', this.dataset.testId)">
          <td style="text-align: center; vertical-align: middle; cursor: grab;" onclick="event.stopPropagation();" class="drag-handle" title="Drag to reorder priority">
            <div style="display: flex; align-items: center; justify-content: center; gap: 6px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: var(--text-secondary); opacity: 0.6;">
                <circle cx="9" cy="5" r="1.5"></circle><circle cx="9" cy="12" r="1.5"></circle><circle cx="9" cy="19" r="1.5"></circle>
                <circle cx="15" cy="5" r="1.5"></circle><circle cx="15" cy="12" r="1.5"></circle><circle cx="15" cy="19" r="1.5"></circle>
              </svg>
              <span style="font-weight: 700; font-family: 'Outfit', sans-serif; color: var(--accent-color); font-size: 13px;">#${state.tests.indexOf(t) + 1}</span>
            </div>
          </td>
          <td>
            <div style="font-weight: 600; color: var(--text-primary);">${escapeHTML(t.name)}</div>
            <div style="font-size: 11px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; margin-top: 2px;">
              <span>${escapeHTML(t.id)}</span>
              <span class="badge" style="background-color: var(--border-color); color: var(--text-secondary); font-size: 9px; padding: 2px 4px; font-weight: 700; border-radius: 4px;">${escapeHTML(t.component || 'SE')}</span>
            </div>
          </td>
          <td>
            <span class="badge" style="background-color: var(--border-color); color: var(--text-primary); font-size: 10px;">
              ${escapeHTML(t.type)}
            </span>
          </td>
          <td>
            ${(() => {
              const isUrl = t.location && (t.location.startsWith('http://') || t.location.startsWith('https://'));
              return isUrl
                ? `<a href="${escapeHTML(t.location)}" target="_blank" class="drill-link" style="display:inline-flex; align-items:center; gap:4px; font-size:12px;" title="View in Repository" onclick="event.stopPropagation();">
                    <span>Code Snippet</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                   </a>`
                : `<span style="font-size:12px; color:var(--text-secondary);" title="${escapeHTML(t.location)}">${escapeHTML(t.location)}</span>`;
            })()}
          </td>
          <td style="color: var(--text-secondary); font-size: 13px; max-width: 240px; word-break:break-word;">
            <div>${escapeHTML(t.programDescription || 'N/A')}</div>
            ${t.notes ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:4px; font-style:italic;">✍️ Note: ${escapeHTML(t.notes)}</div>` : ''}
          </td>
          <td>
            <div style="max-height: 80px; overflow-y: auto; display:flex; flex-wrap:wrap; gap:4px;">
              ${reqsHtml}
            </div>
            <div style="font-size:10px; color:var(--text-secondary); margin-top:2px;">
              Program: <strong>${escapeHTML(prog ? prog.name : (t.programId || 'N/A'))}</strong>
            </div>
          </td>
          <td style="text-align: center;">
            ${assigneeHtml}
          </td>
          <td style="text-align: center; font-weight: 500; font-family: 'Outfit', sans-serif; font-size: 13px;">
            ${(t.estimate !== undefined ? t.estimate : 0).toFixed(1).replace(/\.0$/, '')}d
          </td>
          <td>
            <div style="display:flex; flex-direction:column; gap:4px; align-items:center;">
              ${(() => {
                const isSubtaskType = t.type === 'SIL' || t.type === 'HIL' || t.type === 'Monte Carlo';
                if (isSubtaskType) {
                  const sub = t.subtasks || {};
                  const subList = Object.keys(sub).map(k => `${k} (${sub[k]})`).join(', ');
                  let badgeClass = 'badge-not-started';
                  if (t.status === 'Passed') badgeClass = 'badge-passed';
                  else if (t.status === 'In Progress') badgeClass = 'badge-in-progress';
                  return `<span class="badge ${badgeClass}" style="font-size: 12px; padding: 4px 8px; font-weight: 700; cursor: help;" title="Derived from subtasks: ${escapeHTML(subList)}. Click Edit to change.">${t.status}</span>`;
                } else {
                  return `
                    <select class="select-filter btn-sm ${t.status === 'Passed' ? 'select-status-passed' : t.status === 'In Progress' ? 'select-status-inprogress' : 'select-status-notstarted'}" style="font-size: 12px; font-weight: 600; cursor: pointer;" onclick="event.stopPropagation();" data-test-id="${escapeHTML(t.id)}" onchange="ReqApp.toggleTestOutcome(this.dataset.testId, this.value)">
                      <option value="Not Started" ${t.status === 'Not Started' ? 'selected' : ''}>Not Started</option>
                      <option value="In Progress" ${t.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
                      <option value="Passed" ${t.status === 'Passed' ? 'selected' : ''}>Passed</option>
                    </select>
                  `;
                }
              })()}
              ${t.status === 'Passed' && t.passedDate ? `<div style="font-size:10px; color:var(--text-secondary); white-space:nowrap; margin-top:2px;">📅 ${formatPassDate(t.passedDate)}</div>` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Populate program filter inside Traceability view
  function populateTraceabilityFilters() {
    const progSelect = document.getElementById('traceability-program-select');
    if (!progSelect) return;
    const currentVal = progSelect.value || 'ALL';

    const optionValues = Array.from(progSelect.options).map(o => o.value);
    const expectedValues = ['ALL', ...state.programs.map(p => p.id)];

    if (optionValues.join(',') !== expectedValues.join(',')) {
      progSelect.innerHTML = '<option value="ALL">All Programs</option>' +
        state.programs.map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('');
      if (expectedValues.includes(currentVal)) {
        progSelect.value = currentVal;
      } else {
        progSelect.value = 'ALL';
      }
    }
  }

  // RENDER: TRACEABILITY VIEW (Interactive visual network column layout)
  function renderTraceability() {
    populateTraceabilityFilters();

    const progSelect = document.getElementById('traceability-program-select');
    const programId = progSelect ? progSelect.value : 'ALL';

    const capListContainer = document.getElementById('trace-list-capabilities');
    const reqListContainer = document.getElementById('trace-list-requirements');
    const testListContainer = document.getElementById('trace-list-tests');
    const svgElement = document.getElementById('traceability-svg');
    const graphContainer = document.getElementById('traceability-graph-container');

    if (!capListContainer || !reqListContainer || !testListContainer || !svgElement || !graphContainer) return;

    // Clear lists and SVG viewport
    capListContainer.innerHTML = '';
    reqListContainer.innerHTML = '';
    testListContainer.innerHTML = '';
    svgElement.innerHTML = '';

    // 1. Filter elements
    let filteredReqs = state.requirements;
    if (programId !== 'ALL') {
      filteredReqs = state.requirements.filter(r => r.programId === programId);
    }

    const reqIds = filteredReqs.map(r => r.id);

    // Capabilities are shown if they are linked to at least one requirement in filteredReqs
    let filteredCaps = state.capabilities.filter(c => 
      state.requirements.some(r => r.capabilityId === c.id && reqIds.includes(r.id))
    );

    // Tests are shown if they link to at least one requirement in filteredReqs
    let filteredTests = state.tests.filter(t => 
      t.requirementIds && t.requirementIds.some(reqId => reqIds.includes(reqId))
    );

    if (filteredReqs.length === 0) {
      capListContainer.innerHTML = '<div style="color:var(--text-secondary); text-align:center; font-size:12px; padding:20px; font-style:italic;">No capabilities.</div>';
      reqListContainer.innerHTML = '<div style="color:var(--text-secondary); text-align:center; font-size:12px; padding:20px; font-style:italic;">No requirements.</div>';
      testListContainer.innerHTML = '<div style="color:var(--text-secondary); text-align:center; font-size:12px; padding:20px; font-style:italic;">No tests.</div>';
      return;
    }

    // Render Capabilities Column
    if (filteredCaps.length === 0) {
      capListContainer.innerHTML = '<div style="color:var(--text-secondary); text-align:center; font-size:12px; padding:20px; font-style:italic;">Unlinked (None)</div>';
    } else {
      capListContainer.innerHTML = filteredCaps.map(c => {
        const badgeClass = c.status === 'Passed' ? 'badge-passed' : c.status === 'In Progress' ? 'badge-in-progress' : 'badge-not-started';
        return `
          <div class="trace-node" id="trace-node-cap-${escapeHTML(c.id)}" onclick="ReqApp.openModal('capability-modal', this.dataset.id)" data-type="capability" data-id="${escapeHTML(c.id)}">
            <div style="font-weight:700; font-size:13px; color:var(--text-primary);">${escapeHTML(c.id)}</div>
            <div style="font-size:11px; color:var(--text-secondary); margin-top:4px; text-overflow:ellipsis; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; max-height:32px;">${escapeHTML(c.description || 'No description.')}</div>
            <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center;">
              <span class="badge ${badgeClass}" style="font-size:9px; padding:1px 6px;">${c.status}</span>
            </div>
          </div>
        `;
      }).join('');
    }

    // Render Requirements Column
    reqListContainer.innerHTML = filteredReqs.map(r => {
      const prog = state.programs.find(p => p.id === r.programId);
      const isInherited = r.inheritPassFromCapability && r.status === 'Passed' && r.baseStatus !== 'Passed';
      const badgeClass = isInherited ? 'badge-inherited' : (r.status === 'Passed' ? 'badge-passed' : r.status === 'In Progress' ? 'badge-in-progress' : 'badge-not-started');
      const statusLabel = isInherited ? 'PASSED (INHERITED)' : r.status;

      return `
        <div class="trace-node" id="trace-node-req-${escapeHTML(r.id)}" onclick="ReqApp.openModal('requirement-modal', this.dataset.id)" data-type="requirement" data-id="${escapeHTML(r.id)}">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-weight:700; font-size:13px; color:var(--text-primary);">${escapeHTML(r.id)}</span>
            <span class="badge" style="background-color: var(--border-color); color: var(--text-secondary); font-size: 9px; padding: 2px 4px; font-weight: 700; border-radius: 4px;">${escapeHTML(r.component || 'SE')}</span>
          </div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:4px; text-overflow:ellipsis; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; max-height:32px;">${escapeHTML(r.description)}</div>
          <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center; gap:6px;">
            <span class="badge ${badgeClass}" style="font-size:9px; padding:1px 6px;">${statusLabel}</span>
            <span style="font-size:10px; color:var(--text-secondary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:120px;" title="${escapeHTML(prog ? prog.name : r.programId)}">${escapeHTML(prog ? prog.name : r.programId)}</span>
          </div>
        </div>
      `;
    }).join('');

    // Render Tests Column
    if (filteredTests.length === 0) {
      testListContainer.innerHTML = '<div style="color:var(--text-secondary); text-align:center; font-size:12px; padding:20px; font-style:italic;">No tests linked.</div>';
    } else {
      testListContainer.innerHTML = filteredTests.map(t => {
        const badgeClass = t.status === 'Passed' ? 'badge-passed' : t.status === 'In Progress' ? 'badge-in-progress' : 'badge-not-started';
        const dateHtml = t.status === 'Passed' && t.passedDate 
          ? `<span style="font-size:9px; color:var(--text-secondary);">📅 ${formatPassDate(t.passedDate)}</span>` 
          : '';
        return `
          <div class="trace-node" id="trace-node-test-${escapeHTML(t.id)}" onclick="ReqApp.openModal('test-modal', this.dataset.id)" data-type="test" data-id="${escapeHTML(t.id)}">
            <div style="font-weight:700; font-size:13px; color:var(--text-primary);">${escapeHTML(t.name)}</div>
            <div style="font-size:11px; color:var(--text-secondary); margin-top:4px;">ID: ${escapeHTML(t.id)} &middot; ${escapeHTML(t.type)}</div>
            <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
              <span class="badge ${badgeClass}" style="font-size:9px; padding:1px 6px;">${t.status}</span>
              ${dateHtml}
            </div>
          </div>
        `;
      }).join('');
    }

    // Save filtered data for scrolls/hovers
    traceabilityData = {
      caps: filteredCaps,
      reqs: filteredReqs,
      tests: filteredTests
    };

    // Bind hover event listeners to newly rendered cards
    const allCards = document.querySelectorAll(".trace-node");
    allCards.forEach(card => {
      card.addEventListener("mouseenter", () => {
        const type = card.dataset.type;
        const id = card.dataset.id;
        applyTraceHighlights(id, type);
      });

      card.addEventListener("mouseleave", () => {
        clearTraceHighlights();
      });
    });

    // Draw initial paths
    setTimeout(() => {
      drawTracePaths();
    }, 100);
  }

  // Draw trace connections SVG paths
  function drawTracePaths() {
    const svgElement = document.getElementById('traceability-svg');
    const graphContainer = document.getElementById('traceability-graph-container');
    if (!svgElement || !graphContainer) return;

    // Clear SVG viewport
    svgElement.innerHTML = '';

    // Set SVG size explicitly to match container scroll size
    svgElement.style.width = graphContainer.scrollWidth + 'px';
    svgElement.style.height = graphContainer.scrollHeight + 'px';

    const containerRect = graphContainer.getBoundingClientRect();
    const svgRect = svgElement.getBoundingClientRect();
    const offsetX = containerRect.left - svgRect.left;
    const offsetY = containerRect.top - svgRect.top;

    const { caps, reqs, tests } = traceabilityData;

    // Get active elements if currently hovering
    let activeCaps = new Set();
    let activeReqs = new Set();
    let activeTests = new Set();
    if (currentHoveredTraceNode) {
      const activeData = getActiveTraceElements(currentHoveredTraceNode.id, currentHoveredTraceNode.type);
      activeCaps = activeData.activeCaps;
      activeReqs = activeData.activeReqs;
      activeTests = activeData.activeTests;
    }

    // Capability -> Requirement paths
    caps.forEach(c => {
      const capCard = document.getElementById(`trace-node-cap-${c.id}`);
      if (!capCard || capCard.style.display === 'none') return;
      const capRect = capCard.getBoundingClientRect();

      const linkedReqs = reqs.filter(r => r.capabilityId === c.id);

      linkedReqs.forEach(r => {
        const reqCard = document.getElementById(`trace-node-req-${r.id}`);
        if (!reqCard || reqCard.style.display === 'none') return;
        const reqRect = reqCard.getBoundingClientRect();

        const x1 = capRect.right - containerRect.left + offsetX;
        const y1 = capRect.top + capRect.height / 2 - containerRect.top + offsetY;
        const x2 = reqRect.left - containerRect.left + offsetX;
        const y2 = reqRect.top + reqRect.height / 2 - containerRect.top + offsetY;

        const cp1x = x1 + (x2 - x1) * 0.45;
        const cp1y = y1;
        const cp2x = x1 + (x2 - x1) * 0.55;
        const cp2y = y2;

        const pathD = `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathD);
        
        let pathClass = "trace-path";
        if (currentHoveredTraceNode) {
          const isPathActive = activeCaps.has(c.id) && activeReqs.has(r.id);
          pathClass += isPathActive ? " highlighted" : " dimmed";
        }
        path.setAttribute("class", pathClass);
        path.dataset.cap = c.id;
        path.dataset.req = r.id;

        svgElement.appendChild(path);
      });
    });

    // Requirement -> Test paths
    reqs.forEach(r => {
      const reqCard = document.getElementById(`trace-node-req-${r.id}`);
      if (!reqCard || reqCard.style.display === 'none') return;
      const reqRect = reqCard.getBoundingClientRect();

      const linkedTests = tests.filter(t => t.requirementIds && t.requirementIds.includes(r.id));

      linkedTests.forEach(t => {
        const testCard = document.getElementById(`trace-node-test-${t.id}`);
        if (!testCard || testCard.style.display === 'none') return;
        const testRect = testCard.getBoundingClientRect();

        const x1 = reqRect.right - containerRect.left + offsetX;
        const y1 = reqRect.top + reqRect.height / 2 - containerRect.top + offsetY;
        const x2 = testRect.left - containerRect.left + offsetX;
        const y2 = testRect.top + testRect.height / 2 - containerRect.top + offsetY;

        const cp1x = x1 + (x2 - x1) * 0.45;
        const cp1y = y1;
        const cp2x = x1 + (x2 - x1) * 0.55;
        const cp2y = y2;

        const pathD = `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathD);
        
        let pathClass = "trace-path";
        if (currentHoveredTraceNode) {
          const isPathActive = activeReqs.has(r.id) && activeTests.has(t.id);
          pathClass += isPathActive ? " highlighted" : " dimmed";
        }
        path.setAttribute("class", pathClass);
        path.dataset.req = r.id;
        path.dataset.test = t.id;

        svgElement.appendChild(path);
      });
    });
  }

  // Helper function to extract active elements in trace path
  // Draw trace connections SVG paths
  function drawTracePaths() {
    const svgElement = document.getElementById('traceability-svg');
    const graphContainer = document.getElementById('traceability-graph-container');
    if (!svgElement || !graphContainer) return;

    // Clear SVG viewport
    svgElement.innerHTML = '';

    // Set SVG size explicitly to match container scroll size
    svgElement.style.width = graphContainer.scrollWidth + 'px';
    svgElement.style.height = graphContainer.scrollHeight + 'px';

    const containerRect = graphContainer.getBoundingClientRect();
    const svgRect = svgElement.getBoundingClientRect();
    const offsetX = containerRect.left - svgRect.left;
    const offsetY = containerRect.top - svgRect.top;

    const { caps, reqs, tests } = traceabilityData;

    // Get active elements if currently hovering
    let activeCaps = new Set();
    let activeReqs = new Set();
    let activeTests = new Set();
    if (currentHoveredTraceNode) {
      const activeData = getActiveTraceElements(currentHoveredTraceNode.id, currentHoveredTraceNode.type);
      activeCaps = activeData.activeCaps;
      activeReqs = activeData.activeReqs;
      activeTests = activeData.activeTests;
    }

    // Capability -> Requirement paths
    caps.forEach(c => {
      const capCard = document.getElementById(`trace-node-cap-${c.id}`);
      if (!capCard || capCard.style.display === 'none') return;
      const capRect = capCard.getBoundingClientRect();

      const linkedReqs = reqs.filter(r => r.capabilityId === c.id);

      linkedReqs.forEach(r => {
        const reqCard = document.getElementById(`trace-node-req-${r.id}`);
        if (!reqCard || reqCard.style.display === 'none') return;
        const reqRect = reqCard.getBoundingClientRect();

        const x1 = capRect.right - containerRect.left + offsetX;
        const y1 = capRect.top + capRect.height / 2 - containerRect.top + offsetY;
        const x2 = reqRect.left - containerRect.left + offsetX;
        const y2 = reqRect.top + reqRect.height / 2 - containerRect.top + offsetY;

        const cp1x = x1 + (x2 - x1) * 0.45;
        const cp1y = y1;
        const cp2x = x1 + (x2 - x1) * 0.55;
        const cp2y = y2;

        const pathD = `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathD);
        
        let pathClass = "trace-path";
        if (currentHoveredTraceNode) {
          const isPathActive = activeCaps.has(c.id) && activeReqs.has(r.id);
          pathClass += isPathActive ? " highlighted" : " dimmed";
        }
        path.setAttribute("class", pathClass);
        path.dataset.cap = c.id;
        path.dataset.req = r.id;

        svgElement.appendChild(path);
      });
    });

    // Requirement -> Test paths
    reqs.forEach(r => {
      const reqCard = document.getElementById(`trace-node-req-${r.id}`);
      if (!reqCard || reqCard.style.display === 'none') return;
      const reqRect = reqCard.getBoundingClientRect();

      const linkedTests = tests.filter(t => t.requirementIds && t.requirementIds.includes(r.id));

      linkedTests.forEach(t => {
        const testCard = document.getElementById(`trace-node-test-${t.id}`);
        if (!testCard || testCard.style.display === 'none') return;
        const testRect = testCard.getBoundingClientRect();

        const x1 = reqRect.right - containerRect.left + offsetX;
        const y1 = reqRect.top + reqRect.height / 2 - containerRect.top + offsetY;
        const x2 = testRect.left - containerRect.left + offsetX;
        const y2 = testRect.top + testRect.height / 2 - containerRect.top + offsetY;

        const cp1x = x1 + (x2 - x1) * 0.45;
        const cp1y = y1;
        const cp2x = x1 + (x2 - x1) * 0.55;
        const cp2y = y2;

        const pathD = `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathD);
        
        let pathClass = "trace-path";
        if (currentHoveredTraceNode) {
          const isPathActive = activeReqs.has(r.id) && activeTests.has(t.id);
          pathClass += isPathActive ? " highlighted" : " dimmed";
        }
        path.setAttribute("class", pathClass);
        path.dataset.req = r.id;
        path.dataset.test = t.id;

        svgElement.appendChild(path);
      });
    });
  }

  // Helper function to extract active elements in trace path
  function getActiveTraceElements(id, type) {
    const programSelect = document.getElementById('traceability-program-select');
    const programId = programSelect ? programSelect.value : 'ALL';
    let filteredReqs = state.requirements;
    if (programId !== 'ALL') {
      filteredReqs = state.requirements.filter(r => r.programId === programId);
    }
    const reqIds = filteredReqs.map(r => r.id);

    let activeCaps = new Set();
    let activeReqs = new Set();
    let activeTests = new Set();

    if (type === "capability") {
      activeCaps.add(id);
      state.requirements.forEach(r => {
        if (r.capabilityId === id && reqIds.includes(r.id)) {
          activeReqs.add(r.id);
          state.tests.forEach(t => {
            if (t.requirementIds && t.requirementIds.includes(r.id)) {
              activeTests.add(t.id);
            }
          });
        }
      });
    } else if (type === "requirement") {
      activeReqs.add(id);
      const req = state.requirements.find(r => r.id === id);
      if (req && req.capabilityId) {
        activeCaps.add(req.capabilityId);
      }
      state.tests.forEach(t => {
        if (t.requirementIds && t.requirementIds.includes(id)) {
          activeTests.add(t.id);
        }
      });
    } else if (type === "test") {
      activeTests.add(id);
      const test = state.tests.find(t => t.id === id);
      if (test && test.requirementIds) {
        test.requirementIds.forEach(reqId => {
          if (reqIds.includes(reqId)) {
            activeReqs.add(reqId);
            const req = state.requirements.find(r => r.id === reqId);
            if (req && req.capabilityId) {
              activeCaps.add(req.capabilityId);
            }
          }
        });
      }
    }

    return { activeCaps, activeReqs, activeTests };
  }

  // Apply Trace highlights and focus-collapse unrelated columns
  function applyTraceHighlights(id, type) {
    currentHoveredTraceNode = { id, type };

    const { activeCaps, activeReqs, activeTests } = getActiveTraceElements(id, type);

    const allCards = document.querySelectorAll(".trace-node");
    allCards.forEach(c => {
      const cType = c.dataset.type;
      const cId = c.dataset.id;

      let isActive = false;
      if (cType === "capability" && activeCaps.has(cId)) isActive = true;
      else if (cType === "requirement" && activeReqs.has(cId)) isActive = true;
      else if (cType === "test" && activeTests.has(cId)) isActive = true;

      if (isActive) {
        c.classList.add("active-trace");
        c.classList.remove("dimmed");
      } else {
        c.classList.remove("active-trace");
        c.classList.add("dimmed");
      }

      // Hide unrelated cards in other columns to collapse them vertically
      if (cType !== type) {
        if (isActive) {
          c.style.display = "";
        } else {
          c.style.display = "none";
        }
      } else {
        // Keep hovered card's column fully visible to avoid layout jump under cursor
        c.style.display = "";
      }
    });

    // Schedule path drawing AFTER layout shifts have occurred
    setTimeout(() => {
      drawTracePaths();
    }, 50);
  }

  // Clear Trace highlights and restore full columns
  function clearTraceHighlights() {
    currentHoveredTraceNode = null;

    const allCards = document.querySelectorAll(".trace-node");
    allCards.forEach(c => {
      c.classList.remove("active-trace", "dimmed");
      c.style.display = "";
    });

    // Schedule path drawing AFTER layout has expanded back to original height
    setTimeout(() => {
      drawTracePaths();
    }, 50);
  }



  // Create a new test with program and requirement preselected
  function createTestForReq(programId, reqId) {
    openModal('test-modal');
    
    const progSelect = document.getElementById('test-program-select');
    if (progSelect) {
      progSelect.value = programId;
      populateTestRequirements();
      
      const checkbox = document.querySelector(`#test-requirements-checkbox-list input[type="checkbox"][value="${reqId}"]`);
      if (checkbox) {
        checkbox.checked = true;
      }
    }
  }

  // Create a new requirement with capability preselected
  function createRequirementForCap(capabilityId, event) {
    if (event) event.stopPropagation();
    openModal('requirement-modal');
    
    const capSelect = document.getElementById('requirement-capability-select');
    if (capSelect) {
      capSelect.value = capabilityId;
    }
  }

  // Toggle visibility of the program actions dropdown
  function toggleProgramDropdown(event) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById('program-actions-dropdown');
    if (dropdown) {
      const isVisible = dropdown.style.display === 'block';
      dropdown.style.display = isVisible ? 'none' : 'block';
    }
  }

  // Generate and trigger program status report print dialog
  function printProgramReport(programId) {
    const prog = state.programs.find(p => p.id === programId);
    if (!prog) return;

    // Get requirements, tests, capabilities
    const progReqs = state.requirements.filter(r => r.programId === prog.id);
    const passedCount = progReqs.filter(r => r.status === 'Passed').length;
    const totalCount = progReqs.length;
    const pct = totalCount > 0 ? Math.round((passedCount / totalCount) * 100) : 0;

    // Untested requirements
    const unlinkedReqs = progReqs.filter(r => 
      !state.tests.some(t => t.programId === r.programId && t.requirementIds && t.requirementIds.includes(r.id))
    );
    const coveragePct = totalCount > 0 ? Math.round(((totalCount - unlinkedReqs.length) / totalCount) * 100) : 0;

    // Backlog tests (not started or in progress)
    const progTests = state.tests.filter(t => t.programId === prog.id);
    const pendingTests = progTests.filter(t => t.status !== 'Passed');
    const totalTestsSum = progTests.reduce((sum, t) => sum + (t.estimate || 0), 0);
    const completedTestsSum = progTests.filter(t => t.status === 'Passed').reduce((sum, t) => sum + (t.estimate || 0), 0);
    const backlogDaysSum = pendingTests.reduce((sum, t) => sum + (t.estimate || 0), 0);

    // Capabilities
    const uniqueCaps = [];
    progReqs.forEach(r => {
      if (r.capabilityId && !uniqueCaps.some(c => c.id === r.capabilityId)) {
        const c = state.capabilities.find(cap => cap.id === r.capabilityId);
        if (c) uniqueCaps.push(c);
      }
    });

    const reportContainer = document.getElementById('print-report-container');
    if (!reportContainer) return;

    // Format current date
    const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    const dateStr = new Date().toLocaleDateString('en-US', options);

    let html = `
      <div class="print-header">
        <div class="print-logo">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0F2439" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 3 17 19 12 16 7 19" fill="#0F2439"></polygon>
            <ellipse cx="12" cy="11" rx="8" ry="3" stroke="#2563EB" stroke-width="1.5" transform="rotate(-15 12 11)"></ellipse>
          </svg>
          <span class="print-logo-text">REQ WRANGLER</span>
        </div>
        <div class="print-report-title">PROGRAM STATUS REPORT</div>
      </div>

      <div class="print-program-info">
        <h1 class="print-title">${escapeHTML(prog.name)}</h1>
        <div class="print-meta-grid">
          <div><strong>Program ID:</strong> ${escapeHTML(prog.id)}</div>
          <div><strong>Report Date:</strong> ${dateStr}</div>
          <div><strong>Status:</strong> Active</div>
        </div>
        <p class="print-description"><strong>Description:</strong> ${escapeHTML(prog.description || 'No description provided.')}</p>
      </div>

      <!-- KPI Summary Grid -->
      <div class="print-kpi-grid">
        <div class="print-kpi-card">
          <div class="print-kpi-label">Overall Compliance</div>
          <div class="print-kpi-value">${pct}%</div>
          <div class="print-kpi-sub">${passedCount} / ${totalCount} Requirements Passed</div>
        </div>
        <div class="print-kpi-card">
          <div class="print-kpi-label">Verification Coverage</div>
          <div class="print-kpi-value">${coveragePct}%</div>
          <div class="print-kpi-sub">${unlinkedReqs.length} Untested Gaps</div>
        </div>
        <div class="print-kpi-card">
          <div class="print-kpi-label">Execution Backlog</div>
          <div class="print-kpi-value">${pendingTests.length}</div>
          <div class="print-kpi-sub">${backlogDaysSum.toFixed(1).replace(/\.0$/, '')}d Effort Remaining</div>
        </div>
        <div class="print-kpi-card">
          <div class="print-kpi-label">Total Estimate</div>
          <div class="print-kpi-value">${totalTestsSum.toFixed(1).replace(/\.0$/, '')}d</div>
          <div class="print-kpi-sub">${completedTestsSum.toFixed(1).replace(/\.0$/, '')}d Completed</div>
        </div>
      </div>

      <div class="print-section">
        <h2 class="print-section-title">Requirements Verification Matrix</h2>
        <table class="print-table">
          <thead>
            <tr>
              <th style="width: 15%;">Req ID</th>
              <th style="width: 10%;">Component</th>
              <th style="width: 40%;">Requirement Description</th>
              <th style="width: 15%;">Linked Test(s)</th>
              <th style="width: 10%;">Capability</th>
              <th style="width: 10%;">Status</th>
            </tr>
          </thead>
          <tbody>
    `;

    if (progReqs.length === 0) {
      html += `<tr><td colspan="6" style="text-align: center; color: #666;">No requirements linked to this program.</td></tr>`;
    } else {
      progReqs.forEach(r => {
        const linkedTests = state.tests.filter(t => 
          t.programId === r.programId && 
          t.requirementIds && 
          t.requirementIds.includes(r.id)
        );
        let testsText = 'None';
        if (linkedTests.length > 0) {
          testsText = linkedTests.map(t => `${t.name} (${t.status})`).join(', ');
        } else {
          const sources = getInheritedPassSource(r);
          if (sources && sources.length > 0) {
            testsText = 'Inherited Pass: ' + sources.map(src => {
              return `${src.testName || `Req ${src.requirementId}`} (${src.programName})`;
            }).join(', ');
          }
        }
        
        let statusClass = 'print-badge-not-started';
        if (r.status === 'Passed') {
          statusClass = r.inheritPassFromCapability && r.baseStatus !== 'Passed' ? 'print-badge-inherited' : 'print-badge-passed';
        } else if (r.status === 'In Progress') {
          statusClass = 'print-badge-in-progress';
        }

        html += `
          <tr>
            <td><strong>${escapeHTML(r.id)}</strong></td>
            <td>${escapeHTML(r.component || 'SE')}</td>
            <td>
              <div>${escapeHTML(r.description)}</div>
              ${r.notes ? `<div style="font-size: 8pt; color: #555; margin-top: 3px; font-style: italic;">Note: ${escapeHTML(r.notes)}</div>` : ''}
            </td>
            <td>${escapeHTML(testsText)}</td>
            <td>${r.capabilityId ? escapeHTML(r.capabilityId) : 'None'}</td>
            <td><span class="print-badge ${statusClass}">${escapeHTML(r.status)}</span></td>
          </tr>
        `;
      });
    }

    html += `
          </tbody>
        </table>
      </div>

      <div class="print-section">
        <h2 class="print-section-title">Associated Shared Capabilities</h2>
    `;

    if (uniqueCaps.length === 0) {
      html += `<p style="color: #666; font-size: 10pt; font-style: italic;">No associated shared capabilities for this program.</p>`;
    } else {
      html += `
        <table class="print-table">
          <thead>
            <tr>
              <th style="width: 20%;">Capability ID</th>
              <th style="width: 50%;">Description</th>
              <th style="width: 15%;">Program Reqs</th>
              <th style="width: 15%;">Status</th>
            </tr>
          </thead>
          <tbody>
      `;
      uniqueCaps.forEach(c => {
        const linkedReqs = progReqs.filter(r => r.capabilityId === c.id);
        const reqsText = linkedReqs.map(r => r.id).join(', ') || 'None';
        let statusClass = 'print-badge-not-started';
        if (c.status === 'Passed') statusClass = 'print-badge-passed';
        else if (c.status === 'In Progress') statusClass = 'print-badge-in-progress';

        html += `
          <tr>
            <td><strong>${escapeHTML(c.id)}</strong></td>
            <td>${escapeHTML(c.description)}</td>
            <td>${escapeHTML(reqsText)}</td>
            <td><span class="print-badge ${statusClass}">${escapeHTML(c.status)}</span></td>
          </tr>
        `;
      });
      html += `
          </tbody>
        </table>
      `;
    }

    html += `
      </div>

      <div class="print-section">
        <h2 class="print-section-title">Verification Test & Execution Backlog</h2>
    `;

    if (progTests.length === 0) {
      html += `<p style="color: #666; font-size: 10pt; font-style: italic;">No verification tests defined for this program.</p>`;
    } else {
      html += `
        <table class="print-table">
          <thead>
            <tr>
              <th style="width: 20%;">Test Name</th>
              <th style="width: 10%;">Type</th>
              <th style="width: 15%;">Assignee</th>
              <th style="width: 10%;">Estimate</th>
              <th style="width: 30%;">Scope & Subtasks</th>
              <th style="width: 15%;">Status</th>
            </tr>
          </thead>
          <tbody>
      `;
      progTests.forEach(t => {
        const assignee = t.assigneeId ? state.teamMembers.find(tm => tm.id === t.assigneeId) : null;
        const assigneeName = assignee ? assignee.name : 'Unassigned';
        
        let statusClass = 'print-badge-not-started';
        if (t.status === 'Passed') statusClass = 'print-badge-passed';
        else if (t.status === 'In Progress') statusClass = 'print-badge-in-progress';

        let subtasksText = '';
        if (t.subtasks && Object.keys(t.subtasks).length > 0) {
          subtasksText = '<div style="margin-top: 4px; font-size: 8pt; border-top: 1px dashed #cbd5e1; padding-top: 3px;"><strong>Subtasks:</strong> ' +
            Object.keys(t.subtasks).map(k => `${escapeHTML(k)} (${escapeHTML(t.subtasks[k])})`).join(', ') + '</div>';
        }

        html += `
          <tr>
            <td>
              <strong>${escapeHTML(t.name)}</strong>
              <div style="font-size: 8pt; color: #666;">${escapeHTML(t.id)}</div>
            </td>
            <td>${escapeHTML(t.type)}</td>
            <td>${escapeHTML(assigneeName)}</td>
            <td>${(t.estimate || 0).toFixed(1).replace(/\.0$/, '')}d</td>
            <td>
              <div>${escapeHTML(t.programDescription || 'N/A')}</div>
              ${t.notes ? `<div style="font-size: 8pt; color: #555; font-style: italic;">Note: ${escapeHTML(t.notes)}</div>` : ''}
              ${subtasksText}
            </td>
            <td>
              <span class="print-badge ${statusClass}">${escapeHTML(t.status)}</span>
              ${t.status === 'Passed' && t.passedDate ? `<div style="font-size: 8pt; color: #555; margin-top: 3px; white-space: nowrap;">on ${formatPassDate(t.passedDate)}</div>` : ''}
            </td>
          </tr>
        `;
      });
      html += `
          </tbody>
        </table>
      `;
    }

    html += `
      </div>
      
      <div class="print-footer">
        <div>Requirement Wrangler Status Report &middot; Confidential Aerospace Document</div>
        <div>Status: Active &middot; Generated via Client App</div>
      </div>
    `;

    reportContainer.innerHTML = html;
    
    // Trigger print dialog
    window.print();
  }

  // Excel File Parsing & Mapping State variables
  let activeWorkbook = null;
  let activeHeaders = [];
  let activeRows = [];

  // Reset Capabilities Import Form
  function resetImportCapabilitiesForm() {
    const fileInput = document.getElementById('import-cap-file-input');
    if (fileInput) fileInput.value = '';
    
    const sheetSelect = document.getElementById('import-capabilities-sheet-select');
    if (sheetSelect) sheetSelect.innerHTML = '<option value="">-- Upload a file first --</option>';
    
    const idSelect = document.getElementById('import-cap-id-select');
    const descSelect = document.getElementById('import-cap-desc-select');
    if (idSelect) idSelect.innerHTML = '<option value="">-- Upload a file first --</option>';
    if (descSelect) descSelect.innerHTML = '<option value="">-- Upload a file first --</option>';
    
    const preview = document.getElementById('import-capabilities-preview');
    if (preview) preview.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:12px; text-align:center;">Upload a file and map columns to preview data</div>';
    
    const confirmBtn = document.getElementById('import-capabilities-confirm-btn');
    if (confirmBtn) confirmBtn.disabled = true;

    activeWorkbook = null;
    activeHeaders = [];
    activeRows = [];
  }

  // Open Requirements Import Modal
  function openImportRequirementsModal(programId = null) {
    const fileInput = document.getElementById('import-req-file-input');
    if (fileInput) fileInput.value = '';
    
    const sheetSelect = document.getElementById('import-requirements-sheet-select');
    if (sheetSelect) sheetSelect.innerHTML = '<option value="">-- Upload a file first --</option>';
    
    const idSelect = document.getElementById('import-req-id-select');
    const descSelect = document.getElementById('import-req-desc-select');
    const capSelect = document.getElementById('import-req-cap-select');
    if (idSelect) idSelect.innerHTML = '<option value="">-- Upload a file first --</option>';
    if (descSelect) descSelect.innerHTML = '<option value="">-- Upload a file first --</option>';
    if (capSelect) capSelect.innerHTML = '<option value="">-- Upload a file first --</option>';
    
    const preview = document.getElementById('import-requirements-preview');
    if (preview) preview.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:12px; text-align:center;">Upload a file and map columns to preview data</div>';
    
    const confirmBtn = document.getElementById('import-requirements-confirm-btn');
    if (confirmBtn) confirmBtn.disabled = true;

    activeWorkbook = null;
    activeHeaders = [];
    activeRows = [];

    // Populate programs dropdown in import modal
    const progSelect = document.getElementById('import-req-program-select');
    if (progSelect) {
      progSelect.innerHTML = state.programs.map(p => 
        `<option value="${p.id}">${escapeHTML(p.name)}</option>`
      ).join('');
      
      if (programId) {
        progSelect.value = programId;
      } else if (state.programs.length > 0) {
        progSelect.value = state.programs[0].id;
      }
    }

    openModal('import-requirements-modal');
  }

  // Handle spreadsheet file upload
  function handleExcelUpload(event, type) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const data = new Uint8Array(e.target.result);
        activeWorkbook = XLSX.read(data, { type: 'array' });
        
        const sheetSelect = document.getElementById(`import-${type === 'capabilities' ? 'capabilities' : 'requirements'}-sheet-select`);
        if (sheetSelect) {
          sheetSelect.innerHTML = activeWorkbook.SheetNames.map(name => 
            `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`
          ).join('');
          
          // Trigger sheet change to load initial headers and rows
          handleSheetChange(type);
        }
      } catch (err) {
        console.error(err);
        alert("Failed to parse Excel file. Make sure it is a valid spreadsheet.");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // Handle sheet select dropdown change
  function handleSheetChange(type) {
    if (!activeWorkbook) return;
    const sheetSelect = document.getElementById(`import-${type === 'capabilities' ? 'capabilities' : 'requirements'}-sheet-select`);
    const sheetName = sheetSelect.value;
    if (!sheetName) return;

    const worksheet = activeWorkbook.Sheets[sheetName];
    if (!worksheet) return;

    const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    if (json.length === 0) {
      alert("Selected sheet is empty!");
      return;
    }

    // Extract headers and data rows
    activeHeaders = json[0].map(h => (h !== undefined && h !== null) ? String(h).trim() : '');
    activeRows = json.slice(1);

    populateColumnSelectors(type);
    updateImportPreview(type);
  }

  // Populate drop-downs for columns
  function populateColumnSelectors(type) {
    const colOptions = activeHeaders.map((header, idx) => 
      `<option value="${idx}">${escapeHTML(header || `Column ${idx + 1}`)}</option>`
    ).join('');

    if (type === 'capabilities') {
      const idSel = document.getElementById('import-cap-id-select');
      const descSel = document.getElementById('import-cap-desc-select');
      
      if (idSel && descSel) {
        idSel.innerHTML = '<option value="">-- Select Column --</option>' + colOptions;
        descSel.innerHTML = '<option value="">-- Select Column --</option>' + colOptions;
        
        idSel.value = findHeaderMatch(activeHeaders, ['id', 'cap id', 'capability id', 'code']);
        descSel.value = findHeaderMatch(activeHeaders, ['desc', 'description', 'statement', 'details']);
      }
    } else if (type === 'requirements') {
      const idSel = document.getElementById('import-req-id-select');
      const descSel = document.getElementById('import-req-desc-select');
      const capSel = document.getElementById('import-req-cap-select');
      
      if (idSel && descSel && capSel) {
        idSel.innerHTML = '<option value="">-- Select Column --</option>' + colOptions;
        descSel.innerHTML = '<option value="">-- Select Column --</option>' + colOptions;
        capSel.innerHTML = '<option value="-1">None (Optional)</option>' + colOptions;
        
        idSel.value = findHeaderMatch(activeHeaders, ['id', 'req id', 'requirement id', 'code']);
        descSel.value = findHeaderMatch(activeHeaders, ['desc', 'description', 'statement', 'text']);
        capSel.value = findHeaderMatch(activeHeaders, ['capability', 'cap', 'capability id', 'linked cap']);
      }
    }
  }

  // Find header match based on common synonyms
  function findHeaderMatch(headers, possibleNames) {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase().trim();
      if (possibleNames.some(name => h === name || h.includes(name))) {
        return i;
      }
    }
    return '';
  }

  // Update table preview of mapped data rows
  function updateImportPreview(type) {
    const previewContainer = document.getElementById(`import-${type}-preview`);
    const importBtn = document.getElementById(`import-${type}-confirm-btn`);
    if (!previewContainer || !importBtn) return;

    if (type === 'capabilities') {
      const idIdx = document.getElementById('import-cap-id-select').value;
      const descIdx = document.getElementById('import-cap-desc-select').value;

      if (idIdx === '' || descIdx === '') {
        previewContainer.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:12px; text-align:center;">Select columns to preview mapped records</div>';
        importBtn.disabled = true;
        return;
      }

      importBtn.disabled = false;
      const previewRows = activeRows.filter(row => row.length > 0).slice(0, 3);
      if (previewRows.length === 0) {
        previewContainer.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:12px; text-align:center;">No data rows found in sheet</div>';
        importBtn.disabled = true;
        return;
      }

      let html = `
        <table class="custom-table" style="font-size: 11px; margin-top:8px;">
          <thead>
            <tr>
              <th style="width: 30%;">Capability ID</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
      `;
      previewRows.forEach(row => {
        const id = row[idIdx] !== undefined ? String(row[idIdx]).trim() : '';
        const desc = row[descIdx] !== undefined ? String(row[descIdx]).trim() : '';
        html += `
          <tr>
            <td><strong>${escapeHTML(id) || '<span style="color:var(--status-failed);">[Empty]</span>'}</strong></td>
            <td>${escapeHTML(desc) || '<span style="color:var(--status-failed);">[Empty]</span>'}</td>
          </tr>
        `;
      });
      html += `
          </tbody>
        </table>
      `;
      previewContainer.innerHTML = html;

    } else if (type === 'requirements') {
      const idIdx = document.getElementById('import-req-id-select').value;
      const descIdx = document.getElementById('import-req-desc-select').value;
      const capIdx = document.getElementById('import-req-cap-select').value;

      if (idIdx === '' || descIdx === '') {
        previewContainer.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:12px; text-align:center;">Select columns to preview mapped records</div>';
        importBtn.disabled = true;
        return;
      }

      importBtn.disabled = false;
      const previewRows = activeRows.filter(row => row.length > 0).slice(0, 3);
      if (previewRows.length === 0) {
        previewContainer.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:12px; text-align:center;">No data rows found in sheet</div>';
        importBtn.disabled = true;
        return;
      }

      let html = `
        <table class="custom-table" style="font-size: 11px; margin-top:8px;">
          <thead>
            <tr>
              <th style="width: 25%;">Requirement ID</th>
              <th>Description</th>
              <th style="width: 25%;">Linked Capability</th>
            </tr>
          </thead>
          <tbody>
      `;
      previewRows.forEach(row => {
        const id = row[idIdx] !== undefined ? String(row[idIdx]).trim() : '';
        const desc = row[descIdx] !== undefined ? String(row[descIdx]).trim() : '';
        const capId = (capIdx !== '-1' && row[capIdx] !== undefined) ? String(row[capIdx]).trim() : 'None';
        html += `
          <tr>
            <td><strong>${escapeHTML(id) || '<span style="color:var(--status-failed);">[Empty]</span>'}</strong></td>
            <td>${escapeHTML(desc) || '<span style="color:var(--status-failed);">[Empty]</span>'}</td>
            <td>${escapeHTML(capId)}</td>
          </tr>
        `;
      });
      html += `
          </tbody>
        </table>
      `;
      previewContainer.innerHTML = html;
    }
  }

  // Merge Excel rows into database in-place (avoid duplicate records)
  function confirmImport(type) {
    if (type === 'capabilities') {
      const idIdx = document.getElementById('import-cap-id-select').value;
      const descIdx = document.getElementById('import-cap-desc-select').value;

      if (idIdx === '' || descIdx === '') return;

      let importCount = 0;
      let updateCount = 0;

      activeRows.forEach(row => {
        if (row.length === 0) return;
        const rawId = row[idIdx] !== undefined ? String(row[idIdx]).trim() : '';
        const id = sanitizeId(rawId);
        const desc = row[descIdx] !== undefined ? String(row[descIdx]).trim() : '';

        if (!id) return; // Skip empty rows

        untrackDeletion(id);

        const existingIdx = state.capabilities.findIndex(c => c.id === id);
        if (existingIdx !== -1) {
          state.capabilities[existingIdx].description = desc;
          updateCount++;
        } else {
          state.capabilities.push({
            id: id,
            description: desc,
            status: 'Not Started'
          });
          importCount++;
        }
      });

      logActivity(`Imported ${importCount} capabilities (updated ${updateCount})`);
      syncAndRefresh();
      closeModal('import-capabilities-modal');
      alert(`Import completed!\n- Added: ${importCount} new capabilities\n- Updated: ${updateCount} existing capabilities`);

    } else if (type === 'requirements') {
      const progSelect = document.getElementById('import-req-program-select');
      const idIdx = document.getElementById('import-req-id-select').value;
      const descIdx = document.getElementById('import-req-desc-select').value;
      const capIdx = document.getElementById('import-req-cap-select').value;

      if (!progSelect || idIdx === '' || descIdx === '') return;

      const programId = progSelect.value;
      let importCount = 0;
      let updateCount = 0;
      const warnings = [];

      activeRows.forEach(row => {
        if (row.length === 0) return;
        const rawId = row[idIdx] !== undefined ? String(row[idIdx]).trim() : '';
        const id = sanitizeId(rawId);
        const desc = row[descIdx] !== undefined ? String(row[descIdx]).trim() : '';
        let rawCapId = (capIdx !== '-1' && row[capIdx] !== undefined) ? String(row[capIdx]).trim() : null;
        let capId = rawCapId ? sanitizeId(rawCapId) : null;

        if (!id) return; // Skip empty rows

        untrackDeletion(id);

        // Check if capability exists
        if (capId) {
          const capExists = state.capabilities.some(c => c.id === capId);
          if (!capExists) {
            warnings.push(`Requirement "${id}" links to Capability "${capId}" which is not in the Capability Matrix.`);
          }
        } else {
          capId = null;
        }

        const existingIdx = state.requirements.findIndex(r => r.id === id);
        if (existingIdx !== -1) {
          state.requirements[existingIdx].programId = programId;
          state.requirements[existingIdx].description = desc;
          state.requirements[existingIdx].capabilityId = capId;
          updateCount++;
        } else {
          state.requirements.push({
            id: id,
            programId: programId,
            capabilityId: capId,
            inheritPassFromCapability: false,
            component: 'SE', // Default component code
            description: desc,
            status: 'Not Started',
            notes: ''
          });
          importCount++;
        }
      });

      logActivity(`Imported ${importCount} requirements for program "${programId}" (updated ${updateCount})`);
      syncAndRefresh();
      closeModal('import-requirements-modal');

      let msg = `Import completed!\n- Added: ${importCount} new requirements\n- Updated: ${updateCount} existing requirements\nTarget Program: ${programId}`;
      if (warnings.length > 0) {
        msg += `\n\n⚠️ Warnings (${warnings.length}):\n` + warnings.slice(0, 5).join('\n');
        if (warnings.length > 5) {
          msg += `\n...and ${warnings.length - 5} more warnings.`;
        }
      }
      alert(msg);
    }
  }

  // Self Initialization
  window.onload = function() {
    initTheme();
    initSharedDatabase();
    
    // Select first program if available
    if (state.programs.length > 0) {
      selectedProgramId = state.programs[0].id;
    }
    
    // Sync UI view toggle state
    setRequirementsViewMode(reqViewMode);
    switchView('dashboard');

    // Update SVG connection lines on resize
    window.addEventListener('resize', () => {
      if (currentView === 'traceability') {
        renderTraceability();
      }
    });

    // Setup invalid event redirect for tabbed test modal
    const testForm = document.getElementById('test-form');
    if (testForm) {
      testForm.addEventListener('invalid', (e) => {
        const input = e.target;
        const pane = input.closest('.modal-tab-pane');
        if (pane) {
          const tabId = pane.id.replace('tab-content-', '');
          switchModalTab(tabId);
        }
      }, true); // Use capture phase

      // Prevent Enter key from submitting the form (and triggering validation/tab switches)
      testForm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
          e.preventDefault();
        }
      });
    }

    // Dismiss program actions dropdown when clicking elsewhere
    document.addEventListener('click', (e) => {
      const dropdown = document.getElementById('program-actions-dropdown');
      const btn = document.getElementById('program-actions-btn');
      if (dropdown && btn && !btn.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });
  }

  // Onboarding Walkthrough logic
  const tourSteps = [
    {
      title: "Welcome to REQ Wrangler!",
      text: "This guided tour will walk you through the core features of the compliance manager so you can get up to speed in under 2 minutes.",
      view: "dashboard",
      target: null
    },
    {
      title: "Executive Dashboard",
      text: "The Dashboard displays program compliance statuses, total requirements, verification gaps, and average test estimates at a glance.",
      view: "dashboard",
      target: ".kpi-grid"
    },
    {
      title: "Planning Workbench",
      text: "Identify verification gaps and test backlogs directly inside the program view. Switch between the Overview Matrix and this workspace to coordinate effort.",
      view: "programs",
      target: "#tab-btn-program-planning"
    },
    {
      title: "Programs Matrix",
      text: "Review specific flight instruments. Generate printable PDF reports or export clean Markdown matrices and CSV requirement lists.",
      view: "programs",
      target: "#nav-programs"
    },
    {
      title: "Requirements Compliance",
      text: "Search, filter, and edit requirements. You can toggle compliance details in a grid card layout or table list view.",
      view: "requirements",
      target: "#nav-requirements"
    },
    {
      title: "Shared Capabilities",
      text: "Define capabilities that span multiple programs. If a capability passes, other programs can inherit this pass automatically to save test time.",
      view: "capabilities",
      target: "#nav-capabilities"
    },
    {
      title: "Tests Log & Reordering",
      text: "Log verification tests and test types. You can drag and drop tests in this table to reorder their execution priorities!",
      view: "tests",
      target: "#nav-tests"
    },
    {
      title: "Interactive Traceability Graph",
      text: "Visualize compliance paths from Capabilities to Requirements and Verification Tests. Hover over any node to highlight its path!",
      view: "traceability",
      target: "#nav-traceability"
    }
  ];

  let currentTourStep = 0;

  function startTour() {
    currentTourStep = 0;
    showTourStep(0);
  }

  function endTour() {
    document.querySelectorAll('.tour-highlight').forEach(el => {
      el.classList.remove('tour-highlight');
    });
    const overlay = document.getElementById('tour-overlay');
    if (overlay) overlay.remove();
    const tooltip = document.getElementById('tour-tooltip');
    if (tooltip) tooltip.remove();
  }

  function showTourStep(index) {
    if (index < 0 || index >= tourSteps.length) {
      endTour();
      return;
    }
    
    currentTourStep = index;
    const step = tourSteps[index];

    if (step.view) {
      switchView(step.view);
    }

    // Auto-select corresponding tabs for tour steps
    if (step.target === '#tab-btn-program-planning') {
      switchProgramTab('planning');
    } else if (step.view === 'programs') {
      switchProgramTab('overview');
    }

    setTimeout(() => {
      document.querySelectorAll('.tour-highlight').forEach(el => {
        el.classList.remove('tour-highlight');
      });

      let overlay = document.getElementById('tour-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'tour-overlay';
        document.body.appendChild(overlay);
        overlay.getBoundingClientRect();
        overlay.classList.add('active');
      }

      let tooltip = document.getElementById('tour-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'tour-tooltip';
        tooltip.className = 'tour-tooltip';
        document.body.appendChild(tooltip);
      }
      
      tooltip.classList.remove('active');

      const isLast = index === tourSteps.length - 1;
      const progressText = `Step ${index + 1} of ${tourSteps.length}`;
      
      tooltip.innerHTML = `
        <h4>${escapeHTML(step.title)}</h4>
        <p>${escapeHTML(step.text)}</p>
        <div class="tour-tooltip-footer">
          <span class="tour-tooltip-step-indicator">${progressText}</span>
          <div class="tour-tooltip-buttons">
            <button class="btn btn-secondary btn-sm" style="padding: 2px 8px; font-size: 11px;" onclick="ReqApp.endTour()">Skip</button>
            ${index > 0 ? `<button class="btn btn-secondary btn-sm" style="padding: 2px 8px; font-size: 11px;" onclick="ReqApp.showTourStep(${index - 1})">Back</button>` : ''}
            <button class="btn btn-primary btn-sm" style="padding: 2px 8px; font-size: 11px;" onclick="ReqApp.showTourStep(${index + 1})">${isLast ? 'Finish' : 'Next'}</button>
          </div>
        </div>
      `;

      let targetEl = null;
      if (step.target) {
        targetEl = document.querySelector(step.target);
      }

      if (targetEl) {
        targetEl.classList.add('tour-highlight');
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        setTimeout(() => {
          positionTooltip(targetEl, tooltip);
          tooltip.classList.add('active');
        }, 150);
      } else {
        tooltip.style.position = 'fixed';
        tooltip.style.top = '50%';
        tooltip.style.left = '50%';
        tooltip.style.transform = 'translate(-50%, -50%)';
        tooltip.style.removeProperty('bottom');
        tooltip.style.removeProperty('right');
        tooltip.classList.add('active');
      }
    }, 200);
  }

  function positionTooltip(targetEl, tooltipEl) {
    const rect = targetEl.getBoundingClientRect();
    const tooltipWidth = 320;
    const tooltipHeight = tooltipEl.offsetHeight || 150;
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    tooltipEl.style.position = 'absolute';
    tooltipEl.style.transform = 'none';

    let top = rect.bottom + window.scrollY + 12;
    let left = rect.left + window.scrollX + (rect.width - tooltipWidth) / 2;

    if (left < 15) left = 15;
    if (left + tooltipWidth > viewportWidth - 15) {
      left = viewportWidth - tooltipWidth - 15;
    }

    if (rect.bottom + tooltipHeight + 20 > viewportHeight) {
      top = rect.top + window.scrollY - tooltipHeight - 12;
      if (top < window.scrollY + 15) {
        top = rect.top + window.scrollY + (rect.height - tooltipHeight) / 2;
        if (rect.left > tooltipWidth + 20) {
          left = rect.left + window.scrollX - tooltipWidth - 12;
        } else {
          left = rect.right + window.scrollX + 12;
        }
      }
    }

    tooltipEl.style.top = `${top}px`;
    tooltipEl.style.left = `${left}px`;
  }

  // HTML5 Drag and Drop Test Priority Reordering
  let draggedTestId = null;

  function handleTestDragStart(e, testId) {
    draggedTestId = testId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', testId);
    
    const row = document.querySelector(`#test-row-${testId}`);
    if (row) {
      setTimeout(() => {
        row.classList.add('dragging');
      }, 0);
    }
  }

  function handleTestDragOver(e, targetTestId) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    if (draggedTestId === targetTestId) return;
    
    const row = document.querySelector(`#test-row-${targetTestId}`);
    if (row) {
      row.classList.add('drag-over');
    }
  }

  function handleTestDragLeave(e, targetTestId) {
    const row = document.querySelector(`#test-row-${targetTestId}`);
    if (row) {
      row.classList.remove('drag-over');
    }
  }

  function handleTestDrop(e, targetTestId) {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain') || draggedTestId;
    
    document.querySelectorAll('.custom-table tr').forEach(tr => {
      tr.classList.remove('dragging', 'drag-over');
    });

    if (!draggedId || draggedId === targetTestId) return;

    const draggedIdx = state.tests.findIndex(t => t.id === draggedId);
    const targetIdx = state.tests.findIndex(t => t.id === targetTestId);

    if (draggedIdx !== -1 && targetIdx !== -1) {
      const [removed] = state.tests.splice(draggedIdx, 1);
      state.tests.splice(targetIdx, 0, removed);
      
      syncAndRefresh();
    }
    
    draggedTestId = null;
  }

  function handleTestDragEnd(e) {
    document.querySelectorAll('.custom-table tr').forEach(tr => {
      tr.classList.remove('dragging', 'drag-over');
    });
    draggedTestId = null;
  }
;

  // Expose public controller functions
  window.ReqApp = {
    switchView,
    handleHeaderAction,
    openModal,
    closeModal,
    switchModalTab,
    switchProgramTab,
    toggleProgramDropdown,
    toggleProgramsSidebar,
    saveProgram,
    deleteProgram,
    selectProgram,
    renderPlanning,
    saveRequirement,
    deleteRequirement,
    saveCapability,
    deleteCapability,
    saveTest,
    deleteTest,
    toggleTestOutcome,
    resetData,
    exportData,
    importData,
    toggleTheme,
    setRequirementsViewMode,
    addTestType,
    deleteTestType,
    addComponentCode,
    deleteComponentCode,
    addTeamMember,
    deleteTeamMember,
    updateTestRollupPreview,
    openLinkTestModal,
    saveLinkTest,
    populateTestRequirements,
    filterTestRequirements,
    createTestForReq,
    createRequirementForCap,
    updateModalPassedDateDisplay,
    drillTo,
    printProgramReport,
    exportProgramMarkdown,
    exportProgramCSV,
    openImportRequirementsModal,
    handleExcelUpload,
    handleSheetChange,
    updateImportPreview,
    confirmImport,
    render,
    startTour,
    endTour,
    showTourStep,
    handleTestDragStart,
    handleTestDragOver,
    handleTestDragLeave,
    handleTestDrop,
    handleTestDragEnd,
    connectSharedDatabase,
    reconnectSharedDatabase,
    disconnectSharedDatabase,
    pullSharedDatabase,
    connectSharedDatabaseFromPrompt,
    skipDbSetupPrompt
  };
})();
