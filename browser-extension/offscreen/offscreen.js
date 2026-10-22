// Plays alert sounds. Service workers can't play audio, so the background opens this page.
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type !== 'claude-meter:play') return;
  const audio = new Audio(chrome.runtime.getURL(`sounds/${msg.name}.wav`));
  audio.volume = Math.min(1, Math.max(0, Number(msg.volume) || 0.8));
  audio.play().catch(e => console.warn('Claude Meter: sound failed', e));
});
