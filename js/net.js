window.PBNet = (function () {
  'use strict';

  const PREFIX = 'petitbac-v2-';

  function hostId(code) { return PREFIX + 'host-' + code; }
  function guestSlug(name) {
    return String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18) || 'joueur';
  }

  // ID déterministe : même code + même prénom = même identité (reconnexion possible)
  function guestId(code, name) {
    return PREFIX + 'guest-' + code + '-' + guestSlug(name);
  }

  function createHost(code, handlers) {
    const peer = new Peer(hostId(code));
    const conns = new Map();
    let opened = false;
    const api = {
      peer, code, isHost: true, conns,
      onOpen: handlers.onOpen, onError: handlers.onError,
      sendTo(id, msg) { const c = conns.get(id); if (c && c.open) c.send(msg); },
      broadcast(msg) { conns.forEach((c, id) => { if (c.open) c.send(Object.assign({ from: peer.id }, msg)); }); },
      close() { try { peer.destroy(); } catch (e) {} }
    };
    peer.on('open', id => { opened = true; if (handlers.onOpen) handlers.onOpen(id); });
    peer.on('connection', conn => {
      conn.on('open', () => {
        conns.set(conn.peer, conn);
        if (handlers.onGuestJoined) handlers.onGuestJoined(conn.peer, conn);
      });
      conn.on('data', data => { if (handlers.onData) handlers.onData(conn.peer, data); });
      conn.on('close', () => { conns.delete(conn.peer); if (handlers.onGuestLeft) handlers.onGuestLeft(conn.peer); });
      conn.on('error', () => { conns.delete(conn.peer); });
    });
    peer.on('error', err => { if (handlers.onError) handlers.onError(err); });
    return api;
  }

  function joinAsGuest(code, name, handlers) {
    const id = guestId(code, name);
    const peer = new Peer(id);
    let conn = null;
    const api = {
      peer, code, name, isHost: false,
      onOpen: handlers.onOpen, onError: handlers.onError,
      send(msg) { if (conn && conn.open) conn.send(Object.assign({ from: id }, msg)); },
      close() { try { peer.destroy(); } catch (e) {} }
    };
    peer.on('open', pid => {
      conn = peer.connect(hostId(code), { reliable: true });
      conn.on('open', () => { if (handlers.onOpen) handlers.onOpen(pid, conn); });
      conn.on('data', d => { if (handlers.onData) handlers.onData(hostId(code), d); });
      conn.on('close', () => { if (handlers.onClose) handlers.onClose(); });
      conn.on('error', () => { if (handlers.onError) handlers.onError(new Error('conn-error')); });
    });
    peer.on('error', err => {
      if (err && err.type === 'peer-unavailable' && handlers.onHostMissing) handlers.onHostMissing();
      else if (handlers.onError) handlers.onError(err);
    });
    return api;
  }

  return { createHost, joinAsGuest, hostId, guestId, guestSlug, PREFIX };
})();
