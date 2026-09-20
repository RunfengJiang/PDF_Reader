"use strict";

/**
 * PDF Reader - a Windows desktop shell around the Mozilla pdf.js viewer.
 *
 * The app is a single window hosting one viewer instance per document, i.e.
 * every PDF is opened in its own tab. The viewer itself, the tab strip and
 * the local PDF files are all served from disk through a private `pdfjs://`
 * scheme, which gives them a stable origin (so pdf.js' own same-origin check
 * passes) without running a HTTP server.
 */

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  protocol,
  shell,
  WebContentsView,
} = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const SCHEME = "pdfjs";
const HOST = "app";
const APP_NAME = "PDF Reader";
const TAB_STRIP_HEIGHT = 38;

/** Directory that holds the built pdf.js viewer (`build/generic`). */
const VIEWER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "viewer")
  : path.join(__dirname, "..", "build", "generic");
/** Directory that holds the tab strip of the application. */
const SHELL_DIR = path.join(__dirname, "shell");

const MIME_TYPES = {
  ".bcmap": "application/octet-stream",
  ".css": "text/css",
  ".ftl": "text/plain",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".icc": "application/octet-stream",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * @typedef {object} Tab
 * @property {number} id
 * @property {WebContentsView} view
 * @property {string|null} filePath
 * @property {string} title
 */

let mainWindow = null;
let tabStripView = null;
/** @type {Tab[]} */
let tabs = [];
let activeTabId = null;
let nextTabId = 1;
/** Files requested before the application window was created. */
const pendingFiles = [];
/** Hidden, already loaded, viewer used to speed up opening a document. */
let warmView = null;
let warmViewReady = false;
let warmViewTimer = null;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

// `+` would be decoded as a space by URLSearchParams, so encode it explicitly.
function encodeParam(value) {
  return encodeURIComponent(value).replaceAll("+", "%2B");
}

/**
 * Local PDF files are exposed as:
 *   pdfjs://app/f/<file name>?p=<absolute path>
 * The real path lives in the query string, which keeps arbitrary characters
 * (backslashes, colons, `#`, `+`, ...) intact.
 */
function buildFileUrl(filePath) {
  return `${SCHEME}://${HOST}/f/${encodeParam(path.basename(filePath))}?p=${encodeParam(filePath)}`;
}

function buildViewerUrl(filePath) {
  const base = `${SCHEME}://${HOST}/v/web/viewer.html`;
  return filePath
    ? `${base}?file=${encodeParam(buildFileUrl(filePath))}`
    : `${base}?file=`;
}

function buildShellUrl() {
  return `${SCHEME}://${HOST}/s/tabstrip.html`;
}

// ---------------------------------------------------------------------------
// Private `pdfjs://` scheme
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

function resolveInDirectory(directory, requestedPath) {
  const absolute = path.resolve(directory, requestedPath);
  if (absolute !== directory && !absolute.startsWith(directory + path.sep)) {
    return null; // Path traversal attempt.
  }
  return absolute;
}

function registerProtocol() {
  protocol.handle(SCHEME, async request => {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname.startsWith("/f/")) {
        // A PDF file picked by the user.
        const filePath = url.searchParams.get("p");
        if (!filePath) {
          return new Response("Missing file path", { status: 400 });
        }
        let data;
        try {
          data = await fsp.readFile(filePath);
        } catch {
          return new Response(`Cannot read ${filePath}`, { status: 404 });
        }
        return new Response(data, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Accept-Ranges": "none",
            "Cache-Control": "no-store",
          },
        });
      }

      let directory = null;
      let prefix = "";
      if (pathname.startsWith("/v/")) {
        directory = VIEWER_DIR;
        prefix = "/v/";
      } else if (pathname.startsWith("/s/")) {
        directory = SHELL_DIR;
        prefix = "/s/";
      }
      if (directory) {
        const absolute = resolveInDirectory(
          directory,
          decodeURIComponent(pathname.slice(prefix.length))
        );
        if (!absolute) {
          return new Response("Forbidden", { status: 403 });
        }
        let data;
        try {
          data = await fsp.readFile(absolute);
        } catch {
          return new Response("Not found", { status: 404 });
        }
        const type =
          MIME_TYPES[path.extname(absolute).toLowerCase()] ||
          "application/octet-stream";
        return new Response(data, {
          status: 200,
          headers: { "Content-Type": type, "Cache-Control": "no-cache" },
        });
      }
    } catch (error) {
      console.error(`[pdfjs protocol] ${request.url}:`, error);
      return new Response(String(error), { status: 500 });
    }

    return new Response("Not found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function getActiveTab() {
  return tabs.find(tab => tab.id === activeTabId) || null;
}

function runInViewer(code) {
  const tab = getActiveTab();
  if (!tab) {
    return Promise.resolve(null);
  }
  return tab.view.webContents
    .executeJavaScript(code, /* userGesture = */ true)
    .catch(error => console.error("[runInViewer]", error));
}

function updateLayout() {
  if (!mainWindow) {
    return;
  }
  const { width, height } = mainWindow.contentView.getBounds();
  tabStripView?.setBounds({ x: 0, y: 0, width, height: TAB_STRIP_HEIGHT });

  const y = TAB_STRIP_HEIGHT;
  const docHeight = Math.max(0, height - TAB_STRIP_HEIGHT);
  for (const tab of tabs) {
    tab.view.setBounds({ x: 0, y, width, height: docHeight });
  }
  warmView?.setBounds({ x: 0, y, width, height: docHeight });
}

function updateWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const tab = getActiveTab();
  mainWindow.setTitle(
    tab?.filePath ? `${path.basename(tab.filePath)} - ${APP_NAME}` : APP_NAME
  );
}

function updateTabStrip() {
  tabStripView?.webContents.send("tabs:update", {
    activeId: activeTabId,
    tabs: tabs.map(({ id, title, filePath }) => ({ id, title, filePath })),
  });
}

function activateTab(id) {
  const tab = tabs.find(item => item.id === id);
  if (!tab || !mainWindow) {
    return;
  }
  activeTabId = id;
  for (const item of tabs) {
    item.view.setVisible?.(item.id === id);
  }
  updateLayout();
  updateWindowTitle();
  updateTabStrip();
  if (mainWindow.isVisible()) {
    tab.view.webContents.focus();
  }
}

function activateRelativeTab(offset) {
  if (tabs.length < 2) {
    return;
  }
  const index = tabs.findIndex(tab => tab.id === activeTabId);
  activateTab(tabs[(index + offset + tabs.length) % tabs.length].id);
}

/** Create a viewer instance, without a document loaded (yet). */
function createView() {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(SHELL_DIR, "viewer-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
    },
  });

  // The window title is derived from the active tab instead.
  view.webContents.on("page-title-updated", event => event.preventDefault());
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, url) => {
    if (/^https?:/i.test(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Note: the viewer's own "Open File" input is intercepted by the preload,
  // such that documents are opened in a new tab instead of replacing the
  // document of the current one.
  return view;
}

/** Debounced creation of the pre-loaded viewer, see `ensureWarmView`. */
function scheduleWarmView(delay = 400) {
  clearTimeout(warmViewTimer);
  warmViewTimer = setTimeout(ensureWarmView, delay);
}

/**
 * Keep one hidden viewer around, such that opening a document doesn't have to
 * wait for the viewer itself to be loaded.
 */
function ensureWarmView() {
  if (warmView || !mainWindow) {
    return;
  }
  const view = createView();
  warmView = view;
  warmViewReady = false;
  mainWindow.contentView.addChildView(view);
  view.setVisible(false);
  updateLayout();
  view.webContents.once("did-finish-load", () => {
    warmViewReady = true;
  });
  view.webContents.loadURL(buildViewerUrl(null));
}

/** Load a document into an already loaded viewer (fast path). */
async function openDocumentInView(tab) {
  const url = buildFileUrl(tab.filePath);
  const code = `(async () => {
  const app = globalThis.PDFViewerApplication;
  if (!app) { throw new Error("viewer is not available"); }
  await app.initializedPromise;
  await app.open({ url: ${JSON.stringify(url)} });
})()`;
  try {
    await tab.view.webContents.executeJavaScript(
      code,
      /* userGesture = */ true
    );
  } catch (error) {
    console.error("[openDocumentInView]", error);
  }
  if (!(await waitForRender(tab.view.webContents, 2500))) {
    // The document didn't show up, fall back to (re)loading the viewer.
    tab.view.webContents.loadURL(buildViewerUrl(tab.filePath));
  }
  // Only once this document is settled, prepare the next viewer: loading it
  // while a document renders would make both of them slower.
  scheduleWarmView();
}

/** Resolve to whether the given viewer actually rendered a page. */
async function waitForRender(webContents, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const state = await webContents
      .executeJavaScript(
        `(() => {
          const canvas = document.querySelector("#viewer .page canvas");
          return {
            divs: document.querySelectorAll("#viewer .page").length,
            width: canvas?.width ?? 0,
          };
        })()`
      )
      .catch(() => null);
    if (state?.divs > 0 && state.width > 0) {
      timingLog("document rendered");
      return true;
    }
    await new Promise(resolve => {
      setTimeout(resolve, 150);
    });
  }
  return false;
}

function createTab(filePath = null, { activate = true } = {}) {
  if (!mainWindow) {
    return null;
  }
  // Reuse the pre-loaded viewer, when available, to speed things up.
  const reuse = !!filePath && !!warmView && warmViewReady;
  const view = reuse ? warmView : createView();
  if (reuse) {
    warmView = null;
    warmViewReady = false;
  }

  const tab = {
    id: nextTabId++,
    view,
    filePath: filePath ? path.resolve(filePath) : null,
    title: filePath ? path.basename(filePath) : "新标签页",
  };
  tabs.push(tab);

  if (!reuse) {
    mainWindow.contentView.addChildView(view);
  }

  // Make the tab visible *before* the document is loaded: Chromium throttles
  // hidden renderers, which would make loading the document much slower.
  if (activate) {
    activateTab(tab.id);
  } else {
    updateLayout();
    updateTabStrip();
  }

  if (reuse) {
    openDocumentInView(tab);
  } else {
    view.webContents.loadURL(buildViewerUrl(tab.filePath));
    if (tab.filePath) {
      waitForRender(view.webContents, 15000).then(() => scheduleWarmView());
    } else {
      scheduleWarmView(2500);
    }
  }

  timingLog(`tab created (${tabs.length} tabs, reuse=${reuse})`);
  return tab;
}

function closeTab(id) {
  const index = tabs.findIndex(tab => tab.id === id);
  if (index === -1) {
    return;
  }
  const [tab] = tabs.splice(index, 1);
  mainWindow?.contentView.removeChildView(tab.view);
  tab.view.webContents.close();

  if (tabs.length === 0) {
    // Closing the window (and thus quitting the app) when the last tab goes.
    mainWindow?.close();
    return;
  }
  if (activeTabId === id) {
    activateTab(tabs[Math.max(0, index - 1)].id);
  } else {
    updateTabStrip();
  }
}

/** Open one document per file, in its own tab. */
function openFiles(filePaths) {
  for (const filePath of filePaths) {
    createTab(filePath);
  }
}

async function openFileDialog() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const activeTab = getActiveTab();
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "打开 PDF 文件",
    defaultPath: activeTab?.filePath
      ? path.dirname(activeTab.filePath)
      : app.getPath("documents"),
    filters: [
      { name: "PDF 文档", extensions: ["pdf"] },
      { name: "所有文件", extensions: ["*"] },
    ],
    properties: ["openFile", "multiSelections"],
  });
  if (!canceled && filePaths.length > 0) {
    openFiles(filePaths);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: "#2f3338",
    title: APP_NAME,
    webPreferences: {
      // The window itself doesn't host any content, see `createTab`.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow = window;

  tabStripView = new WebContentsView({
    webPreferences: {
      preload: path.join(SHELL_DIR, "tabstrip-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  window.contentView.addChildView(tabStripView);
  tabStripView.webContents.loadURL(buildShellUrl());

  window.on("resize", updateLayout);
  window.on("enter-full-screen", updateLayout);
  window.on("leave-full-screen", updateLayout);
  window.once("ready-to-show", () => window.show());
  // The window itself doesn't host any content (see `createTab`), hence show
  // it as soon as the tab strip is ready even when `ready-to-show` is not
  // dispatched for the (empty) page of the window.
  tabStripView.webContents.once("did-finish-load", () => window.show());
  setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) {
      window.show();
    }
  }, 1000);
  window.on("closed", () => {
    mainWindow = null;
    tabStripView = null;
    tabs = [];
    activeTabId = null;
    warmView = null;
    warmViewReady = false;
  });

  updateLayout();
  return window;
}

// ---------------------------------------------------------------------------
// Command line / file association
// ---------------------------------------------------------------------------

function getFilesFromArgv(argv) {
  const files = [];
  for (const arg of argv.slice(app.isPackaged ? 1 : 2)) {
    if (arg.startsWith("--file=")) {
      files.push(arg.slice("--file=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    try {
      if (fs.statSync(arg).isFile()) {
        files.push(arg);
      }
    } catch {
      // Not a path (or not readable) - ignore.
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function zoomScript(mode) {
  const body =
    mode === "reset"
      ? "viewer.currentScaleValue = 1;"
      : `viewer.currentScaleValue = "custom"; viewer.currentScale ${
          mode === "in" ? "*= 1.2" : "/= 1.2"
        };`;
  return `(() => {
  const viewer = globalThis.PDFViewerApplication?.pdfViewer;
  if (!viewer) { return; }
  ${body}
})()`;
}

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "新建标签页",
          accelerator: "CmdOrCtrl+T",
          click: () => createTab(null),
        },
        {
          label: "打开…",
          accelerator: "CmdOrCtrl+O",
          click: () => openFileDialog(),
        },
        {
          label: "关闭标签页",
          accelerator: "CmdOrCtrl+W",
          click: () => activeTabId !== null && closeTab(activeTabId),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "视图",
      submenu: [
        {
          label: "下一个标签页",
          accelerator: "Ctrl+Tab",
          click: () => activateRelativeTab(1),
        },
        {
          label: "上一个标签页",
          accelerator: "Ctrl+Shift+Tab",
          click: () => activateRelativeTab(-1),
        },
        { type: "separator" },
        {
          label: "重新加载",
          accelerator: "CmdOrCtrl+R",
          click: () => getActiveTab()?.view.webContents.reload(),
        },
        { type: "separator" },
        {
          label: "放大",
          accelerator: "CmdOrCtrl+=",
          click: () => runInViewer(zoomScript("in")),
        },
        {
          label: "缩小",
          accelerator: "CmdOrCtrl+-",
          click: () => runInViewer(zoomScript("out")),
        },
        {
          label: "重置缩放",
          accelerator: "CmdOrCtrl+0",
          click: () => runInViewer(zoomScript("reset")),
        },
        { type: "separator" },
        {
          label: "全屏",
          accelerator: "F11",
          click: () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()),
        },
        { type: "separator" },
        {
          label: "开发者工具",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => getActiveTab()?.view.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "关于",
              message: `${APP_NAME} ${app.getVersion()}`,
              detail: `基于 Mozilla pdf.js 的桌面 PDF 阅读器。\nElectron ${process.versions.electron} / Node ${process.versions.node}`,
              buttons: ["确定"],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function timingLog(message) {
  if (!process.env.PDF_READER_TIMING) {
    return;
  }
  try {
    fs.appendFileSync(
      path.join(app.getPath("temp"), "pdf-reader-timing.log"),
      `${Date.now()} ${message}\n`
    );
  } catch {
    // Ignore.
  }
}

if (!app.requestSingleInstanceLock()) {
  timingLog("secondary started");
  // Another instance is running, and it is opening the files; quit instead of
  // showing a window of our own.
  app.quit();
} else {
  app.setName(APP_NAME);
  if (process.platform === "win32") {
    app.setAppUserModelId("com.local.pdfreader");
  }

  app.on("second-instance", (_event, argv) => {
    const files = getFilesFromArgv(argv);
    timingLog(`second-instance files=${files.length}`);

    if (!mainWindow || mainWindow.isDestroyed()) {
      // The application is still starting up (or the window was closed), the
      // files are opened as soon as the window has been created.
      pendingFiles.push(...files);
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();

    if (files.length > 0) {
      openFiles(files);
    } else if (tabs.length === 0) {
      createTab(null);
    }
  });

  // macOS: "Open with" / file association.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (mainWindow) {
      createTab(filePath);
    } else {
      pendingFiles.push(filePath);
    }
  });

  ipcMain.on("viewer:open-path", (_event, filePath) => createTab(filePath));
  ipcMain.on("tabs:select", (_event, id) => activateTab(id));
  ipcMain.on("tabs:close", (_event, id) => closeTab(id));
  ipcMain.on("tabs:new", () => createTab(null));

  app
    .whenReady()
    .then(() => {
      registerProtocol();
      buildMenu();
      createWindow();

      const files = getFilesFromArgv(process.argv).concat(pendingFiles);
      pendingFiles.length = 0;

      if (files.length > 0) {
        openFiles(files);
      } else {
        createTab(null);
        // Launched from the Start menu / desktop without a document:
        // offer the native open dialog right away.
        setTimeout(() => openFileDialog(), 300);
      }

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow();
          createTab(null);
        }
      });
    })
    .catch(error => {
      console.error(error);
      app.quit();
    });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
