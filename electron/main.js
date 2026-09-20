"use strict";

/**
 * PDF Reader - a Windows desktop shell around the Mozilla pdf.js viewer.
 *
 * The viewer itself is served from disk through a private `pdfjs://` scheme,
 * which gives it a stable origin (so pdf.js' own same-origin check passes)
 * while keeping full access to local files without running a HTTP server.
 */

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  protocol,
  shell,
} = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const SCHEME = "pdfjs";
const HOST = "app";
const APP_NAME = "PDF Reader";

/** Directory that holds the built pdf.js viewer (`build/generic`). */
const VIEWER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "viewer")
  : path.join(__dirname, "..", "build", "generic");

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

let mainWindow = null;
let currentFile = null;
/** File requested before the window/renderer was able to receive IPC. */
let pendingFile = null;

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

function readViewerFile(requestedPath) {
  const absolute = path.resolve(VIEWER_DIR, requestedPath);
  if (
    absolute !== VIEWER_DIR &&
    !absolute.startsWith(VIEWER_DIR + path.sep)
  ) {
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

      if (pathname.startsWith("/v/")) {
        // Static viewer assets.
        const absolute = readViewerFile(
          decodeURIComponent(pathname.slice("/v/".length))
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
// Window handling
// ---------------------------------------------------------------------------

function updateTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.setTitle(
    currentFile ? `${path.basename(currentFile)} - ${APP_NAME}` : APP_NAME
  );
}

function runInViewer(code) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve(null);
  }
  return mainWindow.webContents
    .executeJavaScript(code, /* userGesture = */ true)
    .catch(error => console.error("[runInViewer]", error));
}

/** Opens a PDF in the given window (or in a new one when none exists). */
function openFile(filePath, targetWindow = mainWindow) {
  const resolved = path.resolve(filePath);
  currentFile = resolved;
  updateTitle();

  if (!targetWindow || targetWindow.isDestroyed()) {
    pendingFile = resolved;
    createWindow(resolved);
    return;
  }

  const url = buildFileUrl(resolved);
  const openCode = `(async () => {
  const waitForApp = async () => {
    for (let i = 0; i < 400; i++) {
      const viewerApp = globalThis.PDFViewerApplication;
      if (viewerApp) {
        await viewerApp.initializedPromise.catch(() => {});
        return viewerApp;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("PDFViewerApplication is not available");
  };
  (await waitForApp()).open({ url: ${JSON.stringify(url)} });
})()`;

  if (targetWindow.webContents.getURL()) {
    runInViewer(openCode);
  } else {
    targetWindow.webContents.once("did-finish-load", () => {
      runInViewer(openCode);
    });
  }

  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }
  targetWindow.focus();
}

async function openFileDialog() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "打开 PDF 文件",
    defaultPath: currentFile ? path.dirname(currentFile) : app.getPath("documents"),
    filters: [
      { name: "PDF 文档", extensions: ["pdf"] },
      { name: "所有文件", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  if (!canceled && filePaths.length > 0) {
    openFile(filePaths[0]);
  }
}

function createWindow(filePath) {
  const window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 560,
    minHeight: 420,
    show: false,
    backgroundColor: "#2f3338",
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
    },
  });

  mainWindow = window;

  window.once("ready-to-show", () => {
    window.show();
  });

  // Keep our own title instead of the one the viewer computes from the URL.
  window.on("page-title-updated", event => {
    event.preventDefault();
    updateTitle();
  });


  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (/^https?:/i.test(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  const startFile = filePath || pendingFile;
  pendingFile = null;
  if (startFile) {
    currentFile = startFile;
  }
  window.loadURL(buildViewerUrl(startFile));
  updateTitle();

  return window;
}

// ---------------------------------------------------------------------------
// Command line / file association
// ---------------------------------------------------------------------------

function getFileFromArgv(argv) {
  const candidates = argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of candidates) {
    if (arg.startsWith("--file=")) {
      return arg.slice("--file=".length);
    }
    if (arg.startsWith("-")) {
      continue;
    }
    try {
      if (fs.statSync(arg).isFile()) {
        return arg;
      }
    } catch {
      // Not a path (or not readable) - ignore.
    }
  }
  return null;
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
        { label: "打开…", accelerator: "CmdOrCtrl+O", click: () => openFileDialog() },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
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
          label: "全屏演示",
          accelerator: "F11",
          click: () => {
            if (mainWindow) {
              mainWindow.setFullScreen(!mainWindow.isFullScreen());
            }
          },
        },
        { type: "separator" },
        {
          label: "开发者工具",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => mainWindow?.webContents.toggleDevTools(),
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(APP_NAME);
  if (process.platform === "win32") {
    app.setAppUserModelId("com.local.pdfreader");
  }

  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
    const file = getFileFromArgv(argv);
    if (file) {
      openFile(file);
    } else if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow(null);
    }
  });

  // macOS: "Open with" / file association.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (mainWindow) {
      openFile(filePath);
    } else {
      pendingFile = filePath;
    }
  });

  app
    .whenReady()
    .then(() => {
      registerProtocol();
      buildMenu();

      const file = getFileFromArgv(process.argv) || pendingFile;
      pendingFile = null;
      createWindow(file);

      // Launched from the Start menu / desktop without a document:
      // offer the native open dialog right away.
      if (!file) {
        mainWindow.webContents.once("did-finish-load", () => {
          setTimeout(() => openFileDialog(), 150);
        });
      }

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow(null);
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
