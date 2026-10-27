const { contextBridge, ipcRenderer } = require('electron');

// Интерфейс не получает Node.js, пути файлов или произвольный доступ к IPC.
contextBridge.exposeInMainWorld('reading_desktop', {
  platform: 'windows',
  get_state: () => ipcRenderer.invoke('reading:get_state'),
  start_pairing: token => ipcRenderer.invoke('reading:start_pairing', token),
  finish_pairing: () => ipcRenderer.invoke('reading:finish_pairing'),
  clear_config: () => ipcRenderer.invoke('reading:clear_config'),
  send_progress: payload => ipcRenderer.invoke('reading:send_progress', payload),
  pick_book: () => ipcRenderer.invoke('reading:pick_book'),
  on_pause: callback => {
    const listener = (_event, reason) => {
      Promise.resolve().then(callback).catch(() => {}).finally(() => {
        if (reason === 'close') ipcRenderer.send('reading:pause_done', 'close');
      });
    };
    ipcRenderer.on('reading:pause', listener);
    return () => ipcRenderer.removeListener('reading:pause', listener);
  }
});
