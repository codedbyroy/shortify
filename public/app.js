const $ = (id) => document.getElementById(id);
const form = $('shorten-form');
const message = $('form-message');
const submit = $('submit-button');
const list = $('link-list');
const dialog = $('delete-dialog');
let resultUrl = '';
let pendingDelete = null;
let toastTimer;
let loading = false;
let creating = false;

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function notify(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

async function copyLink(url, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = 'Copied ✓';
    notify('Link copied. Ready to share.');
    setTimeout(() => { button.textContent = original; }, 1800);
  } catch {
    notify('Copy is unavailable here. Select and copy the short link above.');
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderLinks(links, totals) {
  const nodes = [];
  for (const link of links) {
    const row = element('article', 'link-row');
    const info = element('div', 'link-info');
    const short = element('a', 'short-link', link.url.replace(/^https?:\/\//, ''));
    short.href = link.url;
    short.target = '_blank';
    short.rel = 'noopener noreferrer';
    const destination = element('p', 'link-destination', link.destination);
    destination.title = link.destination;
    const date = element('p', 'link-date', `Created ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(link.createdAt))}`);
    info.append(short, destination, date);
    const clicks = element('div', 'click-count');
    clicks.append(element('strong', '', new Intl.NumberFormat().format(link.clicks)), element('span', '', link.clicks === 1 ? 'click' : 'clicks'));
    const buttons = element('div', 'link-buttons');
    const copy = element('button', 'button copy-button', 'Copy link ⧉');
    copy.type = 'button';
    copy.setAttribute('aria-label', `Copy link ${link.code}`);
    copy.addEventListener('click', () => copyLink(link.url, copy));
    const remove = element('button', 'remove-button', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove link ${link.code}`);
    remove.addEventListener('click', () => {
      pendingDelete = link;
      $('delete-name').textContent = link.url;
      $('delete-error').textContent = '';
      dialog.showModal();
      $('cancel-delete').focus();
    });
    buttons.append(copy, remove);
    row.append(info, clicks, buttons);
    nodes.push(row);
  }
  if (!nodes.length) nodes.push(element('p', 'empty-state', 'Nothing here yet. Your first short link is one paste away.'));
  list.replaceChildren(...nodes);
  $('link-summary').textContent = `${totals.links} ${totals.links === 1 ? 'link' : 'links'} / ${totals.clicks} ${totals.clicks === 1 ? 'click' : 'clicks'}`;
}

async function loadLinks(initial = false) {
  if (loading) return;
  loading = true;
  $('refresh-button').disabled = true;
  list.setAttribute('aria-busy', 'true');
  try {
    const data = await api('/api/links');
    renderLinks(data.links, data.totals);
    submit.disabled = creating;
    if (initial) message.textContent = '';
  } catch (error) {
    if (initial) {
      list.replaceChildren(element('p', 'empty-state', 'Your links could not load. Use Refresh to try again.'));
      message.textContent = 'Could not connect. Use Refresh below to try again.';
    } else notify(error.message);
  } finally {
    loading = false;
    $('refresh-button').disabled = false;
    list.setAttribute('aria-busy', 'false');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (creating) return;
  creating = true;
  submit.disabled = true;
  submit.firstElementChild.textContent = 'Shortening…';
  message.textContent = '';
  try {
    const { link } = await api('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: $('destination').value.trim(), alias: $('alias').value.trim() }),
    });
    resultUrl = link.url;
    $('result-url').href = link.url;
    $('result-url').textContent = link.url;
    $('result').hidden = false;
    message.textContent = 'Your short link is ready.';
    form.reset();
    await loadLinks();
    $('copy-result').focus();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    creating = false;
    submit.disabled = false;
    submit.firstElementChild.textContent = 'Shorten link';
  }
});

$('copy-result').addEventListener('click', () => copyLink(resultUrl, $('copy-result')));
$('refresh-button').addEventListener('click', () => loadLinks(submit.disabled));
$('cancel-delete').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { pendingDelete = null; });
$('confirm-delete').addEventListener('click', async () => {
  if (!pendingDelete) return;
  const link = pendingDelete;
  const button = $('confirm-delete');
  button.disabled = true;
  $('delete-error').textContent = '';
  try {
    await api(`/api/links/${encodeURIComponent(link.code)}`, { method: 'DELETE' });
    dialog.close();
    if (resultUrl === link.url) { $('result').hidden = true; resultUrl = ''; message.textContent = ''; }
    notify('Link removed.');
    await loadLinks();
    $('refresh-button').focus();
  } catch (error) {
    $('delete-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
void loadLinks(true);
