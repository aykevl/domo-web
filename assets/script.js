'use strict';

function setupTabs() {
  let tabs = document.querySelectorAll('#tabs > .tab');

  let tabIds = [];
  for (let i=0; i<tabs.length; i++) {
    let id = tabs[i].hash.substr(1);
    tabIds.push(id);
    document.getElementById(id).classList.add('disabled');
  }

  let currentHash = '';
  if (document.location.hash.length >= 1) {
    currentHash  = document.location.hash.substr(1);
  }
  if (tabIds.indexOf(currentHash) < 0) {
    if (localStorage.currentTab && tabIds.indexOf(localStorage.currentTab) >= 0) {
      currentHash = localStorage.currentTab;
    } else {
      currentHash = tabIds[0];
    }
    document.location.hash = '#' + currentHash;
  }

  document.getElementById('tab-' + currentHash).classList.add('enabled');
  document.getElementById(currentHash).classList.remove('disabled');

  window.addEventListener('hashchange', function() {
    // Disable old tab.
    document.getElementById(currentHash).classList.add('disabled');
    document.getElementById('tab-' + currentHash).classList.remove('enabled');

    // Get new tab.
    currentHash = document.location.hash.substr(1);

    // Enable new tab.
    document.getElementById(currentHash).classList.remove('disabled');
    document.getElementById('tab-' + currentHash).classList.add('enabled');

    // Force a resize.
    window.dispatchEvent(new Event('resize'));

    // Save this location.
    localStorage.currentTab = currentHash;
  });

  // Add an event to replace the anchor, instead of adding a new one.
  for (let i=0; i<tabs.length; i++) {
    let tab = tabs[i];
    tab.addEventListener('click', function(e) {
      // We handle this, don't let the browser handle it.
      e.preventDefault();

      // Overwrite the current state (so you can't click back to the previous
      // tab).
      history.replaceState(null, '', tab.hash);

      // This is at least necessary in Chrome.
      window.dispatchEvent(new Event('hashchange'));
    });
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', setupTabs);
} else {
  setupTabs();
}
