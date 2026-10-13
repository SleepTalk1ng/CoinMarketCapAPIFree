'use strict';

const byId = id => document.getElementById(id);
const form = byId('watch-form');
const status = byId('status');
const canvas = byId('chart');
const refreshButton = byId('refresh');
let watching = null;
let snapshots = [];

const formatPrice = value => new Intl.NumberFormat('ru-RU', {
  maximumSignificantDigits: 10,
}).format(value);
const formatTime = value => value ? new Date(value).toLocaleString('ru-RU') : '—';

function message(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

function stop(silent = false) {
  if (watching) {
    clearTimeout(watching.timer);
    watching.controller?.abort();
  }
  watching = null;
  byId('stop').disabled = true;
  refreshButton.disabled = true;
  if (!silent) message('Наблюдение остановлено. Показаны последние прочитанные данные.');
}

async function api(session, suffix = '', method = 'GET') {
  const response = await fetch(`/api/v1/cryptocurrencies/${session.id}${suffix}`, {
    method, headers: { Authorization: `Bearer ${session.key}` },
    signal: session.controller.signal, cache: 'no-store', credentials: 'omit',
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = body.error?.code;
    throw error;
  }
  return body;
}

function drawChart() {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, bounds.width);
  const height = bounds.height;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.font = '12px system-ui';
  ctx.fillStyle = '#5e6978';
  if (!snapshots.length) {
    ctx.textAlign = 'center';
    ctx.fillText('Нет сохранённых снимков', width / 2, height / 2);
    return;
  }
  const points = [...snapshots].reverse();
  const left = Math.min(125, width * .3), right = width - 12, top = 16, bottom = height - 36;
  const min = Math.min(...points.map(point => point.price));
  const max = Math.max(...points.map(point => point.price));
  const padding = (max - min || Math.abs(max) * .01 || .01) * .1;
  const low = Math.max(0, min - padding), high = max + padding;
  const firstTime = Date.parse(points[0].receivedAt);
  const lastTime = Date.parse(points[points.length - 1].receivedAt);
  const x = point => firstTime === lastTime ? (left + right) / 2 :
    left + (Date.parse(point.receivedAt) - firstTime) / (lastTime - firstTime) * (right - left);
  const y = point => bottom - (point.price - low) / (high - low) * (bottom - top);
  ctx.textAlign = 'right';
  for (let tick = 0; tick < 4; tick++) {
    const lineY = top + (bottom - top) * tick / 3;
    ctx.fillText(formatPrice(high - (high - low) * tick / 3), left - 8, lineY + 4);
    ctx.strokeStyle = '#e5e9ef';
    ctx.beginPath(); ctx.moveTo(left, lineY); ctx.lineTo(right, lineY); ctx.stroke();
  }
  ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2; ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(x(point), y(point));
    else ctx.lineTo(x(point), y(point));
  });
  ctx.stroke();
  ctx.fillStyle = '#2563eb';
  points.forEach(point => {
    ctx.beginPath(); ctx.arc(x(point), y(point), 2.5, 0, Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = '#5e6978';
  ctx.textAlign = 'left'; ctx.fillText(new Date(firstTime).toLocaleTimeString('ru-RU'), left, height - 10);
  ctx.textAlign = 'right'; ctx.fillText(new Date(lastTime).toLocaleTimeString('ru-RU'), right, height - 10);
  canvas.setAttribute('aria-label', `История: ${points.length} снимков; от ${formatPrice(min)} до ${formatPrice(max)} USD.`);
}

function render(coin, price, history) {
  byId('coin-name').textContent = `${coin.name} (${coin.symbol}) · UCID ${coin.cmcId}${coin.trackingEnabled ? '' : ' · отслеживание на паузе'}`;
  byId('price').textContent = price ? formatPrice(price.price) : 'Нет снимка';
  byId('received').textContent = formatTime(price?.receivedAt);
  byId('source').textContent = formatTime(price?.sourceUpdatedAt);
  byId('checked').textContent = `Последнее чтение БД: ${new Date().toLocaleTimeString('ru-RU')}`;
  snapshots = history.items;
  byId('history-count').textContent = `На графике ${snapshots.length} последних снимков из ${history.pagination.total}. В таблице — последние 10. Время в часовом поясе браузера.`;
  const rows = byId('history-rows');
  rows.replaceChildren();
  for (const point of snapshots.slice(0, 10)) {
    const row = document.createElement('tr');
    for (const text of [formatTime(point.receivedAt), formatPrice(point.price), formatTime(point.sourceUpdatedAt)]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    rows.append(row);
  }
  drawChart();
}

async function read(session, refresh = false) {
  if (watching !== session || session.busy) return;
  session.busy = true;
  refreshButton.disabled = true;
  session.controller = new AbortController();
  const timeout = setTimeout(() => session.controller.abort(), 15000);
  try {
    let refreshError;
    if (refresh) {
      message('Получаю и сохраняю новую котировку…');
      try { await api(session, '/price/refresh', 'POST'); }
      catch (error) {
        if (error.name === 'AbortError' || error.status === 401) throw error;
        refreshError = error;
      }
    }
    const coin = await api(session);
    const [price, history] = await Promise.all([
      api(session, '/price').catch(error => {
        if (error.code === 'PRICE_NOT_FOUND') return null;
        throw error;
      }),
      api(session, '/history?limit=100&offset=0'),
    ]);
    if (watching !== session) return;
    render(coin, price, history);
    message(refreshError ? `Цена не обновлена: ${refreshError.message} Показаны сохранённые данные.` :
      `Наблюдение за UCID ${session.id}. Чтение БД каждые ${session.interval / 1000} с.`, Boolean(refreshError));
  } catch (error) {
    if (watching !== session) return;
    if (error.status === 401) {
      stop(true); message('Неверный ключ сервиса. Проверьте SERVICE_API_KEY и нажмите «Следить» снова.', true);
    } else if (error.code === 'CRYPTOCURRENCY_NOT_FOUND') {
      stop(true); message('Этот UCID не добавлен в отслеживание. Сначала добавьте монету через API.', true);
    } else {
      message(error.name === 'AbortError' ? 'Сервер не ответил за 15 секунд. Повторю чтение.' :
        `Не удалось прочитать данные: ${error.message} Повторю чтение.`, true);
    }
  } finally {
    clearTimeout(timeout);
    session.controller.abort();
    session.busy = false;
    if (watching === session) {
      refreshButton.disabled = false;
      session.timer = setTimeout(() => read(session), session.interval);
    }
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const id = byId('cmc-id').value.trim();
  const key = byId('service-key').value.trim();
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || !key) {
    message('Введите ключ сервиса и положительный безопасный UCID.', true); return;
  }
  stop(true);
  snapshots = [];
  byId('coin-name').textContent = `Загрузка UCID ${id}…`;
  byId('price').textContent = byId('received').textContent = byId('source').textContent = '—';
  byId('checked').textContent = '—'; byId('history-rows').replaceChildren();
  byId('history-count').textContent = 'Загрузка последних 100 снимков…';
  drawChart();
  const session = { id, key, interval: Number(byId('interval').value) * 1000, busy: false };
  watching = session;
  byId('stop').disabled = false;
  message('Читаю монету и её историю…');
  void read(session);
});

byId('stop').addEventListener('click', () => stop());
refreshButton.addEventListener('click', () => {
  if (!watching || watching.busy) return;
  clearTimeout(watching.timer);
  void read(watching, true);
});
byId('interval').addEventListener('change', () => {
  if (!watching) return;
  watching.interval = Number(byId('interval').value) * 1000;
  if (!watching.busy) { clearTimeout(watching.timer); void read(watching); }
});
window.addEventListener('resize', drawChart);
window.addEventListener('pagehide', () => stop(true));
drawChart();
