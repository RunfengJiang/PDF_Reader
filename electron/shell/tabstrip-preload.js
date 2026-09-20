"use strict";

// Bridge between the tab strip and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tabStrip", {
  onUpdate(callback) {
    ipcRenderer.on("tabs:update", (_event, data) => callback(data));
  },
  select(id) {
    ipcRenderer.send("tabs:select", id);
  },
  close(id) {
    ipcRenderer.send("tabs:close", id);
  },
  newTab() {
    ipcRenderer.send("tabs:new");
  },
});
