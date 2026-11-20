const countdown = document.getElementById('countdown');
const progress = document.getElementById('countdown-progress');
const status = document.getElementById('redirect-status');
const pause = document.getElementById('pause-redirect');
const continueLink = document.getElementById('continue-link');
const destination = continueLink.href;
const duration = 5000;
const startedAt = performance.now();
let remaining = 5;

continueLink.hidden = true;
document.getElementById('countdown-panel').hidden = false;

function updateCountdown() {
  const elapsed = performance.now() - startedAt;
  const seconds = Math.max(0, Math.ceil((duration - elapsed) / 1000));
  progress.value = Math.min(5, elapsed / 1000);
  if (remaining !== seconds) {
    countdown.textContent = String(seconds);
    remaining = seconds;
  }
  if (elapsed >= duration) {
    clearInterval(timer);
    status.textContent = 'Opening your destination…';
    pause.hidden = true;
    continueLink.hidden = false;
    window.location.replace(destination);
  }
}

const timer = setInterval(updateCountdown, 100);
pause.addEventListener('click', () => {
  clearInterval(timer);
  document.getElementById('countdown-label').textContent = 'NO RUSH. TAKE YOUR TIME.';
  status.textContent = 'Redirect paused. Continue whenever you’re ready.';
  pause.hidden = true;
  continueLink.hidden = false;
  continueLink.focus();
});

// Restoring a page from the back/forward cache must not restart a stale countdown.
window.addEventListener('pagehide', () => clearInterval(timer));
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    pause.hidden = true;
    continueLink.hidden = false;
    status.textContent = 'Continue whenever you’re ready.';
  }
});
