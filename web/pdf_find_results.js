/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { internalOpt } from "./internal_evt.js";
import { stopEvent } from "pdfjs-lib";

/** @typedef {import("./event_utils").EventBus} EventBus */
// eslint-disable-next-line max-len
/** @typedef {import("./pdf_find_controller.js").PDFFindController} PDFFindController */

/**
 * @typedef {object} PDFFindResultsOptions
 * @property {HTMLElement} container - The sidebar element.
 * @property {HTMLElement} outerContainer - The element the sidebar is docked
 *   in, i.e. `#outerContainer`.
 * @property {HTMLElement} list - The `<ul>` element the results are rendered
 *   in.
 * @property {HTMLElement} count - The element displaying the number of
 *   results.
 * @property {HTMLElement} closeButton - The button closing the sidebar.
 * @property {HTMLElement} emptyMessage - The element displayed when a search
 *   didn't yield any results.
 */

/**
 * Renders the matches found by the `PDFFindController` in a sidebar, docked on
 * the right-hand side of the viewer. Every entry shows the page and the line
 * of the match, as well as the text surrounding it, and clicking an entry
 * jumps straight to that match.
 */
class PDFFindResults {
  #container;

  #outerContainer;

  #list;

  #count;

  #closeButton;

  #emptyMessage;

  #findController;

  #frameRequest = null;

  #results = [];

  #query = "";

  opened = false;

  /**
   * @param {PDFFindResultsOptions} options
   * @param {EventBus} eventBus
   * @param {PDFFindController} findController
   */
  constructor(options, eventBus, findController) {
    this.#container = options.container;
    this.#outerContainer = options.outerContainer;
    this.#list = options.list;
    this.#count = options.count;
    this.#closeButton = options.closeButton;
    this.#emptyMessage = options.emptyMessage;
    this.#findController = findController;

    this.#closeButton.addEventListener("click", () => {
      this.close();
    });

    this.#list.addEventListener("click", evt => {
      const item = evt.target.closest(".findResult");
      if (item) {
        this.#select(item);
      }
    });
    this.#list.addEventListener("keydown", evt => {
      if (evt.key !== "Enter" && evt.key !== " ") {
        return;
      }
      const item = evt.target.closest(".findResult");
      if (item) {
        stopEvent(evt);
        this.#select(item);
      }
    });

    eventBus.on(
      "updatefindresults",
      this.#onUpdateResults.bind(this),
      internalOpt
    );
    eventBus.on("findbaropen", () => this.open(), internalOpt);
    eventBus.on("findbarclose", () => this.close(), internalOpt);
  }

  #onUpdateResults({ query, results }) {
    this.#query = query;
    this.#results = results;

    // Searching is asynchronous, hence coalesce the rendering of the results
    // to avoid updating the list more than once per frame.
    if (this.#frameRequest === null) {
      this.#frameRequest = requestAnimationFrame(() => {
        this.#frameRequest = null;
        this.#render();
      });
    }
  }

  #render() {
    const results = this.#results;
    const fragment = document.createDocumentFragment();

    for (const result of results) {
      const item = document.createElement("li");
      item.className = "findResult";
      item.dataset.pageIndex = result.pageIndex;
      item.dataset.matchIndex = result.matchIndex;
      item.tabIndex = 0;
      item.setAttribute("role", "button");

      const meta = document.createElement("div");
      meta.className = "findResultMeta";
      meta.setAttribute("data-l10n-id", "pdfjs-find-result-meta");
      meta.setAttribute(
        "data-l10n-args",
        JSON.stringify({ page: result.pageNumber, line: result.line })
      );

      const text = document.createElement("p");
      text.className = "findResultText";
      if (result.before) {
        text.append(`…${result.before}`);
      }
      const match = document.createElement("span");
      match.className = "findResultMatch";
      match.textContent = result.match;
      text.append(match);
      if (result.after) {
        text.append(`${result.after}…`);
      }

      item.append(meta, text);
      fragment.append(item);
    }
    this.#list.replaceChildren(fragment);

    if (results.length > 0) {
      this.#count.setAttribute("data-l10n-id", "pdfjs-find-results-count");
      this.#count.setAttribute(
        "data-l10n-args",
        JSON.stringify({ total: results.length })
      );
    } else {
      this.#count.removeAttribute("data-l10n-id");
      this.#count.removeAttribute("data-l10n-args");
      this.#count.textContent = "";
    }
    this.#emptyMessage.hidden = !(this.#query && results.length === 0);
  }

  #select(item) {
    const { pageIndex, matchIndex } = item.dataset;

    for (const selected of this.#list.querySelectorAll(
      ".findResult.selected"
    )) {
      selected.classList.remove("selected");
    }
    item.classList.add("selected");

    this.#findController.selectMatch(+pageIndex, +matchIndex);
  }

  /**
   * Show the sidebar containing the results of the current search.
   */
  open() {
    if (this.opened) {
      return;
    }
    this.opened = true;
    this.#container.classList.remove("hidden");
    this.#outerContainer.classList.add("findResultsOpen");
  }

  /**
   * Hide the sidebar containing the results of the current search.
   */
  close() {
    if (!this.opened) {
      return;
    }
    this.opened = false;
    this.#container.classList.add("hidden");
    this.#outerContainer.classList.remove("findResultsOpen");
  }

  /**
   * Wipe out the results, e.g. when another document is opened.
   */
  reset() {
    this.#query = "";
    this.#results = [];
    this.#render();
    this.close();
  }
}

export { PDFFindResults };
