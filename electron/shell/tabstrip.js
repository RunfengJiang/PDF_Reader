"use strict";

const tabList = document.getElementById("tabList");
const newTabButton = document.getElementById("newTabButton");

function render({ tabs, activeId }) {
  const fragment = document.createDocumentFragment();

  for (const tab of tabs) {
    const element = document.createElement("div");
    element.className = tab.id === activeId ? "tab active" : "tab";
    element.title = tab.filePath || tab.title;

    const label = document.createElement("span");
    label.className = "tabLabel";
    label.textContent = tab.title;

    const closeButton = document.createElement("button");
    closeButton.className = "tabClose";
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.title = "关闭标签页";
    closeButton.addEventListener("click", event => {
      event.stopPropagation();
      window.tabStrip.close(tab.id);
    });

    element.addEventListener("click", () => window.tabStrip.select(tab.id));
    element.append(label, closeButton);
    fragment.append(element);
  }

  tabList.replaceChildren(fragment);
  const active = tabList.querySelector(".tab.active");
  active?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

newTabButton.addEventListener("click", () => window.tabStrip.newTab());
window.tabStrip.onUpdate(render);
