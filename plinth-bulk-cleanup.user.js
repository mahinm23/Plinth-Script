// ==UserScript==
// @name         Plinth Bulk Cleanup Helper
// @version      4.1
// @match        https://app.plinth.org.uk/*
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DELETE_CONFIRM_TEXT = 'Delete everything';
  const MERGE_KEY = 'm';     // member page: open Fix Duplicates -> jump to compare screen if Plinth auto-matched
  const ARCHIVE_KEY = 'a';   // member page: open Archive -> pre-fill delete confirmation

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  function toast(message, color) {
    let el = document.getElementById('plinth-helper-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'plinth-helper-toast';
      el.style.position = 'fixed';
      el.style.top = '16px';
      el.style.left = '50%';
      el.style.transform = 'translateX(-50%)';
      el.style.zIndex = '999999';
      el.style.padding = '10px 18px';
      el.style.borderRadius = '8px';
      el.style.fontFamily = 'sans-serif';
      el.style.fontSize = '14px';
      el.style.fontWeight = '600';
      el.style.boxShadow = '0 2px 10px rgba(0,0,0,0.4)';
      document.body.appendChild(el);
    }
    el.style.background = color;
    el.style.color = '#111';
    el.textContent = message;
    el.style.opacity = '1';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 4000);
  }

  function waitFor(check, timeoutMs = 3000, intervalMs = 100) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const result = check();
        if (result) {
          clearInterval(timer);
          resolve(result);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error('Timed out waiting for element'));
        }
      }, intervalMs);
    });
  }

  // React-controlled inputs (Ant Design) ignore a plain `el.value = x` assignment -
  // React's internal value tracker doesn't see it as a real change, so the input
  // can silently snap back to empty on the next re-render. Going through the
  // native setter first makes React's change-detection see it as genuine.
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Makes Enter reliably fire the given button, instead of depending on focus
  // still being on the right (possibly re-rendered/replaced) element. Re-looks-up
  // the button fresh at Enter-press time via getBtn(), so a stale reference or a
  // button that was disabled a moment ago (e.g. until text matches) doesn't break it.
  // Also requires the button to be actually visible (offsetParent !== null) - Ant
  // Design modals often stay mounted but hidden after Cancel, so without this check
  // a stray Enter press elsewhere on the page could still fire a cancelled action.
  function armEnterToClick(getBtn) {
    const handler = (e) => {
      if (e.key !== 'Enter') return;
      const btn = getBtn();
      if (!btn || btn.disabled || btn.offsetParent === null) return;
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener('keydown', handler, true);
      btn.click();
    };
    document.addEventListener('keydown', handler, true);
    setTimeout(() => document.removeEventListener('keydown', handler, true), 15000);
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;

    if (location.pathname.startsWith('/members/')) {
      if (e.key === MERGE_KEY) {
        e.preventDefault();
        runMerge();
      } else if (e.key === ARCHIVE_KEY) {
        e.preventDefault();
        runDelete();
      }
    }
  });

  function findMoreButton() {
    return Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === 'More' && b.className.includes('ant-dropdown-trigger')
    );
  }

  function findMenuItemByText(text) {
    return Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find(
      (el) => el.textContent.trim() === text
    );
  }

  function findButtonByText(root, text) {
    return Array.from(root.querySelectorAll('button')).find((b) => b.textContent.trim() === text);
  }

  // Matches "Delete" or "Delete everything!" - Plinth's exact wording here has
  // changed between environments, so match on prefix instead of an exact string.
  function findDeleteButton(root) {
    return Array.from(root.querySelectorAll('button')).find((b) => /^delete/i.test(b.textContent.trim()));
  }

  async function openMoreMenu() {
    const btn = findMoreButton();
    if (!btn) throw new Error('More button not found');
    btn.click();
    await waitFor(() => findMenuItemByText('Archive'));
  }

  function getMemberName() {
    return document.title.trim();
  }

  // ---- shortcut: open Fix Duplicates. If Plinth already auto-matched a
  // "Possible duplicate", jump straight to the compare screen and arm Enter
  // to click the final Merge button (trusting Plinth's pre-checked field
  // defaults). Otherwise pre-fill the search with the member's name and
  // stop - picking the right match is a human call. ----
  async function runMerge() {
    try {
      await openMoreMenu();
      const fixDup = findMenuItemByText('Fix duplicates');
      if (!fixDup) throw new Error('Fix duplicates item not found');
      fixDup.click();

      const modal = await waitFor(() =>
        Array.from(document.querySelectorAll('.ant-modal')).find((m) =>
          m.textContent.includes('Find duplicate to merge')
        )
      );
      const autoMatched = /selected automatically/i.test(modal.textContent);
      const input = modal.querySelector('input[type="text"], input:not([type])');

      if (!autoMatched) {
        setNativeValue(input, getMemberName());
        input.focus();
        toast('No auto-match - review search results and pick one yourself', '#ffd27f');
        return;
      }

      const proceedBtn = findButtonByText(modal, 'Proceed to merge');
      if (!proceedBtn) throw new Error('Proceed to merge button not found');
      proceedBtn.click();

      await waitFor(() => document.body.innerText.includes('Merging two people to remove duplicates'));
      const getMergeBtn = () =>
        Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Merge');
      const mergeBtn = getMergeBtn();
      if (!mergeBtn) throw new Error('Merge button not found');
      armEnterToClick(getMergeBtn);
      toast('On compare screen - press Enter to merge', '#ffd27f');
    } catch (e) {
      toast('Could not run merge flow: ' + e.message, '#ff8f8f');
    }
  }

  // ---- shortcut: open Archive -> pre-fill delete confirmation -> arm Enter
  // to click "Delete everything!". No eligibility check here (that's a manual
  // call you make yourself before pressing the key) - this just runs the menu
  // clicks and typing for you. ----
  async function runDelete() {
    try {
      await openMoreMenu();
      const archive = findMenuItemByText('Archive');
      if (!archive) throw new Error('Archive item not found');
      archive.click();
      const dialog = await waitFor(() =>
        Array.from(document.querySelectorAll('.ant-modal')).find((m) =>
          m.textContent.includes('Delete everything')
        )
      );
      const input = dialog.querySelector('input[type="text"], input:not([type])');
      if (!input) throw new Error('Confirm text input not found in dialog');
      setNativeValue(input, DELETE_CONFIRM_TEXT);

      const getConfirmBtn = () => findDeleteButton(dialog);
      armEnterToClick(getConfirmBtn);
      toast('Confirm box filled - press Enter to delete', '#ffd27f');
    } catch (e) {
      toast('Could not run delete flow: ' + e.message, '#ff8f8f');
    }
  }
})();
