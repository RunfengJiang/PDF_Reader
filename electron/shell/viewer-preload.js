"use strict";

// The `pdfReader` bridge, plus an interception of the viewer's own "Open File"
// input: documents selected there are opened in a new tab by the application
// (instead of replacing the document of the current tab).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

document.addEventListener(
  "change",
  event => {
    const input = event.target;
    if (input?.id !== "fileInput" || input.type !== "file") {
      return;
    }
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    let filePath = null;
    try {
      filePath = webUtils.getPathForFile(file);
    } catch {
      filePath = null;
    }
    if (!filePath) {
      return; // Fall back to the default behaviour of the viewer.
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    input.value = "";
    ipcRenderer.send("viewer:open-path", filePath);
  },
  /* capture = */ true
);

contextBridge.exposeInMainWorld("pdfReader", {
  openFilePath(filePath) {
    ipcRenderer.send("viewer:open-path", filePath);
  },
});
