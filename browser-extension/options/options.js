import { getSettings, saveSettings } from '../src/settings.js';
import { formatDuration } from '../src/format.js';

const inputs = document.querySelectorAll('[data-key]');

function readInput(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number' || input.type === 'range') return Number(input.value);
  return input.value;
}

async function load() {
  const settings = await getSettings();
  const { usage } = await chrome.storage.local.get('usage');

  const orgSelect = document.getElementById('org-select');
  for (const org of usage?.orgs || []) {
    if (orgSelect.querySelector(`option[value="${CSS.escape(org.uuid)}"]`)) continue;
    const opt = document.createElement('option');
    opt.value = org.uuid;
    opt.textContent = org.name;
    orgSelect.append(opt);
  }

  for (const input of inputs) {
    const value = settings[input.dataset.key];
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value;
  }
}

for (const input of inputs) {
  input.addEventListener('change', async () => {
    const patch = { [input.dataset.key]: readInput(input) };
    const s = { ...(await getSettings()), ...patch };
    // Keep thresholds in order: first < critical <= every-percent.
    if (s.warnPct >= s.critPct || s.critPct > s.everyPctFrom) {
      input.setCustomValidity('Keep first alert < critical alert <= every-percent start');
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    await saveSettings(patch);
  });
}

for (const button of document.querySelectorAll('[data-sound]')) {
  button.addEventListener('click', async () => {
    const { volume } = await getSettings();
    chrome.runtime.sendMessage({ type: 'claude-meter:test-sound', name: button.dataset.sound, volume });
  });
}

async function renderDiagnostics() {
  const { usage, error } = await chrome.storage.local.get(['usage', 'error']);
  const status = document.getElementById('diag-status');
  const lines = [];
  if (usage) lines.push(`Last good reading ${formatDuration(Date.now() - usage.fetchedAt)} ago from "${usage.org?.name}"`);
  if (error) lines.push(`Last error (${error.kind}): ${error.message}, ${formatDuration(Date.now() - error.at)} ago`);
  if (!usage && !error) lines.push('No reading yet.');
  status.textContent = lines.join('\n');
  document.getElementById('diag-raw').textContent = usage ? JSON.stringify(usage.raw, null, 2) : '';
}

document.getElementById('diag-refresh').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'claude-meter:refresh', force: true });
  renderDiagnostics();
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') renderDiagnostics();
});

load();
renderDiagnostics();
